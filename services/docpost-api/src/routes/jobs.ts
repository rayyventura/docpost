import { Router, Request, Response, NextFunction } from 'express';
import { eq, and, sql, desc, inArray } from 'drizzle-orm';
import { requireUserAuth } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { jobs, files, tasks } from '../db/schema.js';
import { generateUploadPlan, type UploadPlan } from '../lib/s3.js';
import { publishJobMessage } from '../lib/sqs.js';
import { assertFolderDestinations, destinationPaths, teamName, visibleSubmitterIds, visibleTeams } from '../lib/access.js';
import { reconcileExhaustedTasks } from '../lib/reconcile.js';
import { ValidationError, NotFoundError, ForbiddenError } from '@docpost/shared';
import { createJobSchema, parsedDestinations, tooManyDestinationsMessage, totalSupportedDestinations } from '../lib/createJobSchema.js';

const router = Router();

const STAGING_DEADLINE_MINUTES = parseInt(process.env.STAGING_DEADLINE_MINUTES ?? '30', 10);

function destKey(destination: { teamId: string; binderId: string; folderId: string }): string {
  return `${destination.teamId}:${destination.binderId}:${destination.folderId}`;
}

function uniqueDestinations<T extends { teamId: string; binderId: string; folderId: string }>(
  destinations: T[],
): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const destination of destinations) {
    const key = destKey(destination);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(destination);
  }
  return unique;
}

// ---------- Helpers ----------

function bearerToken(req: Request): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

// ---------- POST /jobs ----------

