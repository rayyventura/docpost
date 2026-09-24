import type { SQSHandler, SQSRecord } from 'aws-lambda';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { eq, and, sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { files, tasks, jobs } from './schema.js';

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

  const db = getDb();

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

  // Find all pending files for this job
  const pendingFiles = await db
    .select()
    .from(files)
    .where(and(eq(files.jobId, jobId), eq(files.status, 'pending')));

  const now = new Date();

  for (const file of pendingFiles) {
    // HEAD S3 to check if file exists
    let exists = false;
    try {
      await getS3().send(new HeadObjectCommand({ Bucket: env('S3_BUCKET', 'docpost-staging-local'), Key: file.s3Key }));
      exists = true;
    } catch {
      exists = false;
    }

    if (exists) {
      // Promote file and enqueue its tasks
      const [promoted] = await db
        .update(files)
        .set({ status: 'uploaded', uploadedAt: now })
        .where(and(eq(files.id, file.id), eq(files.status, 'pending')))
        .returning({ id: files.id });

      if (promoted) {
        console.log(`Watchdog promoted file ${file.id} to uploaded`);

        const pendingTasks = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.fileId, file.id), eq(tasks.status, 'pending')));

        for (let i = 0; i < pendingTasks.length; i += 10) {
          const batch = pendingTasks.slice(i, i + 10);
          await getSqs().send(
            new SendMessageBatchCommand({
              QueueUrl: env('TASK_QUEUE_URL', 'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/docpost-tasks'),
              Entries: batch.map((t, idx) => ({
                Id: String(idx),
                MessageBody: JSON.stringify({ taskId: t.id }),
              })),
            }),
          );
        }

        console.log(`Watchdog enqueued ${pendingTasks.length} tasks for file ${file.id}`);
      }
    } else if (now > file.stagingDeadlineAt) {
      // Past deadline — fail all tasks for this file
      await db
        .update(files)
        .set({ status: 'expired' })
        .where(eq(files.id, file.id));

      await db
        .update(tasks)
        .set({
          status: 'failed',
          failureReason: `FILE_NOT_UPLOADED: ${file.originalName} was not uploaded before the staging deadline`,
          updatedAt: now,
        })
        .where(and(eq(tasks.fileId, file.id), eq(tasks.status, 'pending')));

      console.log(`Watchdog expired file ${file.id} and failed its tasks`);
    }
  }

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

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    await processRecord(record);
  }
};
