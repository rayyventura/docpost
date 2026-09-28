import { Router, Request, Response, NextFunction } from 'express';
import { eq, and } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { AppError, ForbiddenError, NotFoundError } from '@docpost/shared';
import { getDb } from '../db/index.js';
import { binders, teamMembers, documents } from '../db/schema.js';
import {
  assertObjectMatchesIngest,
  copyStagingObjectToDocument,
  headStagingObject,
  presignDocumentDownload,
  usesObjectStorage,
} from '../lib/s3.js';
import { parseIngestBody } from '../lib/ingest.js';
import { assertFolderDestinations } from '../lib/folderDestinations.js';
import { requireServiceAuth, requireUserAuth } from '../middleware/auth.js';
import { isUuid } from '../lib/ids.js';

const router = Router();

router.get(
  '/documents/:documentId/download',
  requireUserAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.sub;
      const documentId = req.params.documentId as string;
      // A malformed id is reported like an unknown document.
      if (!isUuid(documentId)) {
        throw new NotFoundError('Document not found');
      }

      const db = getDb();

      const [document] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, documentId))
        .limit(1);

      if (!document) {
        throw new NotFoundError('Document not found');
      }

      const binderResult = await db
        .select({ teamId: binders.teamId })
        .from(binders)
        .where(eq(binders.id, document.binderId))
        .limit(1);

      if (binderResult.length === 0) {
        throw new NotFoundError('Document not found');
      }

      if (!isUuid(userId)) {
        throw new ForbiddenError();
      }

      const membership = await db
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, binderResult[0].teamId),
            eq(teamMembers.userId, userId),
          ),
        )
        .limit(1);

      if (membership.length === 0) {
        throw new ForbiddenError();
      }

      if (usesObjectStorage()) {
        const url = await presignDocumentDownload(document.id, document.name, document.contentType);
        res.json({ url, expiresIn: 120 });
        return;
      }

      const filename = document.name.replace(/["\r\n]/g, '');
      res.setHeader('Content-Type', document.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      const filePath = path.join(path.resolve(process.cwd(), 'uploads'), document.id);
      try {
        await fs.access(filePath);
      } catch {
        throw new NotFoundError('The file is no longer available to download');
      }

      createReadStream(filePath).pipe(res);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/documents',
  requireServiceAuth('documents:ingest'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const metadata = parseIngestBody(req.body);
      const db = getDb();

      const binderResult = await db
        .select({ teamId: binders.teamId })
        .from(binders)
        .where(eq(binders.id, metadata.binderId))
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
            eq(teamMembers.userId, metadata.onBehalfOf),
          ),
        )
        .limit(1);

      if (membership.length === 0) {
        throw new ForbiddenError();
      }

      await assertFolderDestinations([
        { teamId, binderId: metadata.binderId, folderId: metadata.folderId },
      ]);

      if (!usesObjectStorage()) {
        throw new AppError('OBJECT_STORAGE_REQUIRED', 'Object storage is required to ingest documents', 500);
      }

      const staging = await headStagingObject(metadata.s3Key);
      await assertObjectMatchesIngest(metadata.s3Key, staging, metadata.sizeBytes, metadata.checksumSha256);

      const insertResult = await db
        .insert(documents)
        .values({
          binderId: metadata.binderId,
          folderId: metadata.folderId,
          name: metadata.name,
          sizeBytes: BigInt(metadata.sizeBytes),
          contentType: metadata.contentType,
          checksumSha256: metadata.checksumSha256,
          sourceTaskId: metadata.taskId,
          uploadedByUserId: metadata.onBehalfOf,
        })
        .onConflictDoNothing({ target: documents.sourceTaskId })
        .returning({ id: documents.id });

      let documentId: string;
      if (insertResult.length > 0) {
        documentId = insertResult[0].id;
      } else {
        const existing = await db
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.sourceTaskId, metadata.taskId))
          .limit(1);
        documentId = existing[0].id;
      }

      await copyStagingObjectToDocument(metadata.s3Key, documentId, metadata.contentType);

      res.status(insertResult.length > 0 ? 201 : 200).json({ documentId });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
