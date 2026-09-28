import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { jwtVerify } from 'jose';
import { createFakeDb } from '../testing/fake-db.js';
import { listen, postJson, routerApp, type RunningServer } from '../testing/http.js';
import { getPublicKey, initKeys } from '../crypto/keys.js';

const fake = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('../db/index.js', () => ({ getDb: () => fake.current }));

const { default: registerRouter } = await import('./register.js');

const PLATFORM_URL = 'http://platform.test';
const realFetch = globalThis.fetch;
const platformFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const db = createFakeDb();
let server: RunningServer;

beforeAll(async () => {
  await initKeys();
  server = await listen(await routerApp(registerRouter));
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  db.reset();
  fake.current = db.db;
  vi.stubEnv('PLATFORM_URL', `${PLATFORM_URL}/`);
  platformFetch.mockReset();
  platformFetch.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    return url.startsWith(PLATFORM_URL) ? platformFetch(url, init) : realFetch(input, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const valid = { email: 'new@example.com', password: 'password123', name: 'New User' };
const created = { id: '33333333-3333-3333-3333-333333333333', email: valid.email, name: valid.name };

describe('POST /auth/register', () => {
  it.each([
    ['missing body', {}, undefined],
    ['bad email', { ...valid, email: 'not-an-email' }, 'Invalid email format'],
    ['short password', { ...valid, password: 'short' }, 'Password must be at least 8 characters'],
    ['empty name', { ...valid, name: '' }, 'Name is required'],
    ['missing name', { email: valid.email, password: valid.password }, undefined],
  ])('rejects %s with 422', async (_label, body, message) => {
    const res = await postJson<{ error: { code: string; message: string } }>(server.baseUrl, '/auth/register', body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    if (message) expect(res.body.error.message).toBe(message);
    expect(db.calls).toHaveLength(0);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it('creates the user with a bcrypt hash, assigns teams, and returns 201 {id, email, name}', async () => {
    db.queue([], [created]);

    const res = await postJson(server.baseUrl, '/auth/register', valid);

    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);

    const [inserted] = db.argsOf('values')[0] as [{ email: string; name: string; passwordHash: string }];
    expect(inserted.email).toBe(valid.email);
    expect(inserted.name).toBe(valid.name);
    expect(inserted.passwordHash).not.toBe(valid.password);
    expect(await bcrypt.compare(valid.password, inserted.passwordHash)).toBe(true);
    expect(bcrypt.getRounds(inserted.passwordHash)).toBe(12);
  });

  it('calls the platform membership endpoint with a memberships:write service token', async () => {
    db.queue([], [created]);

    await postJson(server.baseUrl, '/auth/register', valid);

    expect(platformFetch).toHaveBeenCalledTimes(1);
    const [url, init] = platformFetch.mock.calls[0];
    expect(url).toBe(`${PLATFORM_URL}/internal/users/${created.id}/memberships`);
    expect(init?.method).toBe('POST');
    const auth = (init?.headers as Record<string, string>).Authorization;
    expect(auth).toMatch(/^Bearer /);
    const { payload } = await jwtVerify(auth.slice('Bearer '.length), getPublicKey(), { issuer: 'docpost-auth' });
    expect(payload).toMatchObject({ sub: 'auth-service', scope: 'memberships:write', token_use: 'service' });
  });

  it('returns 409 for an existing email without inserting', async () => {
    db.queue([{ id: created.id }]);

    const res = await postJson<{ error: { code: string; message: string } }>(server.baseUrl, '/auth/register', valid);

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: 'CONFLICT', message: 'Registration failed' });
    expect(db.argsOf('insert')).toHaveLength(0);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it('returns the same 409 when the insert loses a race on users.email (unique violation 23505)', async () => {
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint "users_email_unique"'), {
      code: '23505',
      constraint: 'users_email_unique',
    });
    // Drizzle wraps driver errors, keeping the pg error as `cause`.
    db.queue([], Object.assign(new Error('Failed query: insert into "users"'), { cause: pgError }));

    const res = await postJson<{ error: { code: string; message: string } }>(server.baseUrl, '/auth/register', valid);

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: 'CONFLICT', message: 'Registration failed' });
    expect(platformFetch).not.toHaveBeenCalled();
    expect(db.argsOf('delete')).toHaveLength(0);
  });

  it('still returns 500 for a unique violation on some other constraint', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db.queue([], Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'users_pkey' }));

    const res = await postJson<{ error: { code: string } }>(server.baseUrl, '/auth/register', valid);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('rolls back the new user and returns 500 when team assignment fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    platformFetch.mockResolvedValue(new Response('boom', { status: 503 }));
    db.queue([], [created], undefined);

    const res = await postJson<{ error: { code: string } }>(server.baseUrl, '/auth/register', valid);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(db.argsOf('delete')).toHaveLength(1);
  });

  it('rolls back the new user when the platform is unreachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    platformFetch.mockRejectedValue(new TypeError('fetch failed'));
    db.queue([], [created], undefined);

    const res = await postJson(server.baseUrl, '/auth/register', valid);

    expect(res.status).toBe(500);
    expect(db.argsOf('delete')).toHaveLength(1);
  });
});
