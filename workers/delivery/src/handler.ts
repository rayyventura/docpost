import { FOLDER_DESTINATION_REQUIRED } from '@docpost/shared';
import type { SQSHandler, SQSRecord } from 'aws-lambda';
import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { getDb } from './db.js';
import { files, tasks } from './schema.js';
import { pushTaskUpdate } from './notify.js';

let _s3: S3Client | undefined;

function getS3() {
  if (!_s3) {
    _s3 = new S3Client({
      region: process.env.AWS_REGION ?? 'us-east-1',
      ...(process.env.S3_ENDPOINT && { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }),
    });
  }
  return _s3;
}

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function failureReason(code: string, values: Record<string, string>): string {
  return `${code} ${JSON.stringify(values)}`;
}

function maxAttempts(): number {
  return Number(env('MAX_RECEIVE_COUNT', '3'));
}

function receiveCount(record: SQSRecord): number {
  return Number(record.attributes?.ApproximateReceiveCount ?? 0);
}

function isLastAttempt(record: SQSRecord, attemptCount: number): boolean {
  const limit = maxAttempts();
  return receiveCount(record) >= limit || attemptCount >= limit;
}

function lastErrorReason(err: unknown): string {
  const name = err && typeof err === 'object' ? String((err as { name?: string }).name ?? '') : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return 'the request timed out';
  }

  const message = err instanceof Error ? err.message : String(err);
  if (/heap|out of memory|ENOMEM|JavaScript heap/i.test(message)) {
    return 'the file is too large to deliver';
  }
  if (/Platform returned \d+/.test(message)) {
    return 'the destination service rejected the delivery';
  }

  const trimmed = message.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
  return trimmed || 'an unexpected error occurred';
}

// ---------- Service token cache ----------

let cachedToken: string | null = null;
let cachedTokenExp = 0;

async function getServiceToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedTokenExp > now + 30) {
    return cachedToken;
  }

  const res = await fetch(env('AUTH_TOKEN_URL', 'http://localhost:3001/auth/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: env('SERVICE_CLIENT_ID', 'delivery-worker'),
      clientSecret: env('SERVICE_CLIENT_SECRET', 'delivery-worker-local-secret'),
      scope: 'documents:ingest',
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to get service token: ${res.status}`);
  }

  const { accessToken } = (await res.json()) as { accessToken: string };

  // Decode exp from JWT payload (base64url)
  const parts = accessToken.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  cachedToken = accessToken;
  cachedTokenExp = payload.exp ?? 0;

  return accessToken;
}

// ---------- Core processing ----------

export async function processRecord(record: SQSRecord): Promise<void> {
  const { taskId } = JSON.parse(record.body) as { taskId: string };
  console.log(`Delivery: processing task ${taskId}`);

  const db = await getDb();

  // Claim the task
  const [claimed] = await db
    .update(tasks)
    .set({
      status: 'in_progress',
      attemptCount: sql`${tasks.attemptCount} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tasks.id, taskId),
        inArray(tasks.status, ['pending', 'in_progress']),
      ),
    )
    .returning();

  if (claimed) {
    await pushTaskUpdate({
      jobId: claimed.jobId,
      taskId: claimed.id,
      fileId: claimed.fileId,
      attemptCount: claimed.attemptCount,
      status: 'in_progress',
    });
  }

  if (!claimed) {
    console.log(`Task ${taskId} already in terminal state, skipping`);
    return;
  }

  let fileName = 'File';

  try {
    const [file] = await db
      .select()
      .from(files)
      .where(eq(files.id, claimed.fileId));

    if (!file) {
      await failTask(db, claimed, `File record ${claimed.fileId} not found`);
      return;
    }

    fileName = file.originalName;

    if (!claimed.folderId) {
      await failTask(
        db,
        claimed,
        failureReason('INVALID_DESTINATION', {
          fileName: file.originalName,
          reason: FOLDER_DESTINATION_REQUIRED,
        }),
      );
      return;
    }

    try {
      await getS3().send(new HeadObjectCommand({ Bucket: env('S3_BUCKET', 'docpost-staging-local'), Key: file.s3Key }));
    } catch {
      await failTask(
        db,
        claimed,
        failureReason('FILE_NOT_UPLOADED', { fileName: file.originalName, reason: 'missing' }),
      );
      return;
    }

    const getResult = await getS3().send(new GetObjectCommand({ Bucket: env('S3_BUCKET', 'docpost-staging-local'), Key: file.s3Key }));
    const fileBuffer = await getResult.Body!.transformToByteArray();

    const token = await getServiceToken();

    const metadata = JSON.stringify({
      taskId: claimed.id,
      binderId: claimed.binderId,
      folderId: claimed.folderId,
      name: file.originalName,
      contentType: file.contentType,
      checksumSha256: file.checksumSha256,
      onBehalfOf: file.ownerUserId,
    });

    const formData = new FormData();
    formData.append('metadata', metadata);
    const blob = new Blob([Buffer.from(fileBuffer)], { type: file.contentType });
    formData.append('file', blob, file.originalName);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    try {
      const res = await fetch(`${env('PLATFORM_URL', 'http://localhost:3002')}/documents`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
        signal: controller.signal,
      });

      if (res.status === 201 || res.status === 200) {
        const body = (await res.json()) as { documentId: string };
        await db
          .update(tasks)
          .set({
            status: 'completed',
            platformDocumentId: body.documentId,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, claimed.id));

        console.log(`Task ${taskId} completed, document ${body.documentId}`);
        await pushTaskUpdate({
          jobId: claimed.jobId,
          taskId: claimed.id,
          fileId: claimed.fileId,
          fileName,
          attemptCount: claimed.attemptCount,
          status: 'completed',
        });
        await maybeCompleteJob(db, claimed.jobId);
        return;
      }

      if (res.status === 403) {
        await failTask(
          db,
          claimed,
          failureReason('NOT_AUTHORIZED_AT_DELIVERY', { fileName: file.originalName }),
        );
        return;
      }

      if (res.status === 422) {
        const body = (await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        const code = body?.error?.code === 'CHECKSUM_MISMATCH' ? 'CHECKSUM_MISMATCH' : 'INVALID_DESTINATION';
        await failTask(
          db,
          claimed,
          failureReason(code, {
            fileName: file.originalName,
            ...(body?.error?.message ? { reason: body.error.message } : {}),
          }),
        );
        return;
      }

      const errorBody = await res.text().catch(() => '');
      throw new Error(`Platform returned ${res.status}: ${errorBody}`);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if (isLastAttempt(record, claimed.attemptCount)) {
      await failTask(
        db,
        claimed,
        failureReason('RETRIES_EXHAUSTED', {
          fileName,
          attemptCount: String(claimed.attemptCount),
          reason: lastErrorReason(err),
        }),
      );
      return;
    }

    throw err;
  }
}

async function failTask(
  db: Awaited<ReturnType<typeof getDb>>,
  task: typeof tasks.$inferSelect,
  reason: string,
): Promise<void> {
  await db
    .update(tasks)
    .set({ status: 'failed', failureReason: reason, updatedAt: new Date() })
    .where(eq(tasks.id, task.id));

  console.log(`Task ${task.id} failed: ${reason}`);
  await pushTaskUpdate({
    jobId: task.jobId,
    taskId: task.id,
    fileId: task.fileId,
    attemptCount: task.attemptCount,
    status: 'failed',
    failureReason: reason,
  });
  await maybeCompleteJob(db, task.jobId);
}

async function maybeCompleteJob(
  db: Awaited<ReturnType<typeof getDb>>,
  jobId: string,
): Promise<void> {
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
}

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    await processRecord(record);
  }
};
