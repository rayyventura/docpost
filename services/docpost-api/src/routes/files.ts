import { Router, Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { requireUserAuth } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { files, jobs } from '../db/schema.js';
import { initiateMultipartUpload, resignMultipartParts, presignDownload, PART_SIZE } from '../lib/s3.js';
import { visibleSubmitterIds } from '../lib/access.js';
import { isUuid } from '../lib/ids.js';
import { NotFoundError, ValidationError } from '@docpost/shared';

const router = Router();

// POST /files/:fileId/multipart: lazy multipart initiation or re-signing
router.post('/files/:fileId/multipart', requireUserAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const db = getDb();

    const fileId = req.params.fileId;
    if (!isUuid(fileId)) {
      throw new NotFoundError('File not found');
    }

    const [file] = await db
      .select()
      .from(files)
      .where(eq(files.id, fileId));

    // Submitter-only, and 404 (not 403) otherwise so existence is not confirmed,
    // the same as the job reads.
    if (!file || file.ownerUserId !== userId) {
      throw new NotFoundError('File not found');
    }

    const sizeBytes = Number(file.sizeBytes);
    const { uploadId, partNumbers } = req.body ?? {};

    if (uploadId && Array.isArray(partNumbers)) {
      // Re-sign mode: re-sign specific parts for an existing upload
      if (typeof uploadId !== 'string') {
        throw new ValidationError('uploadId must be a string');
      }
      const partCount = Math.ceil(sizeBytes / PART_SIZE);
      if (
        partNumbers.length === 0 ||
        partNumbers.some((n: unknown) => !Number.isInteger(n) || (n as number) < 1 || (n as number) > partCount)
      ) {
        throw new ValidationError(`partNumbers must be integers between 1 and ${partCount}`);
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

router.post('/files/:fileId/download-url', requireUserAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const fileId = req.params.fileId as string;
    if (!isUuid(fileId)) {
      throw new NotFoundError('File not found');
    }
    const header = req.headers.authorization ?? '';
    const userToken = header.startsWith('Bearer ') ? header.slice(7) : '';
    const db = getDb();

    const [row] = await db
      .select({
        s3Key: files.s3Key,
        status: files.status,
        submittedByUserId: jobs.submittedByUserId,
      })
      .from(files)
      .innerJoin(jobs, eq(files.jobId, jobs.id))
      .where(eq(files.id, fileId));

    if (!row || row.status !== 'uploaded') {
      throw new NotFoundError('File not found');
    }

    const submitterIds = await visibleSubmitterIds(userId, userToken);
    if (!submitterIds.has(row.submittedByUserId)) {
      throw new NotFoundError('File not found');
    }

    const url = await presignDownload(row.s3Key);
    res.json({ url, expiresIn: 120 });
  } catch (err) {
    next(err);
  }
});

export default router;
