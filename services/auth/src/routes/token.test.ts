import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { createFakeDb } from '../testing/fake-db.js';
import { listen, postJson, routerApp, type RunningServer } from '../testing/http.js';
import { getJwks, initKeys } from '../crypto/keys.js';

const fake = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('../db/index.js', () => ({ getDb: () => fake.current }));

const { default: tokenRouter } = await import('./token.js');

const db = createFakeDb();
let server: RunningServer;
const secret = 'worker-secret';
const client = {
  id: 'c1',
  clientId: 'delivery-worker',
  clientSecretHash: bcrypt.hashSync(secret, 4),
  scopes: ['documents:ingest', 'memberships:read'],
  createdAt: new Date(),
};

beforeAll(async () => {
  await initKeys();
  server = await listen(await routerApp(tokenRouter));
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  db.reset();
  fake.current = db.db;
});

type ErrorBody = { error: { code: string; message: string } };

async function verify(token: string) {
  return jwtVerify(token, createLocalJWKSet(await getJwks()), { issuer: 'docpost-auth', algorithms: ['RS256'] });
}

describe('POST /auth/token', () => {
  it('issues a 900s service token for a valid client and allowed scope', async () => {
    db.queue([client]);

    const res = await postJson<{ accessToken: string; expiresIn: number }>(server.baseUrl, '/auth/token', {
      clientId: client.clientId,
      clientSecret: secret,
      scope: 'documents:ingest',
    });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'expiresIn']);
    expect(res.body.expiresIn).toBe(900);
    const { payload } = await verify(res.body.accessToken);
    expect(payload).toMatchObject({ sub: 'delivery-worker', scope: 'documents:ingest', token_use: 'service' });
  });

  it('grants exactly the requested subset, normalising extra whitespace', async () => {
    db.queue([client]);

    const res = await postJson<{ accessToken: string }>(server.baseUrl, '/auth/token', {
      clientId: client.clientId,
      clientSecret: secret,
      scope: '  memberships:read   documents:ingest ',
    });

    expect(res.status).toBe(200);
    const { payload } = await verify(res.body.accessToken);
    expect(payload.scope).toBe('memberships:read documents:ingest');
  });

  it('returns 403 naming the scopes the client is not allowed', async () => {
    db.queue([client]);

    const res = await postJson<ErrorBody>(server.baseUrl, '/auth/token', {
      clientId: client.clientId,
      clientSecret: secret,
      scope: 'documents:ingest memberships:write admin',
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({
      code: 'FORBIDDEN',
      message: 'Requested scopes not allowed: memberships:write, admin',
    });
  });

  it('returns 401 for a bad secret', async () => {
    db.queue([client]);
    const res = await postJson<ErrorBody>(server.baseUrl, '/auth/token', {
      clientId: client.clientId,
      clientSecret: 'wrong',
      scope: 'documents:ingest',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({ code: 'UNAUTHORIZED', message: 'Invalid client credentials' });
  });

  it('returns the same 401 for an unknown client, still running bcrypt', async () => {
    db.queue([]);
    const compare = vi.spyOn(bcrypt, 'compare');
    const res = await postJson<ErrorBody>(server.baseUrl, '/auth/token', {
      clientId: 'ghost',
      clientSecret: secret,
      scope: 'documents:ingest',
    });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid client credentials');
    expect(compare).toHaveBeenCalledTimes(1);
    compare.mockRestore();
  });

  it('checks credentials before scopes (bad secret + bad scope is 401, not 403)', async () => {
    db.queue([client]);
    const res = await postJson(server.baseUrl, '/auth/token', {
      clientId: client.clientId,
      clientSecret: 'wrong',
      scope: 'admin',
    });
    expect(res.status).toBe(401);
  });

  // BUG: `scope` is required, but a whitespace-only value passes `z.string().min(1)` and then
  // splits to zero scopes, so the client gets a valid service JWT with `scope: ""` instead of a 422.
  it.fails('rejects a whitespace-only scope with 422', async () => {
    db.queue([client]);
    const res = await postJson(server.baseUrl, '/auth/token', {
      clientId: client.clientId,
      clientSecret: secret,
      scope: '   ',
    });
    expect(res.status).toBe(422);
  });

  it.each([
    ['clientId', { clientSecret: secret, scope: 'documents:ingest' }],
    ['clientSecret', { clientId: client.clientId, scope: 'documents:ingest' }],
    ['scope', { clientId: client.clientId, clientSecret: secret }],
  ])('returns 422 when %s is missing', async (_field, body) => {
    const res = await postJson<ErrorBody>(server.baseUrl, '/auth/token', body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(db.calls).toHaveLength(0);
  });
});
