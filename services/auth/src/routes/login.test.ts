import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { jwtVerify } from 'jose';
import { createFakeDb } from '../testing/fake-db.js';
import { listen, postJson, routerApp, type RunningServer } from '../testing/http.js';
import { getPublicKey, initKeys } from '../crypto/keys.js';

const fake = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('../db/index.js', () => ({ getDb: () => fake.current }));

const { default: loginRouter } = await import('./login.js');
const { hashRefreshToken } = await import('../refresh.js');

const db = createFakeDb();
let server: RunningServer;
const password = 'correct-horse';
const user = {
  id: '44444444-4444-4444-4444-444444444444',
  email: 'login@example.com',
  name: 'Login User',
  passwordHash: bcrypt.hashSync(password, 4),
};

beforeAll(async () => {
  await initKeys();
  server = await listen(await routerApp(loginRouter));
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  db.reset();
  fake.current = db.db;
});

type ErrorBody = { error: { code: string; message: string } };

describe('POST /auth/login', () => {
  it('returns accessToken, refreshToken, expiresIn 300 and refreshExpiresIn 604800', async () => {
    db.queue([user], undefined);

    const res = await postJson<Record<string, unknown>>(server.baseUrl, '/auth/login', {
      email: user.email,
      password,
    });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'expiresIn', 'refreshExpiresIn', 'refreshToken']);
    expect(res.body.expiresIn).toBe(300);
    expect(res.body.refreshExpiresIn).toBe(604800);

    const { payload } = await jwtVerify(res.body.accessToken as string, getPublicKey(), { issuer: 'docpost-auth' });
    expect(payload).toMatchObject({ sub: user.id, email: user.email, name: user.name });
    expect(payload).not.toHaveProperty('passwordHash');

    const [row] = db.argsOf('values')[0] as [{ userId: string; tokenHash: string }];
    expect(row).toMatchObject({ userId: user.id, tokenHash: hashRefreshToken(res.body.refreshToken as string) });
  });

  it('returns 401 for a wrong password and issues no refresh token', async () => {
    db.queue([user]);

    const res = await postJson<ErrorBody>(server.baseUrl, '/auth/login', { email: user.email, password: 'wrong-pass' });

    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({ code: 'UNAUTHORIZED', message: 'Invalid credentials' });
    expect(db.argsOf('insert')).toHaveLength(0);
  });

  it('returns the same 401 for an unknown user (no account enumeration)', async () => {
    db.queue([]);
    const compare = vi.spyOn(bcrypt, 'compare');

    const res = await postJson<ErrorBody>(server.baseUrl, '/auth/login', {
      email: 'nobody@example.com',
      password,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({ code: 'UNAUTHORIZED', message: 'Invalid credentials' });
    // Still runs a bcrypt comparison against the dummy hash to keep timing uniform.
    expect(compare).toHaveBeenCalledTimes(1);
    compare.mockRestore();
  });

  it.each([
    ['bad email', { email: 'nope', password }, 'Invalid email format'],
    ['missing password', { email: user.email }, undefined],
    ['empty password', { email: user.email, password: '' }, 'Password is required'],
  ])('rejects %s with 422', async (_label, body, message) => {
    const res = await postJson<ErrorBody>(server.baseUrl, '/auth/login', body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    if (message) expect(res.body.error.message).toBe(message);
    expect(db.calls).toHaveLength(0);
  });

  it('returns 500 without leaking details when the database fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.queue(new Error('connection refused: postgres://secret'));

    const res = await postJson<ErrorBody>(server.baseUrl, '/auth/login', { email: user.email, password });

    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    consoleError.mockRestore();
  });
});
