import type { SQSHandler, SQSRecord } from 'aws-lambda';
import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { getDb } from './db.js';
import { files, tasks, jobs } from './schema.js';

const BUCKET = process.env.S3_BUCKET ?? 'docpost-staging-local';
const AUTH_TOKEN_URL = process.env.AUTH_TOKEN_URL ?? 'http://localhost:3001/token';
const PLATFORM_URL = process.env.PLATFORM_URL ?? 'http://localhost:3002';
const SERVICE_CLIENT_ID = process.env.SERVICE_CLIENT_ID ?? 'delivery-worker';
const SERVICE_CLIENT_SECRET = process.env.SERVICE_CLIENT_SECRET ?? 'delivery-worker-local-secret';

const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  ...(process.env.S3_ENDPOINT && { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }),
});

// ---------- Service token cache ----------

let cachedToken: string | null = null;
let cachedTokenExp = 0;

async function getServiceToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedTokenExp > now + 30) {
    return cachedToken;
  }

  const res = await fetch(AUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: SERVICE_CLIENT_ID,
      clientSecret: SERVICE_CLIENT_SECRET,
      scopes: ['documents:ingest'],
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

  const db = getDb();

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

  if (!claimed) {
    console.log(`Task ${taskId} already in terminal state, skipping`);
    return;
  }

  // Load the file record
  const [file] = await db
    .select()
    .from(files)
    .where(eq(files.id, claimed.fileId));

  if (!file) {
    await failTask(db, claimed, `File record ${claimed.fileId} not found`);
    return;
  }

  // HEAD S3 to verify object exists
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: file.s3Key }));
  } catch {
    await failTask(
      db,
      claimed,
      `FILE_NOT_UPLOADED: ${file.originalName} not found in staging`,
    );
    return;
  }

  // Get the file from S3
  const getResult = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: file.s3Key }));
  const fileBuffer = await getResult.Body!.transformToByteArray();

  // Get service JWT
  const token = await getServiceToken();

  // Build multipart form for platform POST /documents
  const formData = new FormData();
  formData.append('teamId', claimed.teamId);
  formData.append('binderId', claimed.binderId);
  if (claimed.folderId) {
    formData.append('folderId', claimed.folderId);
  }
  formData.append('sourceTaskId', claimed.id);
  formData.append('name', file.originalName);
  formData.append('checksumSha256', file.checksumSha256);
  formData.append('uploadedByUserId', file.ownerUserId);

  const blob = new Blob([fileBuffer], { type: file.contentType });
  formData.append('file', blob, file.originalName);

  // Deliver to platform
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(`${PLATFORM_URL}/documents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (res.status === 201 || res.status === 200) {
      const body = (await res.json()) as { id: string };
      await db
        .update(tasks)
        .set({
          status: 'completed',
          platformDocumentId: body.id,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, claimed.id));

      console.log(`Task ${taskId} completed, document ${body.id}`);
      await maybeCompleteJob(db, claimed.jobId);
      return;
    }

    if (res.status === 403) {
      await failTask(
        db,
        claimed,
        `NOT_AUTHORIZED_AT_DELIVERY: ${file.originalName} → team ${claimed.teamId}/binder ${claimed.binderId}`,
      );
      return;
    }

    if (res.status === 422) {
      await failTask(
        db,
        claimed,
        `CHECKSUM_MISMATCH: ${file.originalName} → team ${claimed.teamId}/binder ${claimed.binderId}`,
      );
      return;
    }

    // 5xx or other — transient failure, throw to let SQS retry
    const errorBody = await res.text().catch(() => '');
    throw new Error(`Platform returned ${res.status}: ${errorBody}`);
  } catch (err) {
    clearTimeout(timer);
    // Re-throw for SQS retry (visibility timeout)
    throw err;
  }
}

async function failTask(
  db: ReturnType<typeof getDb>,
  task: typeof tasks.$inferSelect,
  reason: string,
): Promise<void> {
  await db
    .update(tasks)
    .set({ status: 'failed', failureReason: reason, updatedAt: new Date() })
    .where(eq(tasks.id, task.id));

  console.log(`Task ${task.id} failed: ${reason}`);
  await maybeCompleteJob(db, task.jobId);
}

async function maybeCompleteJob(
  db: ReturnType<typeof getDb>,
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
