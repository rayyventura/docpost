import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { postJson } from '../testing/http.js';
import { startIntegrationHarness, type IntegrationHarness } from '../testing/integration.js';

type ErrorBody = { error: { code: string; message: string } };

describe.skipIf(!process.env.INTEGRATION)('POST /auth/token (integration)', () => {
  let h: IntegrationHarness;
  let client: { clientId: string; clientSecret: string };

  beforeAll(async () => {
    h = await startIntegrationHarness();
    client = await h.createServiceClient(['documents:ingest', 'memberships:read']);
  });

  afterAll(async () => {
    await h?.teardown();
  });

  it('issues a scoped service JWT that verifies against the JWKS', async () => {
    const res = await postJson<{ accessToken: string; expiresIn: number }>(h.baseUrl, '/auth/token', {
      ...client,
      scope: 'documents:ingest memberships:read',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accessToken: expect.any(String), expiresIn: 900 });
    const { payload } = await jwtVerify(
      res.body.accessToken,
      createRemoteJWKSet(new URL(`${h.baseUrl}/.well-known/jwks.json`)),
      { issuer: 'docpost-auth', algorithms: ['RS256'] },
    );
    expect(payload).toMatchObject({
      sub: client.clientId,
      scope: 'documents:ingest memberships:read',
      token_use: 'service',
    });
    expect(payload.exp! - payload.iat!).toBe(900);
  });

  it('narrows the token to the requested subset of allowed scopes', async () => {
    const res = await postJson<{ accessToken: string }>(h.baseUrl, '/auth/token', {
      ...client,
      scope: 'memberships:read',
    });
    expect(res.status).toBe(200);
    const { payload } = await jwtVerify(
      res.body.accessToken,
      createRemoteJWKSet(new URL(`${h.baseUrl}/.well-known/jwks.json`)),
    );
    expect(payload.scope).toBe('memberships:read');
  });

  it('returns 403 for a scope the client is not allowed', async () => {
    const res = await postJson<ErrorBody>(h.baseUrl, '/auth/token', {
      ...client,
      scope: 'documents:ingest memberships:write',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Requested scopes not allowed: memberships:write');
  });

  it('returns 401 for a bad secret', async () => {
    const res = await postJson<ErrorBody>(h.baseUrl, '/auth/token', {
      clientId: client.clientId,
      clientSecret: 'wrong-secret',
      scope: 'documents:ingest',
    });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid client credentials');
  });

  it('returns 401 for an unknown client', async () => {
    const res = await postJson<ErrorBody>(h.baseUrl, '/auth/token', {
      clientId: `it-auth-missing-${Date.now()}`,
      clientSecret: client.clientSecret,
      scope: 'documents:ingest',
    });
    expect(res.status).toBe(401);
  });

  it('does not issue refresh tokens to service clients', async () => {
    const res = await postJson(h.baseUrl, '/auth/token', { ...client, scope: 'documents:ingest' });
    expect(res.body).not.toHaveProperty('refreshToken');
  });
});
