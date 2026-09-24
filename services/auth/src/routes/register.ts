import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { ConflictError, ValidationError } from '@docpost/shared';
import { getDb } from '../db/index.js';
import { users } from '../db/schema.js';
import { signServiceToken } from '../crypto/jwt.js';

const registerSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1, 'Name is required'),
});

const router = Router();

// Team membership is normally granted by an admin. When AUTO_ASSIGN_ALL_TEAMS=true,
// a newly created account is added to every team currently in the platform database.
function autoAssignAllTeams(): boolean {
  return process.env.AUTO_ASSIGN_ALL_TEAMS === 'true';
}

async function assignUserToAllTeams(userId: string): Promise<void> {
  const platformUrl = (process.env.PLATFORM_URL ?? 'http://localhost:3002').replace(/\/$/, '');
  const accessToken = await signServiceToken({
    clientId: 'auth-service',
    scopes: ['memberships:write'],
  });

  const response = await fetch(`${platformUrl}/internal/users/${userId}/memberships`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to assign teams (${response.status}): ${body}`);
  }
}

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

    if (autoAssignAllTeams()) {
      try {
        await assignUserToAllTeams(newUser.id);
      } catch (err) {
        await db.delete(users).where(eq(users.id, newUser.id));
        throw err;
      }
    }

    res.status(201).json(newUser);
  } catch (err) {
    next(err);
  }
});

export default router;
