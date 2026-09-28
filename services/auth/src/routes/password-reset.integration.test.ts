import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { passwordResetTokens } from '../db/schema.js';
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

  // Not specified by the blueprint, but worth a decision: resetting a password does not revoke the
  // user's existing refresh tokens, so a session opened by whoever knew the old password keeps
  // refreshing for up to 7 days after the reset.
  it.todo('revokes existing refresh tokens when the password is reset');
});
