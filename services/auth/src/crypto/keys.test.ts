import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type KeysModule = typeof import('./keys.js');

async function freshKeys(): Promise<KeysModule> {
  vi.resetModules();
  return import('./keys.js');
}

function expectedKid(publicKeyPem: string): string {
  const jwk = crypto.createPublicKey(publicKeyPem).export({ format: 'jwk' });
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
    .digest('base64url')
    .slice(0, 16);
}

describe('crypto/keys', () => {
  beforeEach(() => {
    vi.stubEnv('JWT_PRIVATE_KEY', '');
    vi.stubEnv('JWT_PUBLIC_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws from every getter before initKeys() runs', async () => {
    const keys = await freshKeys();
    expect(() => keys.getPrivateKey()).toThrow(/Keys not initialized/);
    expect(() => keys.getPublicKey()).toThrow(/Keys not initialized/);
    expect(() => keys.getKid()).toThrow(/Keys not initialized/);
    await expect(keys.getJwks()).rejects.toThrow(/Keys not initialized/);
  });

  it('generates an RSA key pair when no PEM keys are configured', async () => {
    const keys = await freshKeys();
    await keys.initKeys();

    expect(keys.getPrivateKey()).toBeDefined();
    expect(keys.getPublicKey()).toBeDefined();
    expect(keys.getKid()).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it('generates a new key (and kid) on each dev start', async () => {
    const first = await freshKeys();
    await first.initKeys();
    const second = await freshKeys();
    await second.initKeys();

    expect(first.getKid()).not.toBe(second.getKid());
  });

  it('uses the configured PEM keys and derives a deterministic kid from the public key', async () => {
    const pair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    vi.stubEnv('JWT_PRIVATE_KEY', pair.privateKey);
    vi.stubEnv('JWT_PUBLIC_KEY', pair.publicKey);

    const first = await freshKeys();
    await first.initKeys();
    const second = await freshKeys();
    await second.initKeys();

    expect(first.getKid()).toBe(expectedKid(pair.publicKey));
    expect(second.getKid()).toBe(first.getKid());

    const jwks = await first.getJwks();
    const exported = crypto.createPublicKey(pair.publicKey).export({ format: 'jwk' });
    expect(jwks.keys[0].n).toBe(exported.n);
    expect(jwks.keys[0].e).toBe(exported.e);
  });

  it('rejects malformed PEM keys', async () => {
    vi.stubEnv('JWT_PRIVATE_KEY', 'not-a-key');
    vi.stubEnv('JWT_PUBLIC_KEY', 'not-a-key');
    const keys = await freshKeys();
    await expect(keys.initKeys()).rejects.toThrow();
  });

  it('publishes a single RS256 signing key in the JWKS with no private material', async () => {
    const keys = await freshKeys();
    await keys.initKeys();

    const jwks = await keys.getJwks();
    expect(jwks.keys).toHaveLength(1);
    const [key] = jwks.keys;
    expect(key).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig', kid: keys.getKid() });
    expect(typeof key.n).toBe('string');
    expect(key.e).toBe('AQAB');
    for (const privateField of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
      expect(key).not.toHaveProperty(privateField);
    }
  });
});
