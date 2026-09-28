/**
 * Integration-test harness for the platform service.
 *
 * Points the service at local docker compose Postgres and LocalStack S3, serves a
 * throwaway RS256 JWKS on an ephemeral port, and starts the Express app in-process
 * on port 0. The service modules read S3 and JWKS configuration at import time, so
 * the app is imported dynamically only after the environment has been set.
 *
 * Only rows and objects created through this harness are cleaned up. Nothing is
 * truncated or dropped.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { CryptoKey, JWK } from 'jose';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { closeDb, getDb } from '../db/index.js';
import { binders, documents, folders, teamMembers, teams } from '../db/schema.js';

export const LOCAL_DATABASE_URL =
  'postgresql://platform_service:platform_local@localhost:5432/docpost_platform';
export const LOCAL_S3_ENDPOINT = 'http://localhost:4566';
export const BUCKET = 'docpost-staging-local';

export interface Harness {
  baseUrl: string;
  s3: S3Client;
  userToken(sub: string, overrides?: Record<string, unknown>): Promise<string>;
  serviceToken(scope: string, overrides?: Record<string, unknown>): Promise<string>;
  /** Sign with a key that is not in the JWKS. */
  foreignToken(sub: string): Promise<string>;
  request(path: string, init?: RequestInit & { token?: string; json?: unknown }): Promise<Response>;
  fixtures: Fixtures;
  close(): Promise<void>;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/**
 * Advisory-lock key that serialises deleting fixture teams against tests that write
 * to *every* team (POST /internal/users/:userId/memberships). Test files run in
 * parallel against one database, so without it such a test can read another file's
 * team, that file can clear the team's memberships, and the grant can then insert a
 * fresh membership just before the team row is deleted (FK 23503 in cleanup), or
 * the team can vanish between the grant's read and its insert (FK 23503 in the route).
 */
const TEAM_DELETION_LOCK = 0x64706974; // arbitrary, test-only

/**
 * Run `fn` while no harness can delete its teams. Use it around calls that touch
 * teams created by other, concurrently running test files.
 */
export async function withTeamDeletionBlocked<T>(fn: () => Promise<T>): Promise<T> {
  let result: T;
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${TEAM_DELETION_LOCK})`);
    result = await fn();
  });
  return result!;
}

export function uid(): string {
  return crypto.randomUUID();
}

export function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Tracks everything a test file creates so it can be removed afterwards. */
export class Fixtures {
  readonly teamIds: string[] = [];
  readonly binderIds: string[] = [];
  readonly folderIds: string[] = [];
  readonly documentIds: string[] = [];
  readonly memberships: Array<{ teamId: string; userId: string }> = [];
  readonly memberUserIds: string[] = [];
  readonly objectKeys: string[] = [];

  constructor(private readonly s3: S3Client) {}

  async team(opts: { name?: string; docpostEnabled?: boolean; region?: string } = {}): Promise<string> {
    const [row] = await getDb()
      .insert(teams)
      .values({
        name: opts.name ?? `it-team-${uid()}`,
        region: opts.region ?? 'us-east-1',
        docpostEnabled: opts.docpostEnabled ?? true,
      })
      .returning({ id: teams.id });
    this.teamIds.push(row.id);
    return row.id;
  }

  async member(teamId: string, userId: string): Promise<void> {
    await getDb().insert(teamMembers).values({ teamId, userId });
    this.memberships.push({ teamId, userId });
  }

  /** Remember a user whose memberships were created by the service itself. */
  trackMemberUser(userId: string): void {
    this.memberUserIds.push(userId);
  }

  async binder(teamId: string, name = `it-binder-${uid()}`): Promise<string> {
    const [row] = await getDb().insert(binders).values({ teamId, name }).returning({ id: binders.id });
    this.binderIds.push(row.id);
    return row.id;
  }

  async folder(binderId: string, parentFolderId: string | null = null, name = `it-folder-${uid()}`): Promise<string> {
    const [row] = await getDb()
      .insert(folders)
      .values({ binderId, parentFolderId, name })
      .returning({ id: folders.id });
    this.folderIds.push(row.id);
    return row.id;
  }

  async document(opts: {
    binderId: string;
    folderId?: string | null;
    name?: string;
    sizeBytes?: number;
    contentType?: string;
    uploadedByUserId?: string;
  }): Promise<string> {
    const [row] = await getDb()
      .insert(documents)
      .values({
        binderId: opts.binderId,
        folderId: opts.folderId ?? null,
        name: opts.name ?? `it-doc-${uid()}.pdf`,
        sizeBytes: BigInt(opts.sizeBytes ?? 1),
        contentType: opts.contentType ?? 'application/pdf',
        checksumSha256: 'a'.repeat(64),
        uploadedByUserId: opts.uploadedByUserId ?? uid(),
      })
      .returning({ id: documents.id });
    this.documentIds.push(row.id);
    return row.id;
  }

  /** Track a document row the service created (e.g. via POST /documents). */
  trackDocument(documentId: string): void {
    if (!this.documentIds.includes(documentId)) this.documentIds.push(documentId);
    const key = `documents/${documentId}`;
    if (!this.objectKeys.includes(key)) this.objectKeys.push(key);
  }

  async stageObject(bytes: Buffer, key = `uploads/it-${uid()}/staged file.pdf`): Promise<string> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: bytes,
        ContentType: 'application/pdf',
        ChecksumAlgorithm: 'SHA256',
      }),
    );
    this.objectKeys.push(key);
    return key;
  }

  async getObject(key: string): Promise<{ bytes: Buffer; contentType?: string }> {
    const out = await this.s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const bytes = Buffer.from(await out.Body!.transformToByteArray());
    return { bytes, contentType: out.ContentType };
  }

  /**
   * Remove everything this file created. Every delete is scoped to entities this
   * instance created (or rows referencing them), and each parent is deleted only
   * after all of its FK children, including rows another test or the service added:
   *   documents -> folders (binder_id, parent_folder_id), binders
   *   folders   -> binders
   *   binders, team_members -> teams
   */
  async cleanup(): Promise<void> {
    const db = getDb();
    for (const key of this.objectKeys) {
      await this.s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => undefined);
    }

    // Binders in our teams may have been created by the service rather than a fixture.
    const binderIds = new Set(this.binderIds);
    if (this.teamIds.length) {
      const rows = await db.select({ id: binders.id }).from(binders).where(inArray(binders.teamId, this.teamIds));
      for (const row of rows) binderIds.add(row.id);
    }
    const folderIds = new Set(this.folderIds);
    if (binderIds.size) {
      const rows = await db
        .select({ id: folders.id })
        .from(folders)
        .where(inArray(folders.binderId, [...binderIds]));
      for (const row of rows) folderIds.add(row.id);
    }

    const documentFilters = [];
    if (this.documentIds.length) documentFilters.push(inArray(documents.id, this.documentIds));
    if (binderIds.size) documentFilters.push(inArray(documents.binderId, [...binderIds]));
    if (folderIds.size) documentFilters.push(inArray(documents.folderId, [...folderIds]));
    if (documentFilters.length) {
      await db.delete(documents).where(or(...documentFilters));
    }
    // One statement, so parent/child folders need no ordering: the self-referencing
    // FK is checked once the whole statement has run.
    if (folderIds.size) {
      await db.delete(folders).where(inArray(folders.id, [...folderIds]));
    }
    if (binderIds.size) {
      await db.delete(binders).where(inArray(binders.id, [...binderIds]));
    }

    for (const { teamId, userId } of this.memberships) {
      await db
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    }
    if (this.memberUserIds.length) {
      await db.delete(teamMembers).where(inArray(teamMembers.userId, this.memberUserIds));
    }
    if (this.teamIds.length) {
      const teamIds = this.teamIds;
      // Clear every membership of our teams (other files add some, e.g. the
      // every-team grant) and delete the teams atomically, while no every-team
      // writer is mid-flight (see TEAM_DELETION_LOCK).
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${TEAM_DELETION_LOCK})`);
        await tx.delete(teamMembers).where(inArray(teamMembers.teamId, teamIds));
        await tx.delete(teams).where(inArray(teams.id, teamIds));
      });
    }
  }
}

