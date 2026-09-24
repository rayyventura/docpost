import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { UnauthorizedError, ValidationError } from '@docpost/shared';
import { getDb } from '../db/index.js';
import { users } from '../db/schema.js';
import { signUserToken } from '../crypto/jwt.js';

// Pre-computed dummy hash for constant-time comparison when user not found
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);

const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

const router = Router();

router.post('/auth/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0].message);
    }

    const { email, password } = parseResult.data;
    const db = getDb();

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // Always do a bcrypt compare to prevent timing attacks
    const hashToCompare = user?.passwordHash ?? DUMMY_HASH;
    const passwordValid = await bcrypt.compare(password, hashToCompare);

    if (!user || !passwordValid) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const accessToken = await signUserToken({ id: user.id, email: user.email });

    res.status(200).json({
      accessToken,
      expiresIn: 900,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
