/**
 * Integration harness: real Postgres (docker compose) + LocalStack, the Express app
 * in-process on an ephemeral port, and a node:http stub standing in for both the auth
 * service (JWKS + service tokens) and the platform service.
 *
 * Call startHarness() from a beforeAll inside describe.skipIf(!process.env.INTEGRATION):
 * it sets the env the app reads at import time and only then imports the app.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, decodeJwt, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { inArray } from 'drizzle-orm';
import { listen, type TestServer } from './http.js';

export const LOCALSTACK = process.env.LOCALSTACK_ENDPOINT ?? 'http://localhost:4566';
export const BUCKET = 'docpost-staging-local';

export interface StubTeam {
  id: string;
  name: string;
  members: Set<string>;
  docPostEnabled: boolean;
}

export interface StubRequest {
  method: string;
  path: string;
  authorization: string | undefined;
}

/** Return true when the override handled (or deliberately stalled) the request. */
export type Override = (req: http.IncomingMessage, res: http.ServerResponse) => boolean;

export interface Harness {
  baseUrl: string;
  platformUrl: string;
  teams: Map<string, StubTeam>;
  /** Folder ids the stub platform reports as not being folder destinations (422). */
  nonFolderIds: Set<string>;
  requests: StubRequest[];
  setOverride: (override: Override | undefined) => void;
  addTeam: (members: string[], opts?: { name?: string; docPostEnabled?: boolean }) => StubTeam;
  signUserToken: (sub: string, claims?: Record<string, unknown>) => Promise<string>;
  signServiceToken: () => Promise<string>;
  db: ReturnType<typeof import('../db/index.js').getDb>;
  schema: typeof import('../db/schema.js');
  s3: S3Client;
  trackJob: (jobId: string) => void;
  trackS3Key: (key: string) => void;
  api: (method: string, path: string, opts?: { token?: string; body?: unknown }) => Promise<ApiResponse>;
  close: () => Promise<void>;
}

export interface ApiResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

const KID = 'integration-test-key';

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

function bearerSub(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return undefined;
  try {
    return decodeJwt(header.slice(7)).sub;
  } catch {
    return undefined;
  }
}

