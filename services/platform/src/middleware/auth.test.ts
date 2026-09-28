import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { CryptoKey, JSONWebKeySet } from 'jose';
import { ForbiddenError, UnauthorizedError } from '@docpost/shared';

// Replace the remote JWKS fetch with a local key set so no network is used.
const state = vi.hoisted(() => ({ jwks: { keys: [] } as JSONWebKeySet, remoteUrls: [] as string[] }));

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: (url: URL) => {
      state.remoteUrls.push(url.toString());
      return (...args: Parameters<ReturnType<typeof actual.createLocalJWKSet>>) =>
        actual.createLocalJWKSet(state.jwks)(...args);
    },
  };
});

const { requireServiceAuth, requireUserAuth } = await import('./auth.js');

const KID = 'unit-kid';
let privateKey: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  state.jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256' }] };
});

interface TokenOptions {
  sub?: string | null;
  issuer?: string;
  exp?: string | number;
  key?: CryptoKey;
  alg?: string;
  claims?: Record<string, unknown>;
}

async function token(opts: TokenOptions = {}): Promise<string> {
  const jwt = new SignJWT(opts.claims ?? {})
    .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: KID })
    .setIssuer(opts.issuer ?? 'docpost-auth')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m');
  if (opts.sub !== null) jwt.setSubject(opts.sub ?? 'user-1');
  return jwt.sign(opts.key ?? privateKey);
}

function reqWith(authorization?: string): Request {
  return { headers: authorization === undefined ? {} : { authorization } } as unknown as Request;
}

/** Runs a middleware and resolves with whatever it passes to next(). */
function run(
  mw: (req: Request, res: Response, next: NextFunction) => void,
  req: Request,
): Promise<unknown> {
  return new Promise((resolve) => {
    mw(req, {} as Response, (err?: unknown) => resolve(err));
  });
}

describe('JWKS resolution', () => {
  it('uses AUTH_JWKS_URL (default: local auth service) and caches the key set', async () => {
    await run(requireUserAuth, reqWith(`Bearer ${await token({ claims: { token_use: 'user' } })}`));
    await run(requireUserAuth, reqWith(`Bearer ${await token({ claims: { token_use: 'user' } })}`));
    expect(state.remoteUrls).toEqual([process.env.AUTH_JWKS_URL ?? 'http://localhost:3001/.well-known/jwks.json']);
  });
});

describe('requireUserAuth', () => {
  it('throws UnauthorizedError synchronously when the header is missing', () => {
    expect(() => requireUserAuth(reqWith(), {} as Response, vi.fn())).toThrow(UnauthorizedError);
  });

  it.each(['Basic abc', 'bearer abc', 'Bearer'])('rejects a malformed header %j', (header) => {
    expect(() => requireUserAuth(reqWith(header), {} as Response, vi.fn())).toThrow(UnauthorizedError);
  });

  it('accepts a valid user token and sets req.user', async () => {
    const req = reqWith(
      `Bearer ${await token({ sub: 'u-1', claims: { email: 'u@x.test', token_use: 'user', scope: 'a b' } })}`,
    );
    expect(await run(requireUserAuth, req)).toBeUndefined();
    expect(req.user).toMatchObject({ sub: 'u-1', email: 'u@x.test', token_use: 'user', scope: 'a b' });
    expect(req.user!.exp).toBeGreaterThan(req.user!.iat);
  });

  it('accepts a token with no token_use (treated as a user token)', async () => {
    expect(await run(requireUserAuth, reqWith(`Bearer ${await token()}`))).toBeUndefined();
  });

  it('forbids service tokens', async () => {
    const err = await run(requireUserAuth, reqWith(`Bearer ${await token({ claims: { token_use: 'service' } })}`));
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it.each<[string, TokenOptions]>([
    ['wrong issuer', { issuer: 'someone-else' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 60 }],
    ['signed by an unknown key', { get key() { return otherKey; } }],
  ])('rejects a token with %s with UnauthorizedError', async (_label, opts) => {
    const err = await run(requireUserAuth, reqWith(`Bearer ${await token(opts)}`));
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as Error).message).toBe('Invalid or expired token');
  });

  it('rejects a token without a subject', async () => {
    const err = await run(requireUserAuth, reqWith(`Bearer ${await token({ sub: null })}`));
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as Error).message).toBe('Token missing subject');
  });

  it('rejects a non-RS256 (HS256) token', async () => {
    const hs = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: KID })
      .setIssuer('docpost-auth')
      .setSubject('u')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('x'.repeat(32)));
    expect(await run(requireUserAuth, reqWith(`Bearer ${hs}`))).toBeInstanceOf(UnauthorizedError);
  });

  it('rejects garbage', async () => {
    expect(await run(requireUserAuth, reqWith('Bearer not.a.jwt'))).toBeInstanceOf(UnauthorizedError);
  });
});

describe('requireServiceAuth', () => {
  const ingest = requireServiceAuth('documents:ingest');

  it('accepts a service token with the required scope', async () => {
    const req = reqWith(`Bearer ${await token({ claims: { token_use: 'service', scope: 'documents:ingest' } })}`);
    expect(await run(ingest, req)).toBeUndefined();
    expect(req.user).toMatchObject({ token_use: 'service', scope: 'documents:ingest' });
  });

  it('accepts the scope among several space-separated scopes', async () => {
    const req = reqWith(
      `Bearer ${await token({ claims: { token_use: 'service', scope: 'memberships:read documents:ingest' } })}`,
    );
    expect(await run(ingest, req)).toBeUndefined();
  });

  it.each([
    ['a different scope', 'memberships:read'],
    ['a scope prefix', 'documents'],
    ['a scope with a suffix', 'documents:ingest:all'],
    ['comma-separated scopes', 'memberships:read,documents:ingest'],
    ['no scope', undefined],
  ])('forbids %s', async (_label, scope) => {
    const req = reqWith(`Bearer ${await token({ claims: { token_use: 'service', scope } })}`);
    const err = await run(ingest, req);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(req.user).toBeUndefined();
  });

  it('forbids user tokens even when they carry the scope', async () => {
    const req = reqWith(`Bearer ${await token({ claims: { token_use: 'user', scope: 'documents:ingest' } })}`);
    const err = await run(ingest, req);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as Error).message).toBe('Only service tokens are allowed on this endpoint');
  });

  it('forbids tokens without token_use', async () => {
    const req = reqWith(`Bearer ${await token({ claims: { scope: 'documents:ingest' } })}`);
    expect(await run(ingest, req)).toBeInstanceOf(ForbiddenError);
  });

  it('throws UnauthorizedError synchronously without a bearer token', () => {
    expect(() => ingest(reqWith(), {} as Response, vi.fn())).toThrow(UnauthorizedError);
  });

  it('rejects an invalid token before checking scope', async () => {
    const t = await token({ key: otherKey, claims: { token_use: 'service', scope: 'documents:ingest' } });
    expect(await run(ingest, reqWith(`Bearer ${t}`))).toBeInstanceOf(UnauthorizedError);
  });
});
