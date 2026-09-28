import type { SQSHandler, SQSRecord } from 'aws-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { eq, and, sql, gte, inArray } from 'drizzle-orm';
import { getDb } from './db.js';
import { files, tasks, jobs } from './schema.js';
import { enqueueTasks } from './enqueue.js';
import { pushTaskUpdates, type TaskUpdate } from './notify.js';
import { verifyStagedObject } from './verify.js';

let _s3: S3Client | undefined;
let _sqs: SQSClient | undefined;

function getS3() {
  if (!_s3) {
    _s3 = new S3Client({
      region: process.env.AWS_REGION ?? 'us-east-1',
      ...(process.env.S3_ENDPOINT && { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }),
    });
  }
  return _s3;
}

function getSqs() {
  if (!_sqs) {
    _sqs = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      ...(process.env.SQS_ENDPOINT && { endpoint: process.env.SQS_ENDPOINT }),
    });
  }
  return _sqs;
}

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export async function processRecord(record: SQSRecord): Promise<void> {
  const { jobId } = JSON.parse(record.body) as { jobId: string };
  console.log(`Watchdog: checking job ${jobId}`);

  const db = await getDb();

  // Load job
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) {
    console.log(`Job ${jobId} not found, skipping`);
    return;
  }

  if (job.completedAt) {
    console.log(`Job ${jobId} already completed, skipping`);
    return;
  }

  const now = new Date();
  const statusChanges: TaskUpdate[] = [];

  if (isRedelivery(record)) {
    // A previous run of this message threw, possibly after promoting a file but before its
    // tasks were enqueued. Re-send tasks still pending on uploaded files; the delivery
    // worker's conditional claim absorbs any duplicate.
    await requeuePendingTasksOfUploadedFiles(db, jobId);
  }

  // Find all pending files for this job
  const pendingFiles = await db
    .select()
    .from(files)
    .where(and(eq(files.jobId, jobId), eq(files.status, 'pending')));

  for (const file of pendingFiles) {
    // Same check fan-out applies: the object must exist and match the declared size.
    const verification = await verifyStagedObject(getS3(), env('S3_BUCKET', 'docpost-staging-local'), file);

    if (verification.status === 'verified') {
      // Promote file and enqueue its tasks (the S3 event was lost or delayed)
      const [promoted] = await db
        .update(files)
        .set({ status: 'uploaded', uploadedAt: now, verificationError: null })
        .where(and(eq(files.id, file.id), eq(files.status, 'pending')))
        .returning({ id: files.id });

      if (promoted) {
        console.log(`Watchdog promoted file ${file.id} to uploaded`);
        const count = await enqueuePendingTasks(db, [file.id]);
        console.log(`Watchdog enqueued ${count} tasks for file ${file.id}`);
      }
      continue;
    }

    let rejection = file.verificationError;
    if (verification.status === 'rejected') {
      // Stored bytes don't match the declaration: never promote. Record it like fan-out does.
      rejection = verification.reason;
      if (file.verificationError !== verification.reason) {
        await db
          .update(files)
          .set({ verificationError: verification.reason })
          .where(and(eq(files.id, file.id), eq(files.status, 'pending')));
      }
      console.log(`Watchdog: file ${file.id} failed verification: ${verification.reason}`);
    }

    if (now > file.stagingDeadlineAt) {
      // Past deadline: fail all tasks for this file
      await db
        .update(files)
        .set({ status: 'expired' })
        .where(eq(files.id, file.id));

      // A rejected upload fails with the verification error (blueprint: files.verification_error
      // is copied into each task's failure_reason); otherwise the file simply never arrived.
      const failureReason =
        rejection ?? `FILE_NOT_UPLOADED ${JSON.stringify({ fileName: file.originalName, reason: 'deadline' })}`;

      const failed = await db
        .update(tasks)
        .set({
          status: 'failed',
          failureReason,
          updatedAt: now,
        })
        .where(and(eq(tasks.fileId, file.id), eq(tasks.status, 'pending')))
        .returning({ id: tasks.id, attemptCount: tasks.attemptCount });

      for (const task of failed) {
        statusChanges.push({
          taskId: task.id,
          fileId: file.id,
          fileName: file.originalName,
          attemptCount: task.attemptCount,
          status: 'failed',
          failureReason,
        });
      }

      console.log(`Watchdog expired file ${file.id} and failed its tasks`);
    }
  }

  statusChanges.push(...(await failExhaustedTasks(db, jobId, now)));

  // Live dashboard updates for every task this run failed. Never throws.
  await pushTaskUpdates(jobId, statusChanges);

  // Check if job is now complete
  await db.execute(sql`
    UPDATE jobs SET completed_at = now()
    WHERE id = ${jobId}
    AND completed_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM tasks
      WHERE job_id = ${jobId}
      AND status IN ('pending', 'in_progress')
    )
  `);

  // Reload job to check if terminal
  const [updatedJob] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (updatedJob?.completedAt) {
    console.log(`Job ${jobId} is now complete`);
    return;
  }

  // Re-arm: send new delayed watchdog message
  const nextCheckAt = new Date(now.getTime() + 60_000);

  const [updated] = await db
    .update(jobs)
    .set({ nextCheckAt })
    .where(
      and(
        eq(jobs.id, jobId),
        sql`(next_check_at = ${job.nextCheckAt} OR next_check_at IS NULL)`,
      ),
    )
    .returning({ id: jobs.id });

  if (updated) {
    await getSqs().send(
      new SendMessageCommand({
        QueueUrl: env('JOB_QUEUE_URL', 'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/docpost-jobs'),
        MessageBody: JSON.stringify({ jobId }),
        DelaySeconds: 60,
      }),
    );
    console.log(`Watchdog re-armed for job ${jobId} in 60s`);
  }
}