router.post('/jobs', requireUserAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request body');
    }

    const { files: fileInputs } = parsed.data;
    const mappings = parsed.data.mappings?.length
      ? parsed.data.mappings.map((mapping) => ({
          ...mapping,
          destinations: uniqueDestinations(parsedDestinations(mapping.destinations)),
        }))
      : fileInputs.map((_, fileIndex) => ({
          fileIndex,
          destinations: uniqueDestinations(parsedDestinations(parsed.data.destinations ?? [])),
        }));
    const userId = req.user!.sub;

    // Same teams the user can already browse and download from.
    const allowedTeams = await visibleTeams(bearerToken(req));
    const uniqueTeamIds = [...new Set(mappings.flatMap((m) => m.destinations.map((d) => d.teamId)))];

    for (const teamId of uniqueTeamIds) {
      if (!allowedTeams.has(teamId)) {
        const name = await teamName(teamId);
        throw new ForbiddenError(`Not a member of team ${name}`);
      }
    }

    await assertFolderDestinations(mappings.flatMap((mapping) => mapping.destinations));

    const destinationLimit = totalSupportedDestinations();
    for (const mapping of mappings) {
      if (mapping.destinations.length > destinationLimit) {
        throw new ValidationError(tooManyDestinationsMessage(destinationLimit));
      }
    }

    const totalTasks = mappings.reduce((sum, m) => sum + m.destinations.length, 0);
    const now = new Date();
    const stagingDeadline = new Date(now.getTime() + STAGING_DEADLINE_MINUTES * 60_000);
    const nextCheckAt = new Date(now.getTime() + 60_000); // 60s delay

    const db = getDb();
    const userName = req.user!.name ?? req.user!.email ?? 'Unknown';

    // Single transaction: insert job, files, tasks
    const result = await db.transaction(async (tx) => {
      // Insert job
      const [job] = await tx.insert(jobs).values({
        submittedByUserId: userId,
        submitterName: userName,
        taskCount: totalTasks,
        nextCheckAt,
      }).returning({ id: jobs.id });

      const jobId = job.id;

      // Insert files
      const fileRows = await tx.insert(files).values(
        fileInputs.map((f) => {
          const fileId = crypto.randomUUID();
          return {
            id: fileId,
            ownerUserId: userId,
            jobId,
            originalName: f.name,
            sizeBytes: BigInt(f.sizeBytes),
            contentType: f.contentType,
            checksumSha256: f.sha256,
            s3Key: `uploads/${jobId}/${fileId}/${f.name}`,
            stagingDeadlineAt: stagingDeadline,
          };
        }),
      ).returning({ id: files.id, s3Key: files.s3Key });

      // Insert tasks
      const taskValues: Array<{
        jobId: string;
        fileId: string;
        teamId: string;
        binderId: string;
        folderId: string | null;
        region: string;
      }> = [];

      for (const mapping of mappings) {
        const fileRow = fileRows[mapping.fileIndex];
        for (const dest of mapping.destinations) {
          taskValues.push({
            jobId,
            fileId: fileRow.id,
            teamId: dest.teamId,
            binderId: dest.binderId,
            folderId: dest.folderId,
            region: 'us-east-1',
          });
        }
      }

      if (taskValues.length > 0) {
        await tx.insert(tasks).values(taskValues);
      }

      return { jobId, fileRows };
    });

    // Generate presigned upload plans (outside transaction; no DB needed)
    const uploadPlans: UploadPlan[] = await Promise.all(
      result.fileRows.map((fileRow, i) => {
        const input = fileInputs[i];
        return generateUploadPlan(
          fileRow.id,
          fileRow.s3Key,
          input.contentType,
          input.sha256,
          input.sizeBytes,
        );
      }),
    );

    // Publish watchdog message. Failure here fails the endpoint.
    await publishJobMessage(result.jobId, 60);

    res.status(201).json({
      jobId: result.jobId,
      taskCount: totalTasks,
      uploads: uploadPlans,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- GET /jobs ----------

router.get('/jobs', requireUserAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const offset = (page - 1) * limit;

    const db = getDb();
    const submitterIds = [...(await visibleSubmitterIds(userId, bearerToken(req)))];

    const jobRows = await db
      .select()
      .from(jobs)
      .where(inArray(jobs.submittedByUserId, submitterIds))
      .orderBy(desc(jobs.createdAt))
      .limit(limit)
      .offset(offset);

    if (jobRows.length === 0) {
      res.json({ jobs: [] });
      return;
    }

    // Aggregate task counts per job
    const jobIds = jobRows.map((j) => j.id);
    const taskCounts = await db
      .select({
        jobId: tasks.jobId,
        status: tasks.status,
        count: sql<number>`count(*)::int`,
      })
      .from(tasks)
      .where(inArray(tasks.jobId, jobIds))
      .groupBy(tasks.jobId, tasks.status);

    const countsMap = new Map<string, Record<string, number>>();
    for (const row of taskCounts) {
      if (!countsMap.has(row.jobId)) {
        countsMap.set(row.jobId, { pending: 0, in_progress: 0, completed: 0, failed: 0 });
      }
      countsMap.get(row.jobId)![row.status] = row.count;
    }

    const result = jobRows.map((j) => {
      const counts = countsMap.get(j.id) ?? { pending: 0, in_progress: 0, completed: 0, failed: 0 };
      return {
        jobId: j.id,
        createdAt: j.createdAt,
        taskCount: j.taskCount,
        completedAt: j.completedAt,
        submitterName: j.submitterName ?? 'Unknown',
        counts,
        aggregateStatus: computeAggregateStatus(counts),
      };
    });

    res.json({ jobs: result });
  } catch (err) {
    next(err);
  }
});

// ---------- GET /jobs/:id ----------

