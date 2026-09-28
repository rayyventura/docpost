import { Router, Request, Response, NextFunction } from 'express';
import { eq, and, asc } from 'drizzle-orm';
import { ValidationError } from '@docpost/shared';
import { getDb } from '../db/index.js';
import { teamMembers, teams } from '../db/schema.js';
import { requireServiceAuth } from '../middleware/auth.js';
import { isUuid } from '../lib/ids.js';

const router = Router();

router.get(
  '/internal/teams/:teamId',
  requireServiceAuth('memberships:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const teamId = req.params.teamId as string;
      if (!isUuid(teamId)) {
        throw new ValidationError('Invalid team id');
      }

      const db = getDb();
      const [team] = await db
        .select({ id: teams.id, name: teams.name })
        .from(teams)
        .where(eq(teams.id, teamId));

      if (!team) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Team not found' } });
        return;
      }

      res.json(team);
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/teams/:teamId/members',
  requireServiceAuth('memberships:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const teamId = req.params.teamId as string;
      if (!isUuid(teamId)) {
        throw new ValidationError('Invalid team id');
      }

      const db = getDb();
      const rows = await db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, teamId))
        .orderBy(asc(teamMembers.userId));

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

      // A malformed id cannot match a membership; answer like an unknown one.
      if (!isUuid(teamId) || !isUuid(userId)) {
        res.sendStatus(404);
        return;
      }

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

// Every new account is added to every team currently in the platform database.
// More granular permission access will be provided on demand in v2.
router.post(
  '/internal/users/:userId/memberships',
  requireServiceAuth('memberships:write'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.params.userId as string;
      if (!isUuid(userId)) {
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
      if (!isUuid(userId)) {
        throw new ValidationError('Invalid user id');
      }

      const db = getDb();
      const rows = await db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(eq(teamMembers.userId, userId))
        .orderBy(asc(teamMembers.teamId));

      res.json({ teamIds: rows.map((row) => row.teamId) });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
