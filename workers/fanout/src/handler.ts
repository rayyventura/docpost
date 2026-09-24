import type { SQSHandler, SQSRecord } from 'aws-lambda';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { eq, and, sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { files, tasks } from './schema.js';

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

export async function processRecord(record: SQSRecord): Promise<void> {
  // Parse S3 event notification from SQS message body
  const body = JSON.parse(record.body);
  const s3Records = body.Records ?? [body];

  for (const s3Record of s3Records) {
    const s3Key = decodeURIComponent(
      (s3Record.s3?.object?.key ?? s3Record.detail?.object?.key ?? '').replace(/\+/g, ' '),
    );

    if (!s3Key) {
      console.log('No S3 key found in event, skipping');
      continue;
    }

    console.log(`Processing upload event for key: ${s3Key}`);

    const db = getDb();

    // Look up file by s3Key
    const [file] = await db
      .select()
      .from(files)
      .where(eq(files.s3Key, s3Key));

    if (!file) {
      console.log(`No file record found for key ${s3Key}, skipping`);
      continue;
    }

    if (file.status !== 'pending') {
      console.log(`File ${file.id} already processed (status: ${file.status}), skipping`);
      continue;
    }

    // HEAD the S3 object to verify size
    let actualSize: number;
    try {
      const head = await getS3().send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET ?? 'docpost-staging-local', Key: s3Key }));
      actualSize = head.ContentLength ?? 0;
    } catch (err) {
      console.error(`Failed to HEAD object ${s3Key}:`, err);
      continue;
    }

    // Verify size matches declared value
    const declaredSize = Number(file.sizeBytes);
    if (actualSize !== declaredSize) {
      const reason = `Size mismatch: declared ${declaredSize}, actual ${actualSize}`;
      console.log(`File ${file.id}: ${reason}`);
      await db
        .update(files)
        .set({ verificationError: reason })
        .where(eq(files.id, file.id));
      continue;
    }

    // Promote file to 'uploaded'
    const [promoted] = await db
      .update(files)
      .set({ status: 'uploaded', uploadedAt: new Date() })
      .where(and(eq(files.id, file.id), eq(files.status, 'pending')))
      .returning({ id: files.id });

    if (!promoted) {
      console.log(`File ${file.id} was already promoted by another process`);
      continue;
    }

    console.log(`File ${file.id} promoted to uploaded`);

    // Query pending tasks for this file
    const pendingTasks = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.fileId, file.id), eq(tasks.status, 'pending')));

    if (pendingTasks.length === 0) {
      console.log(`No pending tasks for file ${file.id}`);
      continue;
    }

    // Enqueue tasks in batches of 10 (SQS SendMessageBatch limit)
    for (let i = 0; i < pendingTasks.length; i += 10) {
      const batch = pendingTasks.slice(i, i + 10);
      await getSqs().send(
        new SendMessageBatchCommand({
          QueueUrl: process.env.TASK_QUEUE_URL ?? 'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/docpost-tasks',
          Entries: batch.map((t, idx) => ({
            Id: String(idx),
            MessageBody: JSON.stringify({ taskId: t.id }),
          })),
        }),
      );
    }

    console.log(`Enqueued ${pendingTasks.length} tasks for file ${file.id}`);
  }
}

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    await processRecord(record);
  }
};
