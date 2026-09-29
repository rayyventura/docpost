import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { jwtVerify } from 'jose';
import { UnauthorizedError } from '@docpost/shared';
import { createFakeDb } from './testing/fake-db.js';
import { getPublicKey, initKeys } from './crypto/keys.js';

const fake = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('./db/index.js', () => ({ getDb: () => fake.current }));

const { hashRefreshToken, issueUserSession, revokeRefreshToken, rotateUserSession } = await import(
  './refresh.js'
);

const user = { id: '22222222-2222-2222-2222-222222222222', email: 'b@example.com', name: 'B' };
const db = createFakeDb();

beforeAll(async () => {
  await initKeys();
});

beforeEach(() => {
  db.reset();
  fake.current = db.db;
});

function insertedRefreshRows(): Array<{ userId: string; tokenHash: string; expiresAt: Date }> {
  return db.argsOf('values').map((args) => args[0] as { userId: string; tokenHash: string; expiresAt: Date });
}

describe('issueUserSession', () => {
  it('returns a 15-minute access token and a 7-day refresh token, storing only its hash', async () => {
    db.queue(undefined); // insert refresh token
    const before = Date.now();

    const session = await issueUserSession(user);

    expect(session.expiresIn).toBe(300);
    expect(session.refreshExpiresIn).toBe(604800);
    expect(session.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const { payload } = await jwtVerify(session.accessToken, getPublicKey());
    expect(payload.sub).toBe(user.id);

    const [row] = insertedRefreshRows();
    expect(row.userId).toBe(user.id);
    expect(row.tokenHash).toBe(hashRefreshToken(session.refreshToken));
    expect(row.tokenHash).not.toBe(session.refreshToken);
    const ttl = row.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(604800 * 1000);
    expect(ttl).toBeLessThan(604800 * 1000 + 5000);
  });

  it('issues a different refresh token every time', async () => {
    db.queue(undefined, undefined);
    const a = await issueUserSession(user);
    const b = await issueUserSession(user);
    expect(a.refreshToken).not.toBe(b.refreshToken);
  });
});

describe('rotateUserSession', () => {
  const future = () => new Date(Date.now() + 60_000);
  const past = () => new Date(Date.now() - 1);

  it('revokes the presented token and issues a new pair', async () => {
    db.queue(
      [{ id: 'rt-1', userId: user.id, expiresAt: future(), revokedAt: null }], // lookup token
      [user], // lookup user
      [{ id: 'rt-1' }], // consume old token
      undefined, // insert new token
    );

    const session = await rotateUserSession('old-token');

    expect(session.expiresIn).toBe(300);
    expect(session.refreshExpiresIn).toBe(604800);
    expect(session.refreshToken).not.toBe('old-token');
    const { payload } = await jwtVerify(session.accessToken, getPublicKey());
    expect(payload).toMatchObject({ sub: user.id, email: user.email, name: user.name });

    expect(db.argsOf('set')[0][0]).toMatchObject({ revokedAt: expect.any(Date) });
    const [row] = insertedRefreshRows();
    expect(row.tokenHash).toBe(hashRefreshToken(session.refreshToken));
    expect(db.argsOf('transaction')).toHaveLength(1);
    expect(db.remaining()).toBe(0);
  });

  it('rejects an unknown token without touching the database further', async () => {
    db.queue([]);
    await expect(rotateUserSession('nope')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(db.argsOf('update')).toHaveLength(0);
    expect(db.argsOf('insert')).toHaveLength(0);
  });

  it('rejects a revoked token', async () => {
    db.queue([{ id: 'rt-1', userId: user.id, expiresAt: future(), revokedAt: new Date() }]);
    await expect(rotateUserSession('revoked')).rejects.toThrow('Invalid refresh token');
    expect(db.argsOf('insert')).toHaveLength(0);
  });

  it('rejects an expired token', async () => {
    db.queue([{ id: 'rt-1', userId: user.id, expiresAt: past(), revokedAt: null }]);
    await expect(rotateUserSession('expired')).rejects.toThrow('Invalid refresh token');
    expect(db.argsOf('insert')).toHaveLength(0);
  });

  it('rejects a token whose user no longer exists', async () => {
    db.queue([{ id: 'rt-1', userId: user.id, expiresAt: future(), revokedAt: null }], []);
    await expect(rotateUserSession('orphan')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(db.argsOf('insert')).toHaveLength(0);
  });

  it('rejects and issues nothing when a concurrent refresh consumed the token first', async () => {
    db.queue(
      [{ id: 'rt-1', userId: user.id, expiresAt: future(), revokedAt: null }],
      [user],
      [], // conditional update matched no row: already revoked by the winner
    );
    await expect(rotateUserSession('raced')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(db.argsOf('insert')).toHaveLength(0);
  });
});

describe('revokeRefreshToken', () => {
  it('marks the matching unrevoked token as revoked', async () => {
    db.queue(undefined);
    await revokeRefreshToken('some-token');
    expect(db.argsOf('update')).toHaveLength(1);
    expect(db.argsOf('set')[0][0]).toEqual({ revokedAt: expect.any(Date) });
    expect(db.argsOf('where')).toHaveLength(1);
  });
});
