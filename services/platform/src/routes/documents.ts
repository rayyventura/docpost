import { Router, Request, Response, NextFunction } from 'express';
import { eq, and } from 'drizzle-orm';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import multer from 'multer';
import { AppError, ForbiddenError, ValidationError } from '@docpost/shared';
import { getDb } from '../db/index.js';
import { binders, teamMembers, folders, documents } from '../db/schema.js';
import { requireServiceAuth } from '../middleware/auth.js';

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
  folderId?: string;
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

  if (folderId !== undefined && typeof folderId !== 'string') {
    throw new ValidationError('folderId must be a string if provided');
  }

  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new ValidationError(
      `Unsupported content type: ${contentType}. Allowed: ${[...ALLOWED_CONTENT_TYPES].join(', ')}`,
    );
  }

  return {
    taskId,
    binderId,
    folderId: folderId as string | undefined,
    name,
    contentType,
    checksumSha256,
    onBehalfOf,
  };
}

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

      // If folderId specified, verify the folder belongs to this binder
      if (metadata.folderId) {
        const folderResult = await db
          .select({ binderId: folders.binderId })
          .from(folders)
          .where(eq(folders.id, metadata.folderId))
          .limit(1);

        if (folderResult.length === 0 || folderResult[0].binderId !== metadata.binderId) {
          throw new ValidationError('Folder does not belong to the specified binder');
        }
      }

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

      // Store file to uploads directory
      const uploadsDir = path.resolve(process.cwd(), 'uploads');
      await fs.mkdir(uploadsDir, { recursive: true });

      // Try to insert document with ON CONFLICT (source_task_id) DO NOTHING
      const insertResult = await db
        .insert(documents)
        .values({
          binderId: metadata.binderId,
          folderId: metadata.folderId ?? null,
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
        // Newly inserted — save the file
        const documentId = insertResult[0].id;
        const filePath = path.join(uploadsDir, documentId);
        await fs.writeFile(filePath, fileBuffer);

        res.status(201).json({ documentId });
      } else {
        // Conflict — document with this source_task_id already exists
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