export async function startHarness(): Promise<Harness> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' }] };

  const sign = (claims: Record<string, unknown>, sub: string, key: CryptoKey = privateKey) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer('docpost-auth')
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(key);

  const teams = new Map<string, StubTeam>();
  const nonFolderIds = new Set<string>();
  const requests: StubRequest[] = [];
  let override: Override | undefined;

  const platform = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, authorization: req.headers.authorization });
      if (override?.(req, res)) return;

      const route = `${req.method} ${url.pathname}`;
      const sub = bearerSub(req);
      const memberTeams = () => [...teams.values()].filter((t) => sub && t.members.has(sub));
      let m: RegExpMatchArray | null;

      if (route === 'GET /.well-known/jwks.json') return sendJson(res, 200, jwks);
      if (route === 'POST /auth/token') {
        await readBody(req);
        return sendJson(res, 200, {
          accessToken: await sign({ token_use: 'service', scope: 'memberships:read' }, 'delivery-worker'),
          expiresIn: 900,
        });
      }
      if (route === 'GET /teams') {
        const onlyEnabled = url.searchParams.get('docPostEnabled') === 'true';
        return sendJson(
          res,
          200,
          memberTeams()
            .filter((t) => !onlyEnabled || t.docPostEnabled)
            .map((t) => ({ id: t.id, name: t.name, region: 'us-east-1' })),
        );
      }
      if ((m = route.match(/^GET \/teams\/([^/]+)\/members$/))) {
        const team = teams.get(m[1]);
        return team ? sendJson(res, 200, { userIds: [...team.members] }) : sendJson(res, 404, {});
      }
      if ((m = route.match(/^GET \/internal\/teams\/([^/]+)$/))) {
        const team = teams.get(m[1]);
        return team ? sendJson(res, 200, { name: team.name }) : sendJson(res, 404, {});
      }
      if (route === 'POST /internal/assert-folder-destinations') {
        const body = (await readBody(req)) as { destinations: Array<{ folderId: string }> };
        if (body.destinations.some((d) => nonFolderIds.has(d.folderId))) {
          return sendJson(res, 422, { error: { code: 'VALIDATION_ERROR', message: 'Documents can only be sent to a folder, not a binder' } });
        }
        return sendJson(res, 200, { ok: true });
      }
      if (route === 'POST /internal/destination-paths') {
        const body = (await readBody(req)) as { destinations: Array<{ teamId: string; binderId: string; folderId: string | null }> };
        return sendJson(res, 200, {
          destinations: body.destinations.map((d) => ({
            ...d,
            path: `${teams.get(d.teamId)?.name ?? d.teamId} / binder / folder`,
            teamName: teams.get(d.teamId)?.name,
            binderName: 'binder',
            folderPath: d.folderId ? [{ id: d.folderId, name: 'folder' }] : [],
          })),
        });
      }
      // Browse endpoints proxied by /destinations: echo what we received.
      if (/^GET \/(teams\/[^/]+\/binders|binders\/[^/]+\/contents|folders\/[^/]+\/contents|documents\/[^/]+\/download)$/.test(route)) {
        return sendJson(res, 200, { proxied: url.pathname + url.search, sub: sub ?? null });
      }
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `stub has no route ${route}` } });
    })().catch((err: unknown) => {
      sendJson(res, 500, { error: String(err) });
    });
  });
  await new Promise<void>((resolve) => platform.listen(0, '127.0.0.1', resolve));
  const platformUrl = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;

  // Everything the service reads from env at import time must be set before importing it.
  Object.assign(process.env, {
    PLATFORM_URL: platformUrl,
    AUTH_JWKS_URL: `${platformUrl}/.well-known/jwks.json`,
    AUTH_TOKEN_URL: `${platformUrl}/auth/token`,
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://docpost_service:docpost_local@localhost:5432/docpost_api',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    S3_BUCKET: BUCKET,
    S3_ENDPOINT: LOCALSTACK,
    SQS_ENDPOINT: LOCALSTACK,
    JOB_QUEUE_URL: `${LOCALSTACK}/000000000000/docpost-jobs`,
  });

  const { createApp } = await import('../app.js');
  const { getDb, closeDb } = await import('../db/index.js');
  const schema = await import('../db/schema.js');
  const app: TestServer = await listen(createApp());
  const db = getDb();

  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: LOCALSTACK,
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  const jobIds = new Set<string>();
  const s3Keys = new Set<string>();

  return {
    baseUrl: app.baseUrl,
    platformUrl,
    teams,
    nonFolderIds,
    requests,
    setOverride: (next) => {
      override = next;
    },
    addTeam: (members, opts = {}) => {
      const id = crypto.randomUUID();
      const team = { id, name: opts.name ?? `Team ${id.slice(0, 8)}`, members: new Set(members), docPostEnabled: opts.docPostEnabled ?? true };
      teams.set(id, team);
      return team;
    },
    signUserToken: (sub, claims = {}) => sign({ email: `${sub}@example.com`, name: `User ${sub.slice(0, 8)}`, ...claims }, sub),
    signServiceToken: () => sign({ token_use: 'service', scope: 'memberships:read' }, 'delivery-worker'),
    db,
    schema,
    s3,
    trackJob: (jobId) => jobIds.add(jobId),
    trackS3Key: (key) => s3Keys.add(key),
    api: async (method, path, opts = {}) => {
      const headers: Record<string, string> = {};
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(`${app.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        // non-JSON body
      }
      return { status: res.status, body };
    },
    close: async () => {
      // Only rows this suite created, children first. Never truncate.
      const ids = [...jobIds];
      if (ids.length > 0) {
        await db.delete(schema.tasks).where(inArray(schema.tasks.jobId, ids));
        await db.delete(schema.files).where(inArray(schema.files.jobId, ids));
        await db.delete(schema.jobs).where(inArray(schema.jobs.id, ids));
      }
      for (const key of s3Keys) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => undefined);
      }
      s3.destroy();
      await closeDb();
      await app.close();
      platform.closeAllConnections();
      await new Promise<void>((resolve) => platform.close(() => resolve()));
    },
  };
}

/** Submit-ready file descriptor with a real SHA-256 (base64, as S3 expects). */
export async function fileFor(name: string, bytes: Buffer, contentType = 'application/pdf') {
  const sha256 = createHash('sha256').update(bytes).digest('base64');
  return { name, sizeBytes: bytes.length, contentType, sha256 };
}
