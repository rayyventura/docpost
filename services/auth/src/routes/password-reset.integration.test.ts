import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { passwordResetTokens, refreshTokens } from '../db/schema.js';
import { postJson } from '../testing/http.js';
import { startIntegrationHarness, type IntegrationHarness } from '../testing/integration.js';

type ErrorBody = { error: { code: string; message: string } };
const GENERIC = 'If an account exists for that email, a password reset link has been sent.';

describe.skipIf(!process.env.INTEGRATION)('password reset (integration)', () => {
  let h: IntegrationHarness;
  let consoleInfo: MockInstance<typeof console.info>;

  beforeAll(async () => {
    h = await startIntegrationHarness();
  });

  afterAll(async () => {
    await h?.teardown();
  });

  beforeEach(() => {
    // With SMTP_HOST unset (dev), the mailer logs the reset link to console.info.
    consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleInfo.mockRestore();
  });

  function emailedTokenFor(email: string): string {
    const line = consoleInfo.mock.calls
      .map((args) => String(args[0]))
      .filter((l) => l.includes(`Password reset for ${email}`))
      .at(-1);
    if (!line) throw new Error(`no reset email logged for ${email}`);
    const url = new URL(line.split('\n')[1]);
    expect(`${url.origin}${url.pathname}`).toBe('http://spa.test/reset-password');
    return url.searchParams.get('token')!;
  }

  async function requestReset(email: string) {
    return postJson(h.baseUrl, '/auth/password/forgot', { email });
  }

  async function reset(token: string, password: string) {
    return postJson<ErrorBody>(h.baseUrl, '/auth/password/reset', { token, password });
  }

  async function login(email: string, password: string) {
    return postJson<{ refreshToken: string }>(h.baseUrl, '/auth/login', { email, password });
  }

  async function refresh(refreshToken: string) {
    return postJson<ErrorBody>(h.baseUrl, '/auth/refresh', { refreshToken });
  }

  async function loginStatus(email: string, password: string) {
    return (await postJson(h.baseUrl, '/auth/login', { email, password })).status;
  }

  it('full flow: forgot → emailed link → reset → login with the new password only', async () => {
    const user = await h.registerUser();

    const forgot = await requestReset(user.email);
    expect(forgot).toEqual({ status: 200, body: { message: GENERIC } });
    const token = emailedTokenFor(user.email);

    const [row] = await getDb()
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, user.id));
    expect(row.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(row.usedAt).toBeNull();

    const res = await reset(token, 'a-brand-new-password');
    expect(res.status).toBe(200);

    expect(await loginStatus(user.email, 'a-brand-new-password')).toBe(200);
    expect(await loginStatus(user.email, user.password)).toBe(401);

    const [used] = await getDb()
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, user.id));
    expect(used.usedAt).toBeInstanceOf(Date);
  });

  it('rejects reuse of a consumed reset token', async () => {
    const user = await h.registerUser();
    await requestReset(user.email);
    const token = emailedTokenFor(user.email);

    expect((await reset(token, 'first-new-password')).status).toBe(200);
    const again = await reset(token, 'second-new-password');
    expect(again.status).toBe(401);
    expect(again.body.error.message).toBe('This reset link is invalid or has expired');
    expect(await loginStatus(user.email, 'first-new-password')).toBe(200);
  });

  it('invalidates the previous link when a new one is requested', async () => {
    const user = await h.registerUser();
    await requestReset(user.email);
    const first = emailedTokenFor(user.email);
    await requestReset(user.email);
    const second = emailedTokenFor(user.email);
    expect(second).not.toBe(first);

    expect((await reset(first, 'new-password-one')).status).toBe(401);
    expect((await reset(second, 'new-password-two')).status).toBe(200);
  });

  it('rejects an expired reset token', async () => {
    const user = await h.registerUser();
    await requestReset(user.email);
    const token = emailedTokenFor(user.email);
    await getDb()
      .update(passwordResetTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(passwordResetTokens.userId, user.id));

    expect((await reset(token, 'too-late-password')).status).toBe(401);
    expect(await loginStatus(user.email, user.password)).toBe(200);
  });

  it('lets only one of two concurrent resets with the same token succeed', async () => {
    const user = await h.registerUser();
    await requestReset(user.email);
    const token = emailedTokenFor(user.email);

    const results = await Promise.all([reset(token, 'concurrent-one-pw'), reset(token, 'concurrent-two-pw')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('answers an unknown email with the same generic 200 and sends nothing', async () => {
    const email = h.uniqueEmail('no-account');
    const res = await requestReset(email);
    expect(res).toEqual({ status: 200, body: { message: GENERIC } });
    expect(consoleInfo.mock.calls.some((args) => String(args[0]).includes(email))).toBe(false);
  });

  it('validates the new password length', async () => {
    const res = await reset('any-token', 'short');
    expect(res.status).toBe(422);
  });

  // Decision: a password reset signs out every existing session, so a session opened by whoever knew
  // the old password cannot keep refreshing for up to 7 days after the reset.
  it('revokes existing refresh tokens when the password is reset', async () => {
    const user = await h.registerUser();
    const other = await h.registerUser();
    const sessions = await Promise.all([login(user.email, user.password), login(user.email, user.password)]);
    const otherSession = await login(other.email, other.password);
    for (const s of [...sessions, otherSession]) expect(s.status).toBe(200);

    await requestReset(user.email);
    expect((await reset(emailedTokenFor(user.email), 'post-reset-password')).status).toBe(200);

    const rows = await getDb().select().from(refreshTokens).where(eq(refreshTokens.userId, user.id));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.revokedAt).toBeInstanceOf(Date);

    for (const s of sessions) {
      const res = await refresh(s.body.refreshToken);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    }

    // Other users' sessions are untouched, and the new password opens a fresh, refreshable session.
    expect((await refresh(otherSession.body.refreshToken)).status).toBe(200);
    const fresh = await login(user.email, 'post-reset-password');
    expect(fresh.status).toBe(200);
    expect((await refresh(fresh.body.refreshToken)).status).toBe(200);
  });
});
