import { Router, Request, Response, NextFunction } from 'express';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import { ForbiddenError } from '@docpost/shared';
import { getDb } from '../db/index.js';
import { teamMembers, teams, binders, folders, documents } from '../db/schema.js';
import { requireServiceAuth, requireUserAuth } from '../middleware/auth.js';

const router = Router();

async function verifyBinderMembership(binderId: string, userId: string): Promise<void> {
  const db = getDb();

  const binderResult = await db
    .select({ teamId: binders.teamId })
    .from(binders)
    .where(eq(binders.id, binderId))
    .limit(1);

  if (binderResult.length === 0) {
    throw new ForbiddenError();
  }

  const teamId = binderResult[0].teamId;

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
}

function formatDocument(doc: {
  id: string;
  name: string;
  sizeBytes: bigint;
  contentType: string;
  createdAt: Date;
}) {
  return {
    id: doc.id,
    name: doc.name,
    sizeBytes: doc.sizeBytes.toString(),
    contentType: doc.contentType,
    createdAt: doc.createdAt.toISOString(),
  };
}

// GET /binders/:binderId/contents — root level of a binder
router.get(
  '/binders/:binderId/contents',
  requireUserAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.sub;
      const binderId = req.params.binderId as string;

      await verifyBinderMembership(binderId, userId);

      const db = getDb();

      const rootFolders = await db
        .select({
          id: folders.id,
          name: folders.name,
        })
        .from(folders)
        .where(
          and(
            eq(folders.binderId, binderId),
            isNull(folders.parentFolderId),
          ),
        );

      const rootDocs = await db
        .select({
          id: documents.id,
          name: documents.name,
          sizeBytes: documents.sizeBytes,
          contentType: documents.contentType,
          createdAt: documents.createdAt,
        })
        .from(documents)
        .where(
          and(
            eq(documents.binderId, binderId),
            isNull(documents.folderId),
          ),
        );

      res.json({
        folders: rootFolders,
        documents: rootDocs.map(formatDocument),
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /folders/:folderId/contents — contents inside a folder
router.get(
  '/folders/:folderId/contents',
  requireUserAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.sub;
      const folderId = req.params.folderId as string;

      const db = getDb();

      // Resolve folder -> binder -> team
      const folderResult = await db
        .select({
          binderId: folders.binderId,
        })
        .from(folders)
        .where(eq(folders.id, folderId))
        .limit(1);

      if (folderResult.length === 0) {
        throw new ForbiddenError();
      }

      const binderId = folderResult[0].binderId;
      await verifyBinderMembership(binderId, userId);

      const childFolders = await db
        .select({
          id: folders.id,
          name: folders.name,
        })
        .from(folders)
        .where(eq(folders.parentFolderId, folderId));

      const folderDocs = await db
        .select({
          id: documents.id,
          name: documents.name,
          sizeBytes: documents.sizeBytes,
          contentType: documents.contentType,
          createdAt: documents.createdAt,
        })
        .from(documents)
        .where(eq(documents.folderId, folderId));

      res.json({
        folders: childFolders,
        documents: folderDocs.map(formatDocument),
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/internal/destination-paths',
  requireServiceAuth('memberships:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const items = req.body?.destinations;
      if (!Array.isArray(items)) {
        res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'destinations is required' } });
        return;
      }

      const teamIds = [...new Set(items.map((item: { teamId?: string }) => item.teamId).filter(Boolean))] as string[];
      const binderIds = [...new Set(items.map((item: { binderId?: string }) => item.binderId).filter(Boolean))] as string[];
      const folderIds = [...new Set(items.map((item: { folderId?: string | null }) => item.folderId).filter(Boolean))] as string[];

      const db = getDb();
      const [teamRows, binderRows] = await Promise.all([
        teamIds.length ? db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, teamIds)) : [],
        binderIds.length ? db.select({ id: binders.id, name: binders.name }).from(binders).where(inArray(binders.id, binderIds)) : [],
      ]);
      const teamNames = new Map(teamRows.map((row) => [row.id, row.name]));
      const binderNames = new Map(binderRows.map((row) => [row.id, row.name]));

      const folderInfo = new Map<string, { name: string; parentFolderId: string | null }>();
      let pending = [...folderIds];
      const seen = new Set<string>();
      while (pending.length > 0) {
        const ids = pending.filter((id) => !seen.has(id));
        if (ids.length === 0) break;
        ids.forEach((id) => seen.add(id));
        const rows = await db
          .select({ id: folders.id, name: folders.name, parentFolderId: folders.parentFolderId })
          .from(folders)
          .where(inArray(folders.id, ids));
        pending = [];
        for (const row of rows) {
          folderInfo.set(row.id, { name: row.name, parentFolderId: row.parentFolderId });
          if (row.parentFolderId && !seen.has(row.parentFolderId)) pending.push(row.parentFolderId);
        }
      }

      const destinations = items.map((item: { teamId: string; binderId: string; folderId?: string | null }) => {
        const folderChain: string[] = [];
        let current = item.folderId ?? null;
        const guard = new Set<string>();
        while (current && !guard.has(current)) {
          guard.add(current);
          const node = folderInfo.get(current);
          if (!node) break;
          folderChain.unshift(node.name);
          current = node.parentFolderId;
        }
        const path = [teamNames.get(item.teamId), binderNames.get(item.binderId), ...folderChain]
          .filter((part): part is string => Boolean(part))
          .join(' / ');
        return {
          teamId: item.teamId,
          binderId: item.binderId,
          folderId: item.folderId ?? null,
          path,
        };
      });

      res.json({ destinations });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
