import { createHash, randomBytes } from 'node:crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { UnauthorizedError, ValidationError } from '@docpost/shared';
import { getDb } from '../db/index.js';
import { passwordResetTokens, users } from '../db/schema.js';
import { sendPasswordResetEmail } from '../email/mailer.js';

const TOKEN_TTL_MS = 60 * 60 * 1000;

const forgotSchema = z.object({
  email: z.string().email('Invalid email format'),
});

const resetSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const GENERIC_FORGOT_MESSAGE =
  'If an account exists for that email, a password reset link has been sent.';

function appBaseUrl(): string {
  const configured = process.env.APP_BASE_URL?.replace(/\/$/, '');
  if (configured) {
    return configured;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('APP_BASE_URL is required to build password reset links');
  }
  return 'http://localhost:5173';
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const router = Router();

router.post('/auth/password/forgot', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = forgotSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0].message);
    }

    const { email } = parseResult.data;
    const db = getDb();

    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (user) {
      const token = randomBytes(32).toString('base64url');
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

      await db.transaction(async (tx) => {
        await tx.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));
        await tx.insert(passwordResetTokens).values({
          userId: user.id,
          tokenHash,
          expiresAt,
        });
      });

      const resetUrl = `${appBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;

      try {
        await sendPasswordResetEmail({ to: user.email, resetUrl });
      } catch (err) {
        await db.delete(passwordResetTokens).where(eq(passwordResetTokens.tokenHash, tokenHash));
        throw err;
      }
    }

    res.status(200).json({ message: GENERIC_FORGOT_MESSAGE });
  } catch (err) {
    next(err);
  }
});

router.post('/auth/password/reset', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = resetSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0].message);
    }

    const { token, password } = parseResult.data;
    const db = getDb();
    const tokenHash = hashToken(token);
    const now = new Date();

    const [existing] = await db
      .select({
        id: passwordResetTokens.id,
        userId: passwordResetTokens.userId,
      })
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, now),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new UnauthorizedError('This reset link is invalid or has expired');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await db.transaction(async (tx) => {
      const [consumed] = await tx
        .update(passwordResetTokens)
        .set({ usedAt: now })
        .where(and(eq(passwordResetTokens.id, existing.id), isNull(passwordResetTokens.usedAt)))
        .returning({ userId: passwordResetTokens.userId });

      if (!consumed) {
        throw new UnauthorizedError('This reset link is invalid or has expired');
      }

      await tx.update(users).set({ passwordHash }).where(eq(users.id, consumed.userId));
    });

    res.status(200).json({ message: 'Password has been reset. You can sign in with your new password.' });
  } catch (err) {
    next(err);
  }
});

export default router;
