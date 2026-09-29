import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { getDb } from '../db/index.js';
import { refreshTokens } from '../db/schema.js';
import { hashRefreshToken } from '../refresh.js';
import { getJson, postJson } from '../testing/http.js';
import { startIntegrationHarness, type IntegrationHarness } from '../testing/integration.js';

interface Session {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
}
type ErrorBody = { error: { code: string; message: string } };

describe.skipIf(!process.env.INTEGRATION)('login, refresh, logout and JWKS (integration)', () => {
  let h: IntegrationHarness;

  beforeAll(async () => {
    h = await startIntegrationHarness();
  });

  afterAll(async () => {
    await h?.teardown();
  });

  async function login(email: string, password: string) {
    return postJson<Session & ErrorBody>(h.baseUrl, '/auth/login', { email, password });
  }

  async function newSession() {
    const user = await h.registerUser();
    const res = await login(user.email, user.password);
    expect(res.status).toBe(200);
    return { user, session: res.body as Session };
  }

  async function activeTokensFor(userId: string) {
    return getDb()
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }

  async function insertRefreshToken(userId: string, values: { expiresAt: Date; revokedAt?: Date | null }) {
    const token = randomBytes(32).toString('base64url');
    await getDb()
      .insert(refreshTokens)
      .values({ userId, tokenHash: hashRefreshToken(token), ...values });
    return token;
  }

  describe('POST /auth/login', () => {
    it('returns accessToken + refreshToken with expiresIn 300 and refreshExpiresIn 604800', async () => {
      const user = await h.registerUser();
      const res = await login(user.email, user.password);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        expiresIn: 300,
        refreshExpiresIn: 604800,
      });

      const [row] = await activeTokensFor(user.id);
      expect(row.tokenHash).toBe(hashRefreshToken(res.body.refreshToken));
      const ttlSeconds = (row.expiresAt.getTime() - row.createdAt.getTime()) / 1000;
      expect(Math.abs(ttlSeconds - 604800)).toBeLessThan(5);
    });

    it('returns 401 for a wrong password', async () => {
      const user = await h.registerUser();
      const res = await login(user.email, 'definitely-wrong');
      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe('Invalid credentials');
      expect(await activeTokensFor(user.id)).toHaveLength(0);
    });

    it('returns an identical 401 for an unknown user', async () => {
      const res = await login(h.uniqueEmail('unknown'), 'whatever-password');
      expect(res.status).toBe(401);
      expect(res.body.error).toEqual({ code: 'UNAUTHORIZED', message: 'Invalid credentials' });
    });
  });

  describe('JWKS', () => {
    it('publishes an RS256 key set that verifies issued access tokens', async () => {
      const jwksRes = await getJson<{ keys: Array<Record<string, string>> }>(h.baseUrl, '/.well-known/jwks.json');
      expect(jwksRes.status).toBe(200);
      expect(jwksRes.body.keys).toHaveLength(1);
      const [key] = jwksRes.body.keys;
      expect(key).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig', e: 'AQAB' });
      expect(key.kid).toEqual(expect.any(String));
      expect(key).not.toHaveProperty('d');

      const { user, session } = await newSession();
      expect(decodeProtectedHeader(session.accessToken).kid).toBe(key.kid);

      const jwks = createRemoteJWKSet(new URL(`${h.baseUrl}/.well-known/jwks.json`));
      const { payload } = await jwtVerify(session.accessToken, jwks, {
        issuer: 'docpost-auth',
        algorithms: ['RS256'],
      });
      expect(payload).toMatchObject({ sub: user.id, email: user.email, name: user.name });
      expect(payload.exp! - payload.iat!).toBe(300);
    });

    it('advertises the JWKS URI via openid-configuration', async () => {
      const res = await getJson<{ issuer: string; jwks_uri: string }>(h.baseUrl, '/.well-known/openid-configuration');
      expect(res.status).toBe(200);
      expect(res.body.issuer).toBe('docpost-auth');
      expect(res.body.jwks_uri).toMatch(/\/\.well-known\/jwks\.json$/);
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates: issues a new pair, revokes the old token, and the old token is then rejected', async () => {
      const { user, session } = await newSession();

      const rotated = await postJson<Session>(h.baseUrl, '/auth/refresh', { refreshToken: session.refreshToken });
      expect(rotated.status).toBe(200);
      expect(rotated.body).toMatchObject({ expiresIn: 300, refreshExpiresIn: 604800 });
      expect(rotated.body.refreshToken).not.toBe(session.refreshToken);
      const { payload } = await jwtVerify(
        rotated.body.accessToken,
        createRemoteJWKSet(new URL(`${h.baseUrl}/.well-known/jwks.json`)),
      );
      expect(payload.sub).toBe(user.id);

      const [old] = await getDb()
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashRefreshToken(session.refreshToken)));
      expect(old.revokedAt).toBeInstanceOf(Date);
      const active = await activeTokensFor(user.id);
      expect(active.map((r) => r.tokenHash)).toEqual([hashRefreshToken(rotated.body.refreshToken)]);

      const replay = await postJson<ErrorBody>(h.baseUrl, '/auth/refresh', { refreshToken: session.refreshToken });
      expect(replay.status).toBe(401);
      expect(replay.body.error.message).toBe('Invalid refresh token');

      const next = await postJson<Session>(h.baseUrl, '/auth/refresh', { refreshToken: rotated.body.refreshToken });
      expect(next.status).toBe(200);
    });

    it('rejects an expired refresh token with 401', async () => {
      const user = await h.registerUser();
      const token = await insertRefreshToken(user.id, { expiresAt: new Date(Date.now() - 1000) });
      const res = await postJson(h.baseUrl, '/auth/refresh', { refreshToken: token });
      expect(res.status).toBe(401);
      expect(await activeTokensFor(user.id)).toHaveLength(1); // untouched, nothing new issued
    });

    it('rejects a revoked refresh token with 401', async () => {
      const user = await h.registerUser();
      const token = await insertRefreshToken(user.id, {
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(),
      });
      const res = await postJson(h.baseUrl, '/auth/refresh', { refreshToken: token });
      expect(res.status).toBe(401);
      expect(await activeTokensFor(user.id)).toHaveLength(0);
    });

    it('rejects a token that was never issued', async () => {
      const res = await postJson(h.baseUrl, '/auth/refresh', { refreshToken: randomBytes(32).toString('base64url') });
      expect(res.status).toBe(401);
    });

    it('lets exactly one of several concurrent refreshes with the same token win', async () => {
      const { user, session } = await newSession();

      const attempts = await Promise.all(
        Array.from({ length: 8 }, () =>
          postJson<Session>(h.baseUrl, '/auth/refresh', { refreshToken: session.refreshToken }),
        ),
      );

      const winners = attempts.filter((a) => a.status === 200);
      expect(winners).toHaveLength(1);
      expect(attempts.filter((a) => a.status !== 200).every((a) => a.status === 401)).toBe(true);

      const active = await activeTokensFor(user.id);
      expect(active.map((r) => r.tokenHash)).toEqual([hashRefreshToken(winners[0].body.refreshToken)]);
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the refresh token so a later refresh returns 401', async () => {
      const { user, session } = await newSession();

      const res = await postJson(h.baseUrl, '/auth/logout', { refreshToken: session.refreshToken });
      expect(res.status).toBe(200);
      expect(await activeTokensFor(user.id)).toHaveLength(0);

      const refresh = await postJson(h.baseUrl, '/auth/refresh', { refreshToken: session.refreshToken });
      expect(refresh.status).toBe(401);
    });

    it('only revokes the presented session, not the user’s other sessions', async () => {
      const { user, session } = await newSession();
      const second = await login(user.email, user.password);

      await postJson(h.baseUrl, '/auth/logout', { refreshToken: session.refreshToken });

      const stillValid = await postJson(h.baseUrl, '/auth/refresh', { refreshToken: second.body.refreshToken });
      expect(stillValid.status).toBe(200);
    });

    it('is idempotent', async () => {
      const { session } = await newSession();
      expect((await postJson(h.baseUrl, '/auth/logout', { refreshToken: session.refreshToken })).status).toBe(200);
      expect((await postJson(h.baseUrl, '/auth/logout', { refreshToken: session.refreshToken })).status).toBe(200);
    });
  });
});
