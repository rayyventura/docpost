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

describe.skipIf(!process.env.INTEGRATION)('watchdog worker (integration: Postgres + LocalStack S3/SQS)', { timeout: 20_000 }, () => {
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
    process.env.MAX_RECEIVE_COUNT = '3';
    s3 = s3Client();
    sqs = sqsClient();
    await ensureTestBucket(s3);
    taskQueueUrl = await ensureTestQueue(sqs, 'docpost-workers-it-tasks');
    // Re-arm messages are delayed 60s; the test queue's 60s retention lets them expire unread.
    process.env.JOB_QUEUE_URL = await ensureTestQueue(sqs, 'docpost-workers-it-jobs');
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
  });

  const PREVIOUS_CHECK = new Date(Date.now() - 5_000);

  async function createJob(): Promise<string> {
    const jobId = randomUUID();
    created.jobs.push(jobId);
    await pool.query(
      'INSERT INTO jobs (id, submitted_by_user_id, task_count, next_check_at) VALUES ($1, $2, 0, $3)',
      [jobId, randomUUID(), PREVIOUS_CHECK],
    );
    return jobId;
  }

  async function createFile(
    jobId: string,
    opts: { deadlineInMs: number; status?: string; name?: string; size?: number },
  ) {
    const fileId = randomUUID();
    const name = opts.name ?? `${fileId}.pdf`;
    const s3Key = `it/watchdog/${jobId}/${fileId}/${name}`;
    await pool.query(
      `INSERT INTO files (id, owner_user_id, job_id, original_name, size_bytes, content_type, checksum_sha256, s3_key, status, staging_deadline_at)
       VALUES ($1, $2, $3, $4, $5, 'application/pdf', $6, $7, $8, now() + ($9 || ' milliseconds')::interval)`,
      [fileId, randomUUID(), jobId, name, opts.size ?? 32, 'd'.repeat(64), s3Key, opts.status ?? 'pending', String(opts.deadlineInMs)],
    );
    return { fileId, s3Key, name };
  }

  async function createTask(jobId: string, fileId: string, opts: { status?: string; attempts?: number; reason?: string } = {}) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO tasks (id, job_id, file_id, team_id, binder_id, folder_id, region, status, attempt_count, failure_reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'us', $7, $8, $9)`,
      [id, jobId, fileId, randomUUID(), randomUUID(), randomUUID(), opts.status ?? 'pending', opts.attempts ?? 0, opts.reason ?? null],
    );
    return id;
  }

  async function upload(key: string, bytes = 32) {
    created.keys.push(key);
    await s3.send(new PutObjectCommand({ Bucket: TEST_BUCKET, Key: key, Body: Buffer.alloc(bytes, 2) }));
  }

  const invoke = (jobId: string) =>
    handler({ Records: [{ messageId: randomUUID(), body: JSON.stringify({ jobId }) }] } as unknown as SQSEvent, {} as never, () => {});

  const row = async (table: 'jobs' | 'files' | 'tasks', id: string) =>
    (await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0];

  it('fails tasks of files past the staging deadline and leaves files still within it alone', async () => {
    const jobId = await createJob();
    const late = await createFile(jobId, { deadlineInMs: -60_000, name: 'late scan.pdf' });
    const early = await createFile(jobId, { deadlineInMs: 3_600_000 });
    const lateTasks = [await createTask(jobId, late.fileId), await createTask(jobId, late.fileId)];
    const lateAlreadyFailed = await createTask(jobId, late.fileId, { status: 'failed', reason: 'INVALID_DESTINATION {}' });
    const earlyTask = await createTask(jobId, early.fileId);

    await invoke(jobId);

    expect((await row('files', late.fileId)).status).toBe('expired');
    for (const id of lateTasks) {
      const task = await row('tasks', id);
      expect(task.status).toBe('failed');
      expect(task.failure_reason).toBe('FILE_NOT_UPLOADED {"fileName":"late scan.pdf","reason":"deadline"}');
    }
    expect((await row('tasks', lateAlreadyFailed)).failure_reason).toBe('INVALID_DESTINATION {}');

    expect((await row('files', early.fileId)).status).toBe('pending');
    const stillPending = await row('tasks', earlyTask);
    expect(stillPending.status).toBe('pending');
    expect(stillPending.failure_reason).toBeNull();

    // Job still has unresolved work: not complete, watchdog re-armed ~60s out.
    const job = await row('jobs', jobId);
    expect(job.completed_at).toBeNull();
    expect(job.next_check_at.getTime()).toBeGreaterThan(Date.now() + 50_000);
  });

  it('closes the job once every task is resolved and does not re-arm', async () => {
    const jobId = await createJob();
    const late = await createFile(jobId, { deadlineInMs: -1_000 });
    const taskId = await createTask(jobId, late.fileId);

    await invoke(jobId);

    expect((await row('tasks', taskId)).status).toBe('failed');
    const job = await row('jobs', jobId);
    expect(job.completed_at).not.toBeNull();
    expect(job.next_check_at.getTime()).toBe(PREVIOUS_CHECK.getTime());
  });

  it('promotes a stored file whose S3 event was lost and enqueues its pending tasks', async () => {
    const jobId = await createJob();
    const file = await createFile(jobId, { deadlineInMs: 3_600_000 });
    await upload(file.s3Key);
    const taskIds = [await createTask(jobId, file.fileId), await createTask(jobId, file.fileId)];

    await invoke(jobId);

    const promoted = await row('files', file.fileId);
    expect(promoted.status).toBe('uploaded');
    expect(promoted.uploaded_at).toBeInstanceOf(Date);
    const ids = new Set<string>(taskIds);
    const messages = await drainMatching(sqs, taskQueueUrl, (b) => ids.has(String(b.taskId)), 2, 8000);
    expect(messages.map((m) => m.taskId).sort()).toEqual([...taskIds].sort());
  });

  it('a stored file past its deadline is promoted, not expired', async () => {
    const jobId = await createJob();
    const file = await createFile(jobId, { deadlineInMs: -60_000 });
    await upload(file.s3Key);
    const taskId = await createTask(jobId, file.fileId);

    await invoke(jobId);

    expect((await row('files', file.fileId)).status).toBe('uploaded');
    expect((await row('tasks', taskId)).status).toBe('pending');
    await drainMatching(sqs, taskQueueUrl, (b) => b.taskId === taskId, 1, 8000);
  });

  it('fails tasks that exhausted their attempts and leaves the rest alone', async () => {
    const jobId = await createJob();
    const file = await createFile(jobId, { deadlineInMs: 3_600_000, status: 'uploaded', name: 'protocol.pdf' });
    const exhausted = await createTask(jobId, file.fileId, { status: 'in_progress', attempts: 3 });
    const retrying = await createTask(jobId, file.fileId, { status: 'in_progress', attempts: 1 });
    const done = await createTask(jobId, file.fileId, { status: 'completed', attempts: 3 });

    await invoke(jobId);

    const failed = await row('tasks', exhausted);
    expect(failed.status).toBe('failed');
    expect(JSON.parse(failed.failure_reason.replace(/^RETRIES_EXHAUSTED /, ''))).toEqual({
      fileName: 'protocol.pdf',
      attemptCount: '3',
      reason: 'the delivery worker stopped after the maximum number of retries',
    });
    expect((await row('tasks', retrying)).status).toBe('in_progress');
    expect((await row('tasks', done)).status).toBe('completed');
    expect((await row('jobs', jobId)).completed_at).toBeNull();
  });

  it('does nothing for a job that is already complete', async () => {
    const jobId = await createJob();
    await pool.query('UPDATE jobs SET completed_at = now() WHERE id = $1', [jobId]);
    const late = await createFile(jobId, { deadlineInMs: -60_000 });
    const taskId = await createTask(jobId, late.fileId);

    await invoke(jobId);

    expect((await row('files', late.fileId)).status).toBe('pending');
    expect((await row('tasks', taskId)).status).toBe('pending');
  });
});
