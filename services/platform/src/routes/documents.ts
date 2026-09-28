import { Router, Request, Response, NextFunction } from 'express';
import { eq, and } from 'drizzle-orm';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import multer from 'multer';
import { AppError, FOLDER_DESTINATION_REQUIRED, ForbiddenError, NotFoundError, ValidationError } from '@docpost/shared';
import { getDb } from '../db/index.js';
import { binders, teamMembers, documents } from '../db/schema.js';
import { getDocumentObjectStream, putDocumentObject, usesObjectStorage } from '../lib/s3.js';
import { assertFolderDestinations } from '../lib/folderDestinations.js';
import { requireServiceAuth, requireUserAuth } from '../middleware/auth.js';

const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
]);

const upload = multer({ storage: multer.memoryStorage() });

const router = Router();

interface IngestMetadata {
  taskId: string;
  binderId: string;
  folderId: string;
  name: string;
  contentType: string;
  checksumSha256: string;
  onBehalfOf: string;
}

function parseMetadata(raw: string): IngestMetadata {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ValidationError('Invalid metadata JSON');
  }

  const { taskId, binderId, folderId, name, contentType, checksumSha256, onBehalfOf } = parsed;

  if (
    typeof taskId !== 'string' ||
    typeof binderId !== 'string' ||
    typeof name !== 'string' ||
    typeof contentType !== 'string' ||
    typeof checksumSha256 !== 'string' ||
    typeof onBehalfOf !== 'string'
  ) {
    throw new ValidationError(
      'metadata must include taskId, binderId, name, contentType, checksumSha256, onBehalfOf as strings',
    );
  }

  if (typeof folderId !== 'string' || folderId.length === 0) {
    throw new ValidationError(FOLDER_DESTINATION_REQUIRED);
  }

  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new ValidationError(
      `Unsupported content type: ${contentType}. Allowed: ${[...ALLOWED_CONTENT_TYPES].join(', ')}`,
    );
  }

  return {
    taskId,
    binderId,
    folderId,
    name,
    contentType,
    checksumSha256,
    onBehalfOf,
  };
}

router.get(
  '/documents/:documentId/download',
  requireUserAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.sub;
      const documentId = req.params.documentId as string;
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

      const filename = document.name.replace(/["\r\n]/g, '');
      res.setHeader('Content-Type', document.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      if (usesObjectStorage()) {
        const stream = await getDocumentObjectStream(document.id);
        if (!stream) {
          throw new NotFoundError('The file is no longer available to download');
        }
        stream.pipe(res);
        return;
      }

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
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Parse metadata from the multipart form
      const metadataRaw = req.body?.metadata as unknown;
      if (typeof metadataRaw !== 'string') {
        throw new ValidationError('Missing metadata field in multipart form');
      }

      const metadata = parseMetadata(metadataRaw);

      // Validate file is present
      if (!req.file) {
        throw new ValidationError('Missing file in multipart form');
      }

      const fileBuffer = req.file.buffer;

      const db = getDb();

      // Verify onBehalfOf user is a member of the binder's team (time-of-use auth)
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

      // Compute SHA-256 checksum of received file bytes
      const computedChecksum = crypto
        .createHash('sha256')
        .update(fileBuffer)
        .digest('hex');

      if (computedChecksum !== metadata.checksumSha256) {
        throw new AppError(
          'CHECKSUM_MISMATCH',
          `Declared checksum does not match. Expected ${metadata.checksumSha256}, got ${computedChecksum}`,
          422,
        );
      }

      const insertResult = await db
        .insert(documents)
        .values({
          binderId: metadata.binderId,
          folderId: metadata.folderId,
          name: metadata.name,
          sizeBytes: BigInt(fileBuffer.length),
          contentType: metadata.contentType,
          checksumSha256: metadata.checksumSha256,
          sourceTaskId: metadata.taskId,
          uploadedByUserId: metadata.onBehalfOf,
        })
        .onConflictDoNothing({ target: documents.sourceTaskId })
        .returning({ id: documents.id });

      if (insertResult.length > 0) {
        const documentId = insertResult[0].id;
        if (usesObjectStorage()) {
          await putDocumentObject(documentId, fileBuffer, metadata.contentType);
        } else {
          const uploadsDir = path.resolve(process.cwd(), 'uploads');
          await fs.mkdir(uploadsDir, { recursive: true });
          await fs.writeFile(path.join(uploadsDir, documentId), fileBuffer);
        }

        res.status(201).json({ documentId });
      } else {
        // Conflict: document with this source_task_id already exists
        const existing = await db
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.sourceTaskId, metadata.taskId))
          .limit(1);

        res.status(200).json({ documentId: existing[0].id });
      }
    } catch (err) {
      next(err);
    }
  },
);

export default router;
