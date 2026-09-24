import { Router, Request, Response, NextFunction } from 'express';
import { eq, and, isNull } from 'drizzle-orm';
import { ForbiddenError } from '@docpost/shared';
import { getDb } from '../db/index.js';
import { teamMembers, binders, folders, documents } from '../db/schema.js';
import { requireUserAuth } from '../middleware/auth.js';

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

export default router;
