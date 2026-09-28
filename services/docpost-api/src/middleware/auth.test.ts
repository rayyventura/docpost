import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey, JWTPayload } from 'jose';
import { errorHandler } from '@docpost/shared';
import { httpRequest, listen, type TestServer } from '../test-utils/http.js';

// Resolve keys from an in-memory JWKS instead of the auth service.
const keys = vi.hoisted(() => ({
  resolver: undefined as undefined | ((...args: unknown[]) => unknown),
  remoteUrls: [] as string[],
}));

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: (url: URL) => {
      keys.remoteUrls.push(url.toString());
      return (...args: unknown[]) => keys.resolver!(...args);
    },
  };
});

const { requireUserAuth } = await import('./auth.js');

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let server: TestServer;

async function sign(
  claims: JWTPayload & Record<string, unknown>,
  opts: { key?: CryptoKey; issuer?: string; expiresIn?: string; alg?: string } = {},
): Promise<string> {
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(opts.issuer ?? 'docpost-auth')
    .setExpirationTime(opts.expiresIn ?? '5m');
  if (claims.sub) jwt = jwt.setSubject(claims.sub);
  return jwt.sign(opts.key ?? privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherPrivateKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  keys.resolver = createLocalJWKSet({ keys: [jwk] }) as (...args: unknown[]) => unknown;

  const app = express();
  app.get('/protected', requireUserAuth, (req, res) => {
    res.json({ user: req.user });
  });
  app.use(errorHandler);
  server = await listen(app);
});

afterAll(async () => {
  await server?.close();
});

describe('requireUserAuth', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await httpRequest(server.baseUrl, 'GET', '/protected');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a non-Bearer Authorization header', async () => {
    const res = await httpRequest(server.baseUrl, 'GET', '/protected', {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed token', async () => {
    const res = await httpRequest(server.baseUrl, 'GET', '/protected', { token: 'not-a-jwt' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid or expired token');
  });

  it('rejects a token signed by an unknown key', async () => {
    const token = await sign({ sub: crypto.randomUUID() }, { key: otherPrivateKey });
    const res = await httpRequest(server.baseUrl, 'GET', '/protected', { token });
    expect(res.status).toBe(401);
  });

  it('rejects a token from a different issuer', async () => {
    const token = await sign({ sub: crypto.randomUUID() }, { issuer: 'someone-else' });
    const res = await httpRequest(server.baseUrl, 'GET', '/protected', { token });
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const token = await sign({ sub: crypto.randomUUID() }, { expiresIn: '-1m' });
    const res = await httpRequest(server.baseUrl, 'GET', '/protected', { token });
    expect(res.status).toBe(401);
  });

  it('rejects a token without a subject', async () => {
    const token = await sign({ email: 'nobody@example.com' });
    const res = await httpRequest(server.baseUrl, 'GET', '/protected', { token });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Token missing subject');
  });

  it('forbids service tokens on user endpoints', async () => {
    const token = await sign({ sub: 'delivery-worker', token_use: 'service', scope: 'memberships:read' });
    const res = await httpRequest(server.baseUrl, 'GET', '/protected', { token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('accepts a valid user token and exposes its claims as req.user', async () => {
    const sub = crypto.randomUUID();
    const token = await sign({ sub, email: 'user@example.com', name: 'Test User' });
    const res = await httpRequest(server.baseUrl, 'GET', '/protected', { token });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ sub, email: 'user@example.com', name: 'Test User' });
    expect(res.body.user.exp).toBeGreaterThan(0);
    expect(res.body.user.iat).toBeGreaterThan(0);
  });

  it('resolves keys from the configured JWKS URL', () => {
    expect(keys.remoteUrls).toEqual([
      process.env.AUTH_JWKS_URL ?? 'http://localhost:3001/.well-known/jwks.json',
    ]);
  });
});
