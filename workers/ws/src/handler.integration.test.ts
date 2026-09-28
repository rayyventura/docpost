import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResult } from 'aws-lambda';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_URL, json, pgPool, stubServer, type StubServer } from './test-utils/integration.js';

describe.skipIf(!process.env.INTEGRATION)('ws lifecycle handlers (integration: Postgres + real JWT verification)', () => {
  let pool: pg.Pool;
  let auth: StubServer;
  let platform: StubServer;
  let privateKey: CryptoKey;
  let otherKey: CryptoKey;
  let handler: (event: unknown) => Promise<APIGatewayProxyResult>;
  let closeDb: () => Promise<void>;

  const teams = new Map<string, string[]>();
  const created = { jobs: [] as string[], connections: [] as string[] };

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    otherKey = (await generateKeyPair('RS256')).privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'it-key', alg: 'RS256', use: 'sig' };

    auth = await stubServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') return json(res, 200, { keys: [jwk] });
      if (req.url === '/auth/token') {
        void new SignJWT({ scope: 'memberships:read', token_use: 'service' })
          .setProtectedHeader({ alg: 'RS256', kid: 'it-key' })
          .setSubject('ws-worker')
          .setIssuer('docpost-auth')
          .setExpirationTime('15m')
          .sign(privateKey)
          .then((accessToken) => json(res, 200, { accessToken, expiresIn: 900 }));
        return;
      }
      json(res, 404, {});
    });
    platform = await stubServer((req, res) => {
      const match = /^\/internal\/users\/([^/]+)\/teams$/.exec(req.url);
      if (!match) return json(res, 404, {});
      if (!req.headers.authorization?.startsWith('Bearer ')) return json(res, 401, {});
      json(res, 200, { teamIds: teams.get(match[1]) ?? [] });
    });

    // session.ts reads its configuration at import time.
    process.env.DATABASE_URL = DATABASE_URL;
    delete process.env.DATABASE_SECRET_ARN;
    process.env.AUTH_JWKS_URL = `${auth.url}/.well-known/jwks.json`;
    process.env.AUTH_TOKEN_URL = `${auth.url}/auth/token`;
    process.env.PLATFORM_URL = platform.url;

    const mod = await import('./handler.js');
    handler = (event) => mod.handler(event, {} as never, () => {}) as Promise<APIGatewayProxyResult>;
    ({ closeDb } = await import('./db.js'));
    pool = pgPool();
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM ws_connections WHERE connection_id = ANY($1)', [created.connections]);
      await pool.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [created.jobs]);
      await pool.end();
    }
    await closeDb?.();
    await Promise.all([auth?.close(), platform?.close()]);
  });

  function userToken(sub: string, opts: { key?: CryptoKey; issuer?: string; exp?: string | number; claims?: object } = {}) {
    return new SignJWT({ email: `${sub.slice(0, 8)}@example.com`, ...opts.claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'it-key' })
      .setSubject(sub)
      .setIssuer(opts.issuer ?? 'docpost-auth')
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '15m')
      .sign(opts.key ?? privateKey);
  }

  function newConnectionId() {
    const id = `it-ws-${randomUUID()}`;
    created.connections.push(id);
    return id;
  }

  async function createJob(ownerId: string) {
    const jobId = randomUUID();
    created.jobs.push(jobId);
    await pool.query('INSERT INTO jobs (id, submitted_by_user_id, task_count) VALUES ($1, $2, 1)', [jobId, ownerId]);
    return jobId;
  }

  const connect = (connectionId: string, token?: string) =>
    handler({ requestContext: { routeKey: '$connect', connectionId }, queryStringParameters: token ? { token } : null });
  const subscribe = (connectionId: string, jobId: string) =>
    handler({ requestContext: { routeKey: 'subscribe', connectionId }, body: JSON.stringify({ action: 'subscribe', jobId }) });
  const connectionRow = async (id: string) =>
    (await pool.query('SELECT * FROM ws_connections WHERE connection_id = $1', [id])).rows[0];

  it('accepts a valid user token and stores the connection', async () => {
    const userId = randomUUID();
    const id = newConnectionId();

    await expect(connect(id, await userToken(userId))).resolves.toEqual({ statusCode: 200, body: 'connected' });

    const row = await connectionRow(id);
    expect(row.user_id).toBe(userId);
    expect(row.job_id).toBeNull();
  });

  it.each([
    ['no token', async () => undefined],
    ['garbage', async () => 'not-a-jwt'],
    ['expired', async () => userToken(randomUUID(), { exp: Math.floor(Date.now() / 1000) - 60 })],
    ['wrong issuer', async () => userToken(randomUUID(), { issuer: 'someone-else' })],
    ['signed by an unknown key', async () => userToken(randomUUID(), { key: otherKey })],
    ['service token', async () => userToken('delivery-worker', { claims: { token_use: 'service' } })],
  ])('rejects %s with 401 and stores nothing', async (_label, token) => {
    const id = newConnectionId();
    await expect(connect(id, await token())).resolves.toEqual({ statusCode: 401, body: 'unauthorized' });
    expect(await connectionRow(id)).toBeUndefined();
  });

  it('owner subscribe registers the job on the connection; reconnecting resets it', async () => {
    const owner = randomUUID();
    const jobId = await createJob(owner);
    const id = newConnectionId();
    await connect(id, await userToken(owner));

    await expect(subscribe(id, jobId)).resolves.toEqual({
      statusCode: 200,
      body: JSON.stringify({ type: 'subscribed', jobId }),
    });
    expect((await connectionRow(id)).job_id).toBe(jobId);

    await connect(id, await userToken(owner));
    expect((await connectionRow(id)).job_id).toBeNull();
  });

  it('a teammate of the submitter may subscribe; an outsider gets 404 and stays unsubscribed', async () => {
    const owner = randomUUID();
    const teammate = randomUUID();
    const outsider = randomUUID();
    teams.set(owner, ['team-1', 'team-2']);
    teams.set(teammate, ['team-2']);
    teams.set(outsider, ['team-9']);
    const jobId = await createJob(owner);

    const mate = newConnectionId();
    await connect(mate, await userToken(teammate));
    await expect(subscribe(mate, jobId)).resolves.toMatchObject({ statusCode: 200 });
    expect((await connectionRow(mate)).job_id).toBe(jobId);

    const stranger = newConnectionId();
    await connect(stranger, await userToken(outsider));
    await expect(subscribe(stranger, jobId)).resolves.toEqual({ statusCode: 404, body: 'Job not found' });
    expect((await connectionRow(stranger)).job_id).toBeNull();

    // Membership lookups went out with a service token.
    expect(platform.requests.every((r) => r.headers.authorization?.startsWith('Bearer '))).toBe(true);
  });

  it('subscribe to an unknown job is 404, and from an unknown connection is 401', async () => {
    const user = randomUUID();
    const id = newConnectionId();
    await connect(id, await userToken(user));
    await expect(subscribe(id, randomUUID())).resolves.toMatchObject({ statusCode: 404 });
    await expect(subscribe(`it-ws-missing-${randomUUID()}`, await createJob(user))).resolves.toMatchObject({
      statusCode: 401,
    });
  });

  it('$disconnect removes the connection row', async () => {
    const id = newConnectionId();
    await connect(id, await userToken(randomUUID()));
    expect(await connectionRow(id)).toBeDefined();

    await expect(handler({ requestContext: { routeKey: '$disconnect', connectionId: id } })).resolves.toEqual({
      statusCode: 200,
      body: 'disconnected',
    });
    expect(await connectionRow(id)).toBeUndefined();
  });
});
