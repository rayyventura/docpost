import { Router, Request, Response, NextFunction } from 'express';
import { eq, and } from 'drizzle-orm';
import { ForbiddenError } from '@docpost/shared';
import { getDb } from '../db/index.js';
import { teamMembers, binders } from '../db/schema.js';
import { requireUserAuth } from '../middleware/auth.js';

const router = Router();

router.get(
  '/teams/:teamId/binders',
  requireUserAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.sub;
      const teamId = req.params.teamId as string;

      const db = getDb();

      // Verify membership
      const membership = await db
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, teamId),
            eq(teamMembers.userId, userId),
          ),
        )
        .limit(1);

      if (membership.length === 0) {
        throw new ForbiddenError();
      }

      const teamBinders = await db
        .select({
          id: binders.id,
          name: binders.name,
        })
        .from(binders)
        .where(eq(binders.teamId, teamId));

      res.json(teamBinders);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
