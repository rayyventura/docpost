import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { SQSEvent } from 'aws-lambda';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  drainMatching,
  ensureTestBucket,
  ensureTestQueue,
  LOCALSTACK,
  pgPool,
  s3Client,
  sqsClient,
  TEST_BUCKET,
  useLocalInfraEnv,
} from './test-utils/integration.js';

describe.skipIf(!process.env.INTEGRATION)('fanout worker (integration: Postgres + LocalStack S3/SQS)', { timeout: 20_000 }, () => {
  let pool: pg.Pool;
  let s3: S3Client;
  let sqs: SQSClient;
  let taskQueueUrl: string;
  let handler: typeof import('./handler.js').handler;
  let closeDb: () => Promise<void>;

  const created = { jobs: [] as string[], keys: [] as string[] };

  beforeAll(async () => {
    useLocalInfraEnv();
    process.env.SQS_ENDPOINT = LOCALSTACK;
    s3 = s3Client();
    sqs = sqsClient();
    await ensureTestBucket(s3);
    taskQueueUrl = await ensureTestQueue(sqs, 'docpost-workers-it-tasks');
    process.env.TASK_QUEUE_URL = taskQueueUrl;
    pool = pgPool();

    ({ handler } = await import('./handler.js'));
    ({ closeDb } = await import('./db.js'));
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM tasks WHERE job_id = ANY($1::uuid[])', [created.jobs]);
      await pool.query('DELETE FROM files WHERE job_id = ANY($1::uuid[])', [created.jobs]);
      await pool.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [created.jobs]);
      await pool.end();
    }
    for (const Key of created.keys) await s3?.send(new DeleteObjectCommand({ Bucket: TEST_BUCKET, Key }));
    await closeDb?.();
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  /** A job with one file bound for `pendingTasks` destinations (plus one already-failed task). */
  async function seed(opts: { pendingTasks?: number; declaredSize?: number; name?: string } = {}) {
    const { pendingTasks = 2, declaredSize = 64, name = 'protocol.pdf' } = opts;
    const jobId = randomUUID();
    const fileId = randomUUID();
    const userId = randomUUID();
    const s3Key = `it/fanout/${jobId}/${fileId}/${name}`;
    created.jobs.push(jobId);

    await pool.query('INSERT INTO jobs (id, submitted_by_user_id, task_count) VALUES ($1, $2, $3)', [
      jobId,
      userId,
      pendingTasks + 1,
    ]);
    await pool.query(
      `INSERT INTO files (id, owner_user_id, job_id, original_name, size_bytes, content_type, checksum_sha256, s3_key, staging_deadline_at)
       VALUES ($1, $2, $3, $4, $5, 'application/pdf', $6, $7, now() + interval '1 hour')`,
      [fileId, userId, jobId, name, declaredSize, 'c'.repeat(64), s3Key],
    );
    const pendingTaskIds: string[] = [];
    for (let i = 0; i < pendingTasks; i++) {
      const id = randomUUID();
      pendingTaskIds.push(id);
      await pool.query(
        `INSERT INTO tasks (id, job_id, file_id, team_id, binder_id, folder_id, region) VALUES ($1, $2, $3, $4, $5, $6, 'us')`,
        [id, jobId, fileId, randomUUID(), randomUUID(), randomUUID()],
      );
    }
    const failedTaskId = randomUUID();
    await pool.query(
      `INSERT INTO tasks (id, job_id, file_id, team_id, binder_id, folder_id, region, status, failure_reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'us', 'failed', 'INVALID_DESTINATION {}')`,
      [failedTaskId, jobId, fileId, randomUUID(), randomUUID(), randomUUID()],
    );
    return { jobId, fileId, s3Key, pendingTaskIds, failedTaskId };
  }

  async function upload(key: string, bytes: number) {
    created.keys.push(key);
    await s3.send(new PutObjectCommand({ Bucket: TEST_BUCKET, Key: key, Body: Buffer.alloc(bytes, 1) }));
  }

  /** The SQS message S3 delivers to the upload-events queue (key is URL-encoded, spaces as +). */
  function uploadEvent(key: string, receiveCount = 1): SQSEvent {
    const encoded = encodeURIComponent(key).replace(/%2F/g, '/').replace(/%20/g, '+');
    return {
      Records: [
        {
          messageId: randomUUID(),
          attributes: { ApproximateReceiveCount: String(receiveCount) },
          body: JSON.stringify({
            Records: [{ eventSource: 'aws:s3', eventName: 'ObjectCreated:Post', s3: { bucket: { name: TEST_BUCKET }, object: { key: encoded } } }],
          }),
        },
      ],
    } as unknown as SQSEvent;
  }

  const invoke = (event: SQSEvent) => handler(event, {} as never, () => {});

  async function fileRow(id: string) {
    const { rows } = await pool.query('SELECT * FROM files WHERE id = $1', [id]);
    return rows[0];
  }

  function taskMessages(taskIds: string[], expected: number, timeoutMs?: number) {
    const ids = new Set(taskIds);
    return drainMatching(sqs, taskQueueUrl, (b) => ids.has(String(b.taskId)), expected, timeoutMs);
  }

  it('promotes the uploaded file and sends exactly one delivery message per pending task', async () => {
    const seeded = await seed({ pendingTasks: 12, name: 'my protocol (v2).pdf' });
    await upload(seeded.s3Key, 64);

    await invoke(uploadEvent(seeded.s3Key));

    const file = await fileRow(seeded.fileId);
    expect(file.status).toBe('uploaded');
    expect(file.uploaded_at).toBeInstanceOf(Date);

    const messages = await taskMessages(seeded.pendingTaskIds, 12, 8000);
    expect(messages.map((m) => m.taskId).sort()).toEqual([...seeded.pendingTaskIds].sort());
    expect(messages.every((m) => Object.keys(m).join() === 'taskId')).toBe(true);
    // The already-failed task is never enqueued.
    expect(await taskMessages([seeded.failedTaskId], 1, 1500)).toHaveLength(0);

    // Tasks are still pending: fan-out only enqueues, delivery claims.
    const { rows } = await pool.query('SELECT status, count(*)::int AS n FROM tasks WHERE job_id = $1 GROUP BY status', [
      seeded.jobId,
    ]);
    expect(Object.fromEntries(rows.map((r) => [r.status, r.n]))).toEqual({ pending: 12, failed: 1 });
  });

  it('a duplicate S3 notification (first delivery) does not enqueue the tasks twice', async () => {
    const seeded = await seed({ pendingTasks: 2 });
    await upload(seeded.s3Key, 64);

    await invoke(uploadEvent(seeded.s3Key));
    await invoke(uploadEvent(seeded.s3Key));

    const messages = await taskMessages(seeded.pendingTaskIds, 2, 8000);
    expect(messages).toHaveLength(2);
    // ...and no duplicates show up afterwards.
    expect(await taskMessages(seeded.pendingTaskIds, 1, 1500)).toHaveLength(0);
  });

  it('a redelivered event (earlier attempt promoted, then failed to send) re-queues only still-pending tasks', async () => {
    const seeded = await seed({ pendingTasks: 3 });
    await upload(seeded.s3Key, 64);
    // State left behind by the crashed attempt: promoted, and one task already picked up by delivery.
    await pool.query(`UPDATE files SET status = 'uploaded', uploaded_at = now() WHERE id = $1`, [seeded.fileId]);
    const [claimed, ...stillPending] = seeded.pendingTaskIds;
    await pool.query(`UPDATE tasks SET status = 'in_progress', attempt_count = 1 WHERE id = $1`, [claimed]);

    await invoke(uploadEvent(seeded.s3Key, 2));

    const messages = await taskMessages(stillPending, 2, 8000);
    expect(messages.map((m) => m.taskId).sort()).toEqual([...stillPending].sort());
    expect(await taskMessages([claimed, seeded.failedTaskId], 1, 1500)).toHaveLength(0);
    expect((await fileRow(seeded.fileId)).status).toBe('uploaded');
  });

  it('clears an earlier SIZE_MISMATCH once a correct upload is verified', async () => {
    const seeded = await seed({ declaredSize: 64 });
    await upload(seeded.s3Key, 65);
    await invoke(uploadEvent(seeded.s3Key));
    expect((await fileRow(seeded.fileId)).verification_error).toMatch(/^SIZE_MISMATCH /);

    await upload(seeded.s3Key, 64);
    await invoke(uploadEvent(seeded.s3Key));

    const file = await fileRow(seeded.fileId);
    expect(file.status).toBe('uploaded');
    expect(file.verification_error).toBeNull();
    expect(await taskMessages(seeded.pendingTaskIds, 2, 8000)).toHaveLength(2);
  });

  it('does nothing while the object is not in storage yet', async () => {
    const seeded = await seed();

    await invoke(uploadEvent(seeded.s3Key));

    expect((await fileRow(seeded.fileId)).status).toBe('pending');
    expect(await taskMessages(seeded.pendingTaskIds, 1, 1500)).toHaveLength(0);
  });

  it('records SIZE_MISMATCH and keeps the file pending when stored bytes differ from the declared size', async () => {
    const seeded = await seed({ declaredSize: 64 });
    await upload(seeded.s3Key, 65);

    await invoke(uploadEvent(seeded.s3Key));

    const file = await fileRow(seeded.fileId);
    expect(file.status).toBe('pending');
    expect(file.verification_error).toBe(
      'SIZE_MISMATCH {"fileName":"protocol.pdf","declaredSize":64,"actualSize":65}',
    );
    expect(await taskMessages(seeded.pendingTaskIds, 1, 1500)).toHaveLength(0);
  });

  it('ignores events for keys that belong to no file', async () => {
    await expect(invoke(uploadEvent(`it/fanout/unknown/${randomUUID()}.pdf`))).resolves.toBeUndefined();
  });
});
