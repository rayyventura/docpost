import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { ConflictError, ValidationError } from '@docpost/shared';
import { getDb } from '../db/index.js';
import { users } from '../db/schema.js';

const registerSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1, 'Name is required'),
});

const router = Router();

router.post('/auth/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = registerSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0].message);
    }

    const { email, password, name } = parseResult.data;
    const db = getDb();

    const passwordHash = await bcrypt.hash(password, 12);

    // Check if user already exists
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) {
      throw new ConflictError('Registration failed');
    }

    const [newUser] = await db
      .insert(users)
      .values({ email, passwordHash, name })
      .returning({ id: users.id, email: users.email, name: users.name });

    res.status(201).json(newUser);
  } catch (err) {
    next(err);
  }
});

export default router;
