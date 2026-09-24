import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { eq, and, sql, desc } from 'drizzle-orm';
import { requireUserAuth } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { jobs, files, tasks } from '../db/schema.js';
import { generateUploadPlan, type UploadPlan } from '../lib/s3.js';
import { publishJobMessage } from '../lib/sqs.js';
import { ValidationError, NotFoundError, ForbiddenError } from '@docpost/shared';

const router = Router();

const PLATFORM_URL = process.env.PLATFORM_URL ?? 'http://localhost:3002';
const STAGING_DEADLINE_MINUTES = parseInt(process.env.STAGING_DEADLINE_MINUTES ?? '30', 10);

const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
] as const;

// ---------- Zod schemas ----------

const destinationSchema = z.object({
  teamId: z.string().uuid(),
  binderId: z.string().uuid(),
  folderId: z.string().uuid().nullable().optional(),
});

const fileSchema = z.object({
  name: z.string().min(1).max(255),
  sizeBytes: z.number().int().min(1).max(1_073_741_824),
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  sha256: z.string().min(1),
});

const mappingSchema = z.object({
  fileIndex: z.number().int().min(0),
  destinations: z.array(destinationSchema).min(1),
});

const createJobSchema = z.object({
  files: z.array(fileSchema).min(1).max(100),
  mappings: z.array(mappingSchema).min(1),
}).refine(
  (data) => data.mappings.every((m) => m.fileIndex < data.files.length),
  { message: 'fileIndex out of range' },
);

// ---------- Helpers ----------

async function checkTeamMembership(
  teamId: string,
  userId: string,
  authHeader: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${PLATFORM_URL}/teams/${teamId}/members/${userId}`, {
      headers: { Authorization: authHeader },
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

// ---------- POST /jobs ----------

router.post('/jobs', requireUserAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request body');
    }

    const { files: fileInputs, mappings } = parsed.data;
    const userId = req.user!.sub;
    const authHeader = req.headers.authorization!;

    // Collect unique teamIds and validate membership
    const uniqueTeamIds = [...new Set(mappings.flatMap((m) => m.destinations.map((d) => d.teamId)))];

    const membershipChecks = await Promise.all(
      uniqueTeamIds.map((teamId) => checkTeamMembership(teamId, userId, authHeader)),
    );

    for (let i = 0; i < uniqueTeamIds.length; i++) {
      if (!membershipChecks[i]) {
        throw new ForbiddenError(`Not a member of team ${uniqueTeamIds[i]}`);
      }
    }

    // Count total tasks
    const totalTasks = mappings.reduce((sum, m) => sum + m.destinations.length, 0);
    const now = new Date();
    const stagingDeadline = new Date(now.getTime() + STAGING_DEADLINE_MINUTES * 60_000);
    const nextCheckAt = new Date(now.getTime() + 60_000); // 60s delay

    const db = getDb();

    // Single transaction: insert job, files, tasks
    const result = await db.transaction(async (tx) => {
      // Insert job
      const [job] = await tx.insert(jobs).values({
        submittedByUserId: userId,
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
            folderId: dest.folderId ?? null,
            region: 'us-east-1',
          });
        }
      }

      if (taskValues.length > 0) {
        await tx.insert(tasks).values(taskValues);
      }

      return { jobId, fileRows };
    });

    // Generate presigned upload plans (outside transaction — no DB needed)
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

    // Publish watchdog message — failure here fails the endpoint
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

    const jobRows = await db
      .select()
      .from(jobs)
      .where(eq(jobs.submittedByUserId, userId))
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
      .where(sql`${tasks.jobId} IN ${jobIds}`)
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
      .where(sql`${jobs.id} = ${req.params.id} AND ${jobs.submittedByUserId} = ${userId}`);

    if (!job) {
      throw new NotFoundError('Job not found');
    }

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
      completedAt: job.completedAt,
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

    // Verify job ownership
    const [job] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(sql`${jobs.id} = ${req.params.id} AND ${jobs.submittedByUserId} = ${userId}`);

    if (!job) {
      throw new NotFoundError('Job not found');
    }

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
          .where(sql`${files.id} IN ${fileIds}`)
      : [];
    const fileNameMap = new Map(fileNames.map((f) => [f.id, f.originalName]));

    res.json({
      tasks: taskRows.map((t) => ({
        ...t,
        fileName: fileNameMap.get(t.fileId) ?? null,
      })),
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
