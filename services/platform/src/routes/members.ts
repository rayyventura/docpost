import { Router, Request, Response, NextFunction } from 'express';
import { eq, and } from 'drizzle-orm';
import { ValidationError } from '@docpost/shared';
import { getDb } from '../db/index.js';
import { teamMembers, teams } from '../db/schema.js';
import { requireServiceAuth } from '../middleware/auth.js';

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router = Router();

router.get(
  '/teams/:teamId/members',
  requireServiceAuth('memberships:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const teamId = req.params.teamId as string;
      if (!USER_ID_PATTERN.test(teamId)) {
        throw new ValidationError('Invalid team id');
      }

      const db = getDb();
      const rows = await db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, teamId));

      res.json({ userIds: rows.map((row) => row.userId) });
    } catch (err) {
      next(err);
    }
  },
);

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

// Team membership is normally granted by an admin. This endpoint exists so a new
// account can be placed on every current team when that behavior is configured.
router.post(
  '/internal/users/:userId/memberships',
  requireServiceAuth('memberships:write'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.params.userId as string;
      if (!USER_ID_PATTERN.test(userId)) {
        throw new ValidationError('Invalid user id');
      }

      const db = getDb();
      const allTeams = await db.select({ id: teams.id }).from(teams);

      if (allTeams.length > 0) {
        await db
          .insert(teamMembers)
          .values(allTeams.map((team) => ({ teamId: team.id, userId })))
          .onConflictDoNothing();
      }

      res.status(200).json({ assigned: allTeams.length });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/internal/users/:userId/teams',
  requireServiceAuth('memberships:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.params.userId as string;
      if (!USER_ID_PATTERN.test(userId)) {
        throw new ValidationError('Invalid user id');
      }

      const db = getDb();
      const rows = await db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(eq(teamMembers.userId, userId));

      res.json({ teamIds: rows.map((row) => row.teamId) });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