router.get('/jobs/:id', requireUserAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const db = getDb();

    const [job] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, req.params.id as string));

    if (!job) {
      throw new NotFoundError('Job not found');
    }

    const submitterIds = await visibleSubmitterIds(userId, bearerToken(req));
    if (!submitterIds.has(job.submittedByUserId)) {
      throw new NotFoundError('Job not found');
    }

    await reconcileExhaustedTasks(db, job.id);

    const [updatedJob] = await db
      .select({ completedAt: jobs.completedAt })
      .from(jobs)
      .where(eq(jobs.id, job.id));

    const taskCounts = await db
      .select({
        status: tasks.status,
        count: sql<number>`count(*)::int`,
      })
      .from(tasks)
      .where(eq(tasks.jobId, job.id))
      .groupBy(tasks.status);

    const counts: Record<string, number> = { pending: 0, in_progress: 0, completed: 0, failed: 0 };
    for (const row of taskCounts) {
      counts[row.status] = row.count;
    }

    res.json({
      jobId: job.id,
      createdAt: job.createdAt,
      taskCount: job.taskCount,
      completedAt: updatedJob?.completedAt ?? job.completedAt,
      submitterName: job.submitterName ?? 'Unknown',
      counts,
      aggregateStatus: computeAggregateStatus(counts),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- GET /jobs/:id/tasks ----------

router.get('/jobs/:id/tasks', requireUserAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const db = getDb();

    const [job] = await db
      .select({ id: jobs.id, submittedByUserId: jobs.submittedByUserId })
      .from(jobs)
      .where(eq(jobs.id, req.params.id as string));

    if (!job) {
      throw new NotFoundError('Job not found');
    }

    const submitterIds = await visibleSubmitterIds(userId, bearerToken(req));
    if (!submitterIds.has(job.submittedByUserId)) {
      throw new NotFoundError('Job not found');
    }

    await reconcileExhaustedTasks(db, job.id);

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 100));
    const offset = (page - 1) * limit;
    const statusFilter = req.query.status as string | undefined;

    const conditions = [eq(tasks.jobId, job.id)];
    if (statusFilter && ['pending', 'in_progress', 'completed', 'failed'].includes(statusFilter)) {
      conditions.push(eq(tasks.status, statusFilter as 'pending' | 'in_progress' | 'completed' | 'failed'));
    }

    const [taskRows, [{ total }]] = await Promise.all([
      db
        .select({
          taskId: tasks.id,
          fileId: tasks.fileId,
          teamId: tasks.teamId,
          binderId: tasks.binderId,
          folderId: tasks.folderId,
          status: tasks.status,
          attemptCount: tasks.attemptCount,
          failureReason: tasks.failureReason,
          platformDocumentId: tasks.platformDocumentId,
        })
        .from(tasks)
        .where(and(...conditions))
        .orderBy(tasks.createdAt)
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(tasks)
        .where(and(...conditions)),
    ]);

    // Enrich with file names
    const fileIds = [...new Set(taskRows.map((t) => t.fileId))];
    const fileNames = fileIds.length > 0
      ? await db
          .select({ id: files.id, originalName: files.originalName })
          .from(files)
          .where(inArray(files.id, fileIds))
      : [];
    const fileNameMap = new Map(fileNames.map((f) => [f.id, f.originalName]));
    const paths = await destinationPaths(taskRows.map((t) => ({
      teamId: t.teamId,
      binderId: t.binderId,
      folderId: t.folderId,
    })));

    res.json({
      tasks: taskRows.map((t) => {
        const detail = paths.get(`${t.teamId}:${t.binderId}:${t.folderId ?? ''}`);
        return {
          ...t,
          fileName: fileNameMap.get(t.fileId) ?? null,
          destination: detail?.path ?? null,
          teamName: detail?.teamName ?? null,
          binderName: detail?.binderName ?? null,
          folderPath: detail?.folderPath ?? [],
        };
      }),
      total,
      page,
      limit,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Helpers ----------

function computeAggregateStatus(counts: Record<string, number>): string {
  const { pending = 0, in_progress = 0, completed = 0, failed = 0 } = counts;
  const total = pending + in_progress + completed + failed;
  if (total === 0) return 'pending';
  if (completed === total) return 'completed';
  if (failed > 0 && pending === 0 && in_progress === 0) return 'failed';
  if (pending === total) return 'pending';
  return 'in_progress';
}

export default router;
