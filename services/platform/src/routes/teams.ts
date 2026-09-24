import { Router, Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { teams, teamMembers } from '../db/schema.js';
import { requireUserAuth } from '../middleware/auth.js';

const router = Router();

router.get(
  '/teams',
  requireUserAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.sub;
      const docPostEnabled = req.query.docPostEnabled as string | undefined;

      const db = getDb();

      const memberships = await db
        .select({
          id: teams.id,
          name: teams.name,
          region: teams.region,
          docpostEnabled: teams.docpostEnabled,
        })
        .from(teamMembers)
        .innerJoin(teams, eq(teamMembers.teamId, teams.id))
        .where(eq(teamMembers.userId, userId));

      let result = memberships;

      if (docPostEnabled === 'true') {
        result = memberships.filter((t) => t.docpostEnabled);
      } else if (docPostEnabled === 'false') {
        result = memberships.filter((t) => !t.docpostEnabled);
      }

      const response = result.map((t) => ({
        id: t.id,
        name: t.name,
        region: t.region,
      }));

      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
