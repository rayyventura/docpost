import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { getJwks, getKid, getPublicKey, initKeys } from './keys.js';
import { signServiceToken, signUserToken } from './jwt.js';

beforeAll(async () => {
  await initKeys();
});

describe('signUserToken', () => {
  const user = { id: '11111111-1111-1111-1111-111111111111', email: 'a@example.com', name: 'A' };

  it('signs an RS256 user JWT with the current kid, subject and profile claims', async () => {
    const token = await signUserToken(user);

    expect(decodeProtectedHeader(token)).toEqual({ alg: 'RS256', kid: getKid() });
    const { payload } = await jwtVerify(token, getPublicKey(), { issuer: 'docpost-auth' });
    expect(payload.sub).toBe(user.id);
    expect(payload.email).toBe(user.email);
    expect(payload.name).toBe(user.name);
    expect(payload).not.toHaveProperty('token_use');
  });

  it('expires 15 minutes after issue', async () => {
    const token = await signUserToken(user);
    const { payload } = await jwtVerify(token, getPublicKey());
    expect(payload.exp! - payload.iat!).toBe(900);
  });

  it('verifies against the published JWKS', async () => {
    const token = await signUserToken(user);
    const jwks = createLocalJWKSet(await getJwks());
    await expect(jwtVerify(token, jwks, { issuer: 'docpost-auth', algorithms: ['RS256'] })).resolves.toBeDefined();
  });
});

describe('signServiceToken', () => {
  it('signs a service JWT with space-delimited scopes and token_use=service', async () => {
    const token = await signServiceToken({
      clientId: 'delivery-worker',
      scopes: ['documents:ingest', 'memberships:read'],
    });

    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(await getJwks()), {
      issuer: 'docpost-auth',
    });
    expect(protectedHeader).toMatchObject({ alg: 'RS256', kid: getKid() });
    expect(payload.sub).toBe('delivery-worker');
    expect(payload.scope).toBe('documents:ingest memberships:read');
    expect(payload.token_use).toBe('service');
    expect(payload.exp! - payload.iat!).toBe(900);
    expect(payload).not.toHaveProperty('email');
  });
});
