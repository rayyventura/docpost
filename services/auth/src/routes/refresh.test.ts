import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { jwtVerify } from 'jose';
import { createFakeDb } from '../testing/fake-db.js';
import { listen, postJson, routerApp, type RunningServer } from '../testing/http.js';
import { getPublicKey, initKeys } from '../crypto/keys.js';

const fake = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('../db/index.js', () => ({ getDb: () => fake.current }));

const { default: refreshRouter } = await import('./refresh.js');
const { hashRefreshToken } = await import('../refresh.js');

const db = createFakeDb();
let server: RunningServer;
const user = { id: '55555555-5555-5555-5555-555555555555', email: 'r@example.com', name: 'R' };

beforeAll(async () => {
  await initKeys();
  server = await listen(await routerApp(refreshRouter));
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  db.reset();
  fake.current = db.db;
});

type ErrorBody = { error: { code: string; message: string } };
const validRecord = () => ({ id: 'rt', userId: user.id, expiresAt: new Date(Date.now() + 60_000), revokedAt: null });

describe('POST /auth/refresh', () => {
  it('rotates: returns a new pair with the documented lifetimes', async () => {
    db.queue([validRecord()], [user], [{ id: 'rt' }], undefined);

    const res = await postJson<Record<string, unknown>>(server.baseUrl, '/auth/refresh', { refreshToken: 'old' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ expiresIn: 300, refreshExpiresIn: 604800 });
    expect(res.body.refreshToken).not.toBe('old');
    const { payload } = await jwtVerify(res.body.accessToken as string, getPublicKey());
    expect(payload.sub).toBe(user.id);
    const [row] = db.argsOf('values')[0] as [{ tokenHash: string }];
    expect(row.tokenHash).toBe(hashRefreshToken(res.body.refreshToken as string));
  });

  it.each([
    ['unknown', []],
    ['revoked', [{ ...validRecord(), revokedAt: new Date() }]],
    ['expired', [{ ...validRecord(), expiresAt: new Date(Date.now() - 1000) }]],
  ])('returns 401 for an %s refresh token', async (_label, lookup) => {
    db.queue(lookup);

    const res = await postJson<ErrorBody>(server.baseUrl, '/auth/refresh', { refreshToken: 'x' });

    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({ code: 'UNAUTHORIZED', message: 'Invalid refresh token' });
  });

  it('returns 401 when a concurrent request already rotated the token', async () => {
    db.queue([validRecord()], [user], []);
    const res = await postJson(server.baseUrl, '/auth/refresh', { refreshToken: 'x' });
    expect(res.status).toBe(401);
    expect(db.argsOf('insert')).toHaveLength(0);
  });

  it.each([
    ['missing', {}],
    ['empty', { refreshToken: '' }],
    ['non-string', { refreshToken: 123 }],
  ])('returns 422 for a %s refreshToken', async (_label, body) => {
    const res = await postJson<ErrorBody>(server.baseUrl, '/auth/refresh', body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(db.calls).toHaveLength(0);
  });

  it('does not echo the presented token in error responses', async () => {
    db.queue([]);
    const res = await fetch(`${server.baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'super-secret-refresh-value' }),
    });
    expect(await res.text()).not.toContain('super-secret-refresh-value');
  });
});

describe('POST /auth/logout', () => {
  it('revokes the presented token and returns 200', async () => {
    db.queue(undefined);

    const res = await postJson(server.baseUrl, '/auth/logout', { refreshToken: 'tok' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Signed out' });
    expect(db.argsOf('update')).toHaveLength(1);
    expect(db.argsOf('set')[0][0]).toEqual({ revokedAt: expect.any(Date) });
  });

  it('returns 200 even for an unknown token (idempotent, no oracle)', async () => {
    db.queue(undefined);
    const res = await postJson(server.baseUrl, '/auth/logout', { refreshToken: 'never-issued' });
    expect(res.status).toBe(200);
  });

  it('returns 422 without a refreshToken', async () => {
    const res = await postJson<ErrorBody>(server.baseUrl, '/auth/logout', {});
    expect(res.status).toBe(422);
    expect(db.calls).toHaveLength(0);
  });
});