/** True when SQS hands this message out again because an earlier run did not ack it. */
function isRedelivery(record: SQSRecord): boolean {
  return Number(record.attributes?.ApproximateReceiveCount ?? 1) > 1;
}

type Db = Awaited<ReturnType<typeof getDb>>;

async function enqueuePendingTasks(db: Db, fileIds: string[]): Promise<number> {
  if (fileIds.length === 0) return 0;
  const pendingTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(inArray(tasks.fileId, fileIds), eq(tasks.status, 'pending')));

  await enqueueTasks(
    getSqs(),
    env('TASK_QUEUE_URL', 'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/docpost-tasks'),
    pendingTasks.map((t) => t.id),
  );
  return pendingTasks.length;
}

async function requeuePendingTasksOfUploadedFiles(db: Db, jobId: string): Promise<void> {
  const uploaded = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.jobId, jobId), eq(files.status, 'uploaded')));

  const count = await enqueuePendingTasks(db, uploaded.map((f) => f.id));
  if (count > 0) console.log(`Watchdog re-enqueued ${count} pending tasks of uploaded files for job ${jobId}`);
}

function maxAttempts(): number {
  return Number(env('MAX_RECEIVE_COUNT', '3'));
}

async function failExhaustedTasks(db: Db, jobId: string, now: Date): Promise<TaskUpdate[]> {
  const changes: TaskUpdate[] = [];
  const stuck = await db
    .select({
      id: tasks.id,
      fileId: tasks.fileId,
      attemptCount: tasks.attemptCount,
      fileName: files.originalName,
    })
    .from(tasks)
    .innerJoin(files, eq(files.id, tasks.fileId))
    .where(
      and(
        eq(tasks.jobId, jobId),
        inArray(tasks.status, ['pending', 'in_progress']),
        gte(tasks.attemptCount, maxAttempts()),
      ),
    );

  for (const task of stuck) {
    const reason = `RETRIES_EXHAUSTED ${JSON.stringify({
      fileName: task.fileName,
      attemptCount: String(task.attemptCount),
      reason: 'the delivery worker stopped after the maximum number of retries',
    })}`;

    const [failed] = await db
      .update(tasks)
      .set({
        status: 'failed',
        failureReason: reason,
        updatedAt: now,
      })
      .where(and(eq(tasks.id, task.id), inArray(tasks.status, ['pending', 'in_progress'])))
      .returning({ id: tasks.id });

    if (failed) {
      console.log(`Watchdog failed task ${task.id} after ${task.attemptCount} attempts`);
      changes.push({
        taskId: task.id,
        fileId: task.fileId,
        fileName: task.fileName,
        attemptCount: task.attemptCount,
        status: 'failed',
        failureReason: reason,
      });
    }
  }
  return changes;
}

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    await processRecord(record);
  }
};
