import type { SQSHandler, SQSRecord } from 'aws-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { eq, and } from 'drizzle-orm';
import { getDb } from './db.js';
import { files, tasks } from './schema.js';
import { enqueueTasks } from './enqueue.js';
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

function taskQueueUrl(): string {
  return process.env.TASK_QUEUE_URL ?? 'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/docpost-tasks';
}

/**
 * True when SQS is handing this message out again because an earlier attempt did not ack it
 * (threw, timed out or crashed). A first delivery of a duplicate S3 notification is not one.
 */
function isRedelivery(record: SQSRecord): boolean {
  return Number(record.attributes?.ApproximateReceiveCount ?? 1) > 1;
}

async function enqueuePendingTasks(db: Awaited<ReturnType<typeof getDb>>, fileId: string): Promise<void> {
  const pendingTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.fileId, fileId), eq(tasks.status, 'pending')));

  if (pendingTasks.length === 0) {
    console.log(`No pending tasks for file ${fileId}`);
    return;
  }

  await enqueueTasks(getSqs(), taskQueueUrl(), pendingTasks.map((t) => t.id));
  console.log(`Enqueued ${pendingTasks.length} tasks for file ${fileId}`);
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

    const db = await getDb();

    // Look up file by s3Key
    const [file] = await db
      .select()
      .from(files)
      .where(eq(files.s3Key, s3Key));

    if (!file) {
      console.log(`No file record found for key ${s3Key}, skipping`);
      continue;
    }

    if (file.status === 'uploaded' && isRedelivery(record)) {
      // An earlier attempt promoted the file but did not finish enqueueing (blueprint: "Fan out
      // crashes mid batch"). Re-send whatever is still pending; the delivery worker's conditional
      // claim absorbs any message that did get through the first time.
      console.log(`File ${file.id} already uploaded; redelivered event, re-enqueueing its pending tasks`);
      await enqueuePendingTasks(db, file.id);
      continue;
    }

    if (file.status !== 'pending') {
      console.log(`File ${file.id} already processed (status: ${file.status}), skipping`);
      continue;
    }

    // HEAD the S3 object and verify its size matches the declared value
    const verification = await verifyStagedObject(getS3(), process.env.S3_BUCKET ?? 'docpost-staging-local', file);

    if (verification.status === 'missing') {
      console.error(`Failed to HEAD object ${s3Key}:`, verification.error);
      continue;
    }

    if (verification.status === 'rejected') {
      console.log(`File ${file.id}: ${verification.reason}`);
      await db
        .update(files)
        .set({ verificationError: verification.reason })
        .where(eq(files.id, file.id));
      continue;
    }

    // Promote file to 'uploaded' (clearing any earlier rejection of a previous upload)
    const [promoted] = await db
      .update(files)
      .set({ status: 'uploaded', uploadedAt: new Date(), verificationError: null })
      .where(and(eq(files.id, file.id), eq(files.status, 'pending')))
      .returning({ id: files.id });

    if (!promoted) {
      console.log(`File ${file.id} was already promoted by another process`);
      continue;
    }

    console.log(`File ${file.id} promoted to uploaded`);

    await enqueuePendingTasks(db, file.id);
  }
}

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    await processRecord(record);
  }
};