export async function startHarness(): Promise<Harness> {
  // Pin every dependency to local infrastructure regardless of the caller's shell.
  process.env.DATABASE_URL = process.env.INTEGRATION_DATABASE_URL ?? LOCAL_DATABASE_URL;
  process.env.S3_ENDPOINT = process.env.INTEGRATION_S3_ENDPOINT ?? LOCAL_S3_ENDPOINT;
  process.env.S3_BUCKET = BUCKET;
  process.env.AWS_REGION = 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;

  const kid = `it-${uid()}`;
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const foreign = await generateKeyPair('RS256');
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };

  const jwksServer = http.createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  const jwksPort = await listen(jwksServer);
  process.env.AUTH_JWKS_URL = `http://127.0.0.1:${jwksPort}/.well-known/jwks.json`;

  const { createApp } = await import('../app.js');
  const appServer = http.createServer(createApp());
  const appPort = await listen(appServer);
  const baseUrl = `http://127.0.0.1:${appPort}`;

  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  async function sign(claims: Record<string, unknown>, sub: string, key: CryptoKey, keyId: string) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: keyId })
      .setIssuer('docpost-auth')
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
  }

  const fixtures = new Fixtures(s3);

  return {
    baseUrl,
    s3,
    fixtures,
    userToken: (sub, overrides = {}) =>
      sign({ email: `${sub}@example.test`, token_use: 'user', ...overrides }, sub, privateKey, kid),
    serviceToken: (scope, overrides = {}) =>
      sign({ scope, token_use: 'service', ...overrides }, 'delivery-worker', privateKey, kid),
    foreignToken: (sub) => sign({ token_use: 'user' }, sub, foreign.privateKey, kid),
    request: (path, init = {}) => {
      const { token, json, headers, ...rest } = init;
      const h = new Headers(headers);
      if (token) h.set('authorization', `Bearer ${token}`);
      if (json !== undefined) h.set('content-type', 'application/json');
      return fetch(`${baseUrl}${path}`, {
        ...rest,
        headers: h,
        body: json !== undefined ? JSON.stringify(json) : rest.body,
      });
    },
    close: async () => {
      try {
        await fixtures.cleanup();
      } finally {
        await closeServer(appServer);
        await closeServer(jwksServer);
        s3.destroy();
        await closeDb();
      }
    },
  };
}
