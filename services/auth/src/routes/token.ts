import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { UnauthorizedError, ForbiddenError, ValidationError } from '@docpost/shared';
import { getDb } from '../db/index.js';
import { serviceClients } from '../db/schema.js';
import { signServiceToken } from '../crypto/jwt.js';

// Pre-computed dummy hash for constant-time comparison when client not found
const DUMMY_HASH = bcrypt.hashSync('dummy-secret-for-timing', 12);

const tokenSchema = z.object({
  clientId: z.string().min(1, 'clientId is required'),
  clientSecret: z.string().min(1, 'clientSecret is required'),
  scope: z.string().min(1, 'scope is required'),
});

const router = Router();

router.post('/auth/token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = tokenSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0].message);
    }

    const { clientId, clientSecret, scope } = parseResult.data;
    const db = getDb();

    const [client] = await db
      .select()
      .from(serviceClients)
      .where(eq(serviceClients.clientId, clientId))
      .limit(1);

    // Always do a bcrypt compare to prevent timing attacks
    const hashToCompare = client?.clientSecretHash ?? DUMMY_HASH;
    const secretValid = await bcrypt.compare(clientSecret, hashToCompare);

    if (!client || !secretValid) {
      throw new UnauthorizedError('Invalid client credentials');
    }

    // Validate requested scopes are a subset of allowed scopes
    const requestedScopes = scope.split(' ').filter(Boolean);
    const allowedScopes = new Set(client.scopes);
    const invalidScopes = requestedScopes.filter((s) => !allowedScopes.has(s));

    if (invalidScopes.length > 0) {
      throw new ForbiddenError(`Requested scopes not allowed: ${invalidScopes.join(', ')}`);
    }

    const accessToken = await signServiceToken({
      clientId: client.clientId,
      scopes: requestedScopes,
    });

    res.status(200).json({
      accessToken,
      expiresIn: 900,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
