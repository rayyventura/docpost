import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { listen, getJson, routerApp, type RunningServer } from '../testing/http.js';
import { getKid, initKeys } from '../crypto/keys.js';
import jwksRouter from './jwks.js';

let server: RunningServer;

beforeAll(async () => {
  await initKeys();
  server = await listen(await routerApp(jwksRouter));
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /.well-known/jwks.json', () => {
  it('returns the public signing key', async () => {
    const res = await getJson<{ keys: Array<Record<string, string>> }>(server.baseUrl, '/.well-known/jwks.json');
    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(1);
    expect(res.body.keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig', kid: getKid(), e: 'AQAB' });
    expect(res.body.keys[0]).not.toHaveProperty('d');
  });
});

describe('GET /.well-known/openid-configuration', () => {
  it('advertises the issuer and a JWKS URI from AUTH_BASE_URL', async () => {
    vi.stubEnv('AUTH_BASE_URL', 'https://auth.example.com');
    const res = await getJson(server.baseUrl, '/.well-known/openid-configuration');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      issuer: 'docpost-auth',
      jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
    });
  });

  it('defaults the JWKS URI to localhost and PORT', async () => {
    vi.stubEnv('AUTH_BASE_URL', undefined);
    vi.stubEnv('PORT', '4999');
    const res = await getJson(server.baseUrl, '/.well-known/openid-configuration');
    expect(res.body.jwks_uri).toBe('http://localhost:4999/.well-known/jwks.json');
  });
});
