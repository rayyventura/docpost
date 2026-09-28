import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { UnauthorizedError } from '@docpost/shared';
import { getDb } from './db/index.js';
import { refreshTokens, users } from './db/schema.js';
import { signUserToken } from './crypto/jwt.js';

export const ACCESS_TOKEN_TTL_SECONDS = 900;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_SECONDS * 1000;

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isRefreshRecordValid(
  record: { revokedAt: Date | null; expiresAt: Date },
  now = new Date(),
): boolean {
  if (record.revokedAt) {
    return false;
  }
  return record.expiresAt.getTime() > now.getTime();
}

function newRefreshTokenValue(): string {
  return randomBytes(32).toString('base64url');
}

export interface UserSessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
}

async function insertRefreshToken(
  db: ReturnType<typeof getDb>,
  userId: string,
): Promise<{ refreshToken: string; expiresAt: Date }> {
  const refreshToken = newRefreshTokenValue();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await db.insert(refreshTokens).values({
    userId,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt,
  });
  return { refreshToken, expiresAt };
}

export async function issueUserSession(user: {
  id: string;
  email: string;
  name: string;
}): Promise<UserSessionTokens> {
  const db = getDb();
  const accessToken = await signUserToken(user);
  const { refreshToken } = await insertRefreshToken(db, user.id);
  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
  };
}

export async function rotateUserSession(presentedToken: string): Promise<UserSessionTokens> {
  const db = getDb();
  const tokenHash = hashRefreshToken(presentedToken);
  const now = new Date();

  const [existing] = await db
    .select({
      id: refreshTokens.id,
      userId: refreshTokens.userId,
      expiresAt: refreshTokens.expiresAt,
      revokedAt: refreshTokens.revokedAt,
    })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);

  if (!existing || !isRefreshRecordValid(existing, now)) {
    throw new UnauthorizedError('Invalid refresh token');
  }

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
    })
    .from(users)
    .where(eq(users.id, existing.userId))
    .limit(1);

  if (!user) {
    throw new UnauthorizedError('Invalid refresh token');
  }

  const accessToken = await signUserToken(user);
  const nextRefresh = newRefreshTokenValue();
  const nextExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  const rotated = await db.transaction(async (tx) => {
    const [consumed] = await tx
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(refreshTokens.id, existing.id), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });

    if (!consumed) {
      return null;
    }

    await tx.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: hashRefreshToken(nextRefresh),
      expiresAt: nextExpiresAt,
    });

    return consumed;
  });

  if (!rotated) {
    throw new UnauthorizedError('Invalid refresh token');
  }

  return {
    accessToken,
    refreshToken: nextRefresh,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
  };
}

export async function revokeRefreshToken(presentedToken: string): Promise<void> {
  const db = getDb();
  const tokenHash = hashRefreshToken(presentedToken);
  const now = new Date();
  await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)));
}
