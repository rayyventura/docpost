import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createFakeDb } from '../testing/fake-db.js';
import { listen, postJson, routerApp, type RunningServer } from '../testing/http.js';

const fake = vi.hoisted(() => ({ current: undefined as unknown }));
const mailer = vi.hoisted(() => ({ sendPasswordResetEmail: vi.fn() }));
vi.mock('../db/index.js', () => ({ getDb: () => fake.current }));
vi.mock('../email/mailer.js', () => mailer);

const { default: passwordResetRouter } = await import('./password-reset.js');

const db = createFakeDb();
let server: RunningServer;
const user = { id: '66666666-6666-6666-6666-666666666666', email: 'reset@example.com' };
const GENERIC = 'If an account exists for that email, a password reset link has been sent.';

beforeAll(async () => {
  server = await listen(await routerApp(passwordResetRouter));
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  db.reset();
  fake.current = db.db;
  mailer.sendPasswordResetEmail.mockReset();
  mailer.sendPasswordResetEmail.mockResolvedValue(undefined);
  vi.stubEnv('APP_BASE_URL', 'https://app.example.com/');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type ErrorBody = { error: { code: string; message: string } };
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describe('POST /auth/password/forgot', () => {
  it('replaces any previous token, stores only a hash, and emails a reset link', async () => {
    db.queue([user], undefined, undefined);
    const before = Date.now();

    const res = await postJson(server.baseUrl, '/auth/password/forgot', { email: user.email });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: GENERIC });
    expect(db.argsOf('transaction')).toHaveLength(1);
    expect(db.argsOf('delete')).toHaveLength(1);

    expect(mailer.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    const [{ to, resetUrl }] = mailer.sendPasswordResetEmail.mock.calls[0];
    expect(to).toBe(user.email);
    const url = new URL(resetUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://app.example.com/reset-password');
    const token = url.searchParams.get('token')!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [row] = db.argsOf('values')[0] as [{ userId: string; tokenHash: string; expiresAt: Date }];
    expect(row.userId).toBe(user.id);
    expect(row.tokenHash).toBe(sha256(token));
    const ttl = row.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(ttl).toBeLessThan(60 * 60 * 1000 + 5000);
  });

  it('returns the same generic 200 for an unknown email and sends nothing', async () => {
    db.queue([]);

    const res = await postJson(server.baseUrl, '/auth/password/forgot', { email: 'ghost@example.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: GENERIC });
    expect(mailer.sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(db.argsOf('insert')).toHaveLength(0);
  });

  it('deletes the new token and returns 500 when the email cannot be sent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mailer.sendPasswordResetEmail.mockRejectedValue(new Error('smtp down'));
    db.queue([user], undefined, undefined, undefined);

    const res = await postJson<ErrorBody>(server.baseUrl, '/auth/password/forgot', { email: user.email });

    expect(res.status).toBe(500);
    expect(db.argsOf('delete')).toHaveLength(2);
  });

  it('falls back to the local SPA URL outside production', async () => {
    vi.stubEnv('APP_BASE_URL', '');
    db.queue([user], undefined, undefined);

    await postJson(server.baseUrl, '/auth/password/forgot', { email: user.email });

    expect(mailer.sendPasswordResetEmail.mock.calls[0][0].resetUrl).toMatch(
      /^http:\/\/localhost:5173\/reset-password\?token=/,
    );
  });

  it('refuses to build a link in production without APP_BASE_URL', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('APP_BASE_URL', '');
    vi.stubEnv('NODE_ENV', 'production');
    db.queue([user], undefined, undefined);

    const res = await postJson(server.baseUrl, '/auth/password/forgot', { email: user.email });

    expect(res.status).toBe(500);
    expect(mailer.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('returns 422 for an invalid email', async () => {
    const res = await postJson<ErrorBody>(server.baseUrl, '/auth/password/forgot', { email: 'nope' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Invalid email format');
    expect(db.calls).toHaveLength(0);
  });
});

describe('POST /auth/password/reset', () => {
  it('consumes the token and stores a bcrypt hash of the new password', async () => {
    db.queue([{ id: 'prt', userId: user.id }], [{ userId: user.id }], undefined);

    const res = await postJson(server.baseUrl, '/auth/password/reset', {
      token: 'reset-token',
      password: 'brand-new-password',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Password has been reset. You can sign in with your new password.' });
    const sets = db.argsOf('set').map((a) => a[0] as Record<string, unknown>);
    expect(sets[0]).toEqual({ usedAt: expect.any(Date) });
    const { passwordHash } = sets[1] as { passwordHash: string };
    expect(await bcrypt.compare('brand-new-password', passwordHash)).toBe(true);
    // Every active refresh token is revoked inside the same transaction.
    expect(sets[2]).toEqual({ revokedAt: expect.any(Date) });
    expect(db.argsOf('update')).toHaveLength(3);
    expect(db.argsOf('transaction')).toHaveLength(1);
  });

  it('returns 401 for an unknown, used or expired token', async () => {
    db.queue([]);
    const res = await postJson<ErrorBody>(server.baseUrl, '/auth/password/reset', {
      token: 'bad',
      password: 'brand-new-password',
    });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('This reset link is invalid or has expired');
    expect(db.argsOf('update')).toHaveLength(0);
  });

  it('returns 401 and does not change the password if the token was consumed concurrently', async () => {
    db.queue([{ id: 'prt', userId: user.id }], []);
    const res = await postJson(server.baseUrl, '/auth/password/reset', {
      token: 'raced',
      password: 'brand-new-password',
    });
    expect(res.status).toBe(401);
    expect(db.argsOf('update')).toHaveLength(1);
  });

  it.each([
    ['short password', { token: 't', password: 'short' }, 'Password must be at least 8 characters'],
    ['empty token', { token: '', password: 'long-enough' }, 'Reset token is required'],
  ])('returns 422 for %s', async (_label, body, message) => {
    const res = await postJson<ErrorBody>(server.baseUrl, '/auth/password/reset', body);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe(message);
    expect(db.calls).toHaveLength(0);
  });
});
