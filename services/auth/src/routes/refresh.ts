import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '@docpost/shared';
import { revokeRefreshToken, rotateUserSession } from '../refresh.js';

const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

const router = Router();

router.post('/auth/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = refreshSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0].message);
    }

    const session = await rotateUserSession(parseResult.data.refreshToken);
    res.status(200).json(session);
  } catch (err) {
    next(err);
  }
});

router.post('/auth/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = refreshSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0].message);
    }

    await revokeRefreshToken(parseResult.data.refreshToken);
    res.status(200).json({ message: 'Signed out' });
  } catch (err) {
    next(err);
  }
});

export default router;
