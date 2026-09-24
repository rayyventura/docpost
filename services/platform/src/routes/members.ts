import { Router, Request, Response, NextFunction } from 'express';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { teamMembers, teams } from '../db/schema.js';
import { requireServiceAuth } from '../middleware/auth.js';

const router = Router();

router.get(
  '/teams/:teamId/members/:userId',
  requireServiceAuth('memberships:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const teamId = req.params.teamId as string;
      const userId = req.params.userId as string;

      const db = getDb();

      const result = await db
        .select({
          addedAt: teamMembers.addedAt,
          region: teams.region,
        })
        .from(teamMembers)
        .innerJoin(teams, eq(teamMembers.teamId, teams.id))
        .where(
          and(
            eq(teamMembers.teamId, teamId),
            eq(teamMembers.userId, userId),
          ),
        )
        .limit(1);

      if (result.length === 0) {
        res.sendStatus(404);
        return;
      }

      res.json({
        addedAt: result[0].addedAt.toISOString(),
        region: result[0].region,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
