import { Router, Request, Response, NextFunction } from 'express';
import { eq, sql } from 'drizzle-orm';
import { requireUserAuth } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { files } from '../db/schema.js';
import { initiateMultipartUpload, resignMultipartParts } from '../lib/s3.js';
import { NotFoundError, ForbiddenError, ValidationError } from '@docpost/shared';

const router = Router();

// POST /files/:fileId/multipart — lazy multipart initiation or re-signing
router.post('/files/:fileId/multipart', requireUserAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const db = getDb();

    const fileId = req.params.fileId;
    const [file] = await db
      .select()
      .from(files)
      .where(sql`${files.id} = ${fileId}`);

    if (!file) {
      throw new NotFoundError('File not found');
    }

    if (file.ownerUserId !== userId) {
      throw new ForbiddenError('Not authorized to upload this file');
    }

    const sizeBytes = Number(file.sizeBytes);
    const { uploadId, partNumbers } = req.body ?? {};

    if (uploadId && Array.isArray(partNumbers)) {
      // Re-sign mode: re-sign specific parts for an existing upload
      if (partNumbers.some((n: unknown) => typeof n !== 'number' || n < 1)) {
        throw new ValidationError('partNumbers must be positive integers');
      }
      const result = await resignMultipartParts(file.s3Key, uploadId, partNumbers, sizeBytes);
      res.json(result);
    } else {
      // Initiate mode: create new multipart upload
      const result = await initiateMultipartUpload(file.s3Key, file.contentType, sizeBytes);
      res.json(result);
    }
  } catch (err) {
    next(err);
  }
});

export default router;
