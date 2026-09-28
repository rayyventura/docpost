import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashRefreshToken, isRefreshRecordValid, REFRESH_TOKEN_TTL_SECONDS } from './refresh.js';

describe('hashRefreshToken', () => {
  it('returns a stable SHA-256 hex digest', () => {
    const token = 'refresh-token-value';
    expect(hashRefreshToken(token)).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).not.toBe(hashRefreshToken(`${token}-other`));
  });
});

describe('isRefreshRecordValid', () => {
  const now = new Date('2026-09-28T12:00:00.000Z');

  it('accepts an unrevoked token that has not expired', () => {
    expect(
      isRefreshRecordValid(
        { revokedAt: null, expiresAt: new Date('2026-09-28T12:00:01.000Z') },
        now,
      ),
    ).toBe(true);
  });

  it('rejects a revoked token even if it has not expired', () => {
    expect(
      isRefreshRecordValid(
        {
          revokedAt: new Date('2026-09-28T11:59:00.000Z'),
          expiresAt: new Date('2026-10-05T12:00:00.000Z'),
        },
        now,
      ),
    ).toBe(false);
  });

  it('rejects an expired token', () => {
    expect(
      isRefreshRecordValid(
        { revokedAt: null, expiresAt: new Date('2026-09-28T12:00:00.000Z') },
        now,
      ),
    ).toBe(false);
  });
});

describe('refresh lifetime', () => {
  it('is seven days in seconds', () => {
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(604800);
  });
});
