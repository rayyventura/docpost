import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureTestBucket,
  fakeJwt,
  json,
  pgPool,
  s3Client,
  stubServer,
  TEST_BUCKET,
  useLocalInfraEnv,
  type StubRequest,
  type StubServer,
} from './test-utils/integration.js';

describe.skipIf(!process.env.INTEGRATION)('delivery worker (integration: Postgres + LocalStack S3)', () => {
  const TOKEN = fakeJwt({ sub: 'delivery-worker', token_use: 'service', exp: Math.floor(Date.now() / 1000) + 900 });

  let pool: pg.Pool;
  let s3: S3Client;
  let auth: StubServer;
  let platform: StubServer;
  let apigw: StubServer;
  let platformReply: (req: StubRequest, res: import('node:http').ServerResponse) => void;
  let handler: typeof import('./handler.js').handler;
  let closeDb: () => Promise<void>;

  const created = { jobs: [] as string[], connections: [] as string[], keys: [] as string[] };

  beforeAll(async () => {
    useLocalInfraEnv();
    s3 = s3Client();
    await ensureTestBucket(s3);
    pool = pgPool();

    auth = await stubServer((_req, res) => json(res, 200, { accessToken: TOKEN, expiresIn: 900 }));
    platform = await stubServer((req, res) => platformReply(req, res));
    apigw = await stubServer((req, res) => {
      // PostToConnection: POST /@connections/{connectionId}
      const id = decodeURIComponent(req.url.split('/').pop() ?? '');
      if (id.startsWith('gone-')) {
        json(res, 410, { message: 'Gone' }, { 'x-amzn-errortype': 'GoneException' });
        return;
      }
      res.writeHead(200).end();
    });

    process.env.AUTH_TOKEN_URL = `${auth.url}/auth/token`;
    process.env.PLATFORM_URL = platform.url;
    process.env.WS_CALLBACK_URL = apigw.url;
    delete process.env.WS_PUSH_URL;
    process.env.MAX_RECEIVE_COUNT = '3';

    ({ handler } = await import('./handler.js'));
    ({ closeDb } = await import('./db.js'));
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM ws_connections WHERE connection_id = ANY($1)', [created.connections]);
      await pool.query('DELETE FROM tasks WHERE job_id = ANY($1::uuid[])', [created.jobs]);
      await pool.query('DELETE FROM files WHERE job_id = ANY($1::uuid[])', [created.jobs]);
      await pool.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [created.jobs]);
      await pool.end();
    }
    for (const Key of created.keys) await s3?.send(new DeleteObjectCommand({ Bucket: TEST_BUCKET, Key }));
    await closeDb?.();
    await Promise.all([auth?.close(), platform?.close(), apigw?.close()]);
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    platformReply = (_req, res) => json(res, 201, { documentId: randomUUID() });
  });

  async function seed(opts: { taskCount?: number; upload?: boolean; subscribers?: string[] } = {}) {
    const { taskCount = 1, upload = true, subscribers = [] } = opts;
    const jobId = randomUUID();
    const fileId = randomUUID();
    const userId = randomUUID();
    const body = Buffer.from(`%PDF-1.4 integration ${jobId}`);
    const s3Key = `it/delivery/${jobId}/${fileId}/protocol.pdf`;
    created.jobs.push(jobId);

    await pool.query('INSERT INTO jobs (id, submitted_by_user_id, task_count) VALUES ($1, $2, $3)', [
      jobId,
      userId,
      taskCount,
    ]);
    await pool.query(
      `INSERT INTO files (id, owner_user_id, job_id, original_name, size_bytes, content_type, checksum_sha256, s3_key, status, uploaded_at, staging_deadline_at)
       VALUES ($1, $2, $3, 'protocol.pdf', $4, 'application/pdf', $5, $6, 'uploaded', now(), now() + interval '1 hour')`,
      [fileId, userId, jobId, body.length, 'b'.repeat(64), s3Key],
    );
    const taskIds: string[] = [];
    for (let i = 0; i < taskCount; i++) {
      const taskId = randomUUID();
      taskIds.push(taskId);
      await pool.query(
        `INSERT INTO tasks (id, job_id, file_id, team_id, binder_id, folder_id, region)
         VALUES ($1, $2, $3, $4, $5, $6, 'us')`,
        [taskId, jobId, fileId, randomUUID(), randomUUID(), randomUUID()],
      );
    }
    for (const connectionId of subscribers) {
      created.connections.push(connectionId);
      await pool.query('INSERT INTO ws_connections (connection_id, user_id, job_id) VALUES ($1, $2, $3)', [
        connectionId,
        userId,
        jobId,
      ]);
    }
    if (upload) {
      created.keys.push(s3Key);
      await s3.send(new PutObjectCommand({ Bucket: TEST_BUCKET, Key: s3Key, Body: body, ContentType: 'application/pdf' }));
    }
    return { jobId, fileId, userId, taskIds, s3Key, sizeBytes: body.length };
  }

  function sqsEvent(taskId: string, receiveCount = 1): SQSEvent {
    const record = {
      messageId: randomUUID(),
      receiptHandle: 'rh',
      body: JSON.stringify({ taskId }),
      attributes: { ApproximateReceiveCount: String(receiveCount) },
      eventSource: 'aws:sqs',
    } as unknown as SQSRecord;
    return { Records: [record] };
  }

  const invoke = (event: SQSEvent) => handler(event, {} as never, () => {});

  async function task(id: string) {
    const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
    return rows[0];
  }
  async function job(id: string) {
    const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
    return rows[0];
  }
  function ingestCallsFor(taskId: string) {
    return platform.requests.filter((r) => r.url === '/documents' && JSON.parse(r.body).taskId === taskId);
  }
  function pushesTo(connectionId: string) {
    return apigw.requests
      .filter((r) => decodeURIComponent(r.url).endsWith(`/@connections/${connectionId}`))
      .map((r) => JSON.parse(r.body) as Record<string, unknown>);
  }

  it('delivers a staged file: ingest body + service token, task completed, job closed, pushes sent', async () => {
    const live = `live-${randomUUID()}`;
    const goneConn = `gone-${randomUUID()}`;
    const seeded = await seed({ subscribers: [live, goneConn] });
    const [taskId] = seeded.taskIds;
    const before = await task(taskId);

    await invoke(sqsEvent(taskId));

    const after = await task(taskId);
    expect(after.status).toBe('completed');
    expect(after.attempt_count).toBe(1);
    expect(after.platform_document_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(after.failure_reason).toBeNull();
    expect((await job(seeded.jobId)).completed_at).not.toBeNull();

    const tokenRequest = auth.requests.at(-1)!;
    expect(tokenRequest.method).toBe('POST');
    expect(JSON.parse(tokenRequest.body)).toMatchObject({ scope: 'documents:ingest' });

    const [ingest] = ingestCallsFor(taskId);
    expect(ingest.method).toBe('POST');
    expect(ingest.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(ingest.headers['content-type']).toBe('application/json');
    expect(JSON.parse(ingest.body)).toEqual({
      taskId,
      binderId: before.binder_id,
      folderId: before.folder_id,
      name: 'protocol.pdf',
      contentType: 'application/pdf',
      checksumSha256: 'b'.repeat(64),
      onBehalfOf: seeded.userId,
      s3Key: seeded.s3Key,
      sizeBytes: seeded.sizeBytes,
    });

    const pushes = pushesTo(live);
    expect(pushes.map((p) => p.status)).toEqual(['in_progress', 'completed']);
    expect(pushes[1]).toMatchObject({
      type: 'task_update',
      jobId: seeded.jobId,
      taskId,
      status: 'completed',
      counts: { pending: 0, in_progress: 0, completed: 1, failed: 0 },
    });
    expect(pushes[1]).not.toHaveProperty('failureReason');

    // API Gateway said 410 Gone for the stale connection: its row is removed.
    const { rowCount } = await pool.query('SELECT 1 FROM ws_connections WHERE connection_id = $1', [goneConn]);
    expect(rowCount).toBe(0);
    const { rowCount: liveCount } = await pool.query('SELECT 1 FROM ws_connections WHERE connection_id = $1', [live]);
    expect(liveCount).toBe(1);
  });

  it('is idempotent: a duplicate message for a completed task does not ingest again', async () => {
    const { taskIds } = await seed();
    const [taskId] = taskIds;

    await invoke(sqsEvent(taskId));
    await invoke(sqsEvent(taskId));

    expect(ingestCallsFor(taskId)).toHaveLength(1);
    const row = await task(taskId);
    expect(row.status).toBe('completed');
    expect(row.attempt_count).toBe(1);
  });

  it('fails with FILE_NOT_UPLOADED when the staged object is missing, without calling the platform', async () => {
    const live = `live-${randomUUID()}`;
    const { taskIds, jobId } = await seed({ upload: false, subscribers: [live] });
    const [taskId] = taskIds;

    await invoke(sqsEvent(taskId));

    const row = await task(taskId);
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toBe('FILE_NOT_UPLOADED {"fileName":"protocol.pdf","reason":"missing"}');
    expect(ingestCallsFor(taskId)).toHaveLength(0);
    expect((await job(jobId)).completed_at).not.toBeNull();
    expect(pushesTo(live).at(-1)).toEqual(
      expect.objectContaining({
        type: 'task_update',
        jobId,
        taskId,
        status: 'failed',
        failureReason: 'FILE_NOT_UPLOADED {"fileName":"protocol.pdf","reason":"missing"}',
      }),
    );
  });

  it('platform 403 fails the task immediately (non-retryable)', async () => {
    const { taskIds } = await seed();
    platformReply = (_req, res) => json(res, 403, { error: { code: 'FORBIDDEN', message: 'not a member' } });

    await expect(invoke(sqsEvent(taskIds[0]))).resolves.toBeUndefined();

    const row = await task(taskIds[0]);
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toBe('NOT_AUTHORIZED_AT_DELIVERY {"fileName":"protocol.pdf"}');
  });

  it('platform 400 fails the task immediately with the platform error, and pushes that reason live', async () => {
    const live = `live-${randomUUID()}`;
    const { taskIds, jobId } = await seed({ subscribers: [live] });
    platformReply = (_req, res) =>
      json(res, 400, { error: { code: 'VALIDATION_ERROR', message: 'binderId must be a UUID' } });

    await expect(invoke(sqsEvent(taskIds[0]))).resolves.toBeUndefined();

    const reason =
      'DELIVERY_REJECTED {"fileName":"protocol.pdf","status":"400","code":"VALIDATION_ERROR","reason":"binderId must be a UUID"}';
    const row = await task(taskIds[0]);
    expect(row.status).toBe('failed');
    expect(row.attempt_count).toBe(1);
    expect(row.failure_reason).toBe(reason);
    expect(ingestCallsFor(taskIds[0])).toHaveLength(1);
    expect((await job(jobId)).completed_at).not.toBeNull();
    expect(pushesTo(live).at(-1)).toEqual(
      expect.objectContaining({ type: 'task_update', jobId, taskId: taskIds[0], status: 'failed', failureReason: reason }),
    );
  });

  it('platform 401 is retried once with a fresh service token; a second 401 is terminal', async () => {
    const { taskIds } = await seed({ taskCount: 2 });
    const [recovers, rejected] = taskIds;
    const authBefore = auth.requests.length;

    let hits = 0;
    platformReply = (_req, res) => {
      hits += 1;
      if (hits === 1) json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'token expired' } });
      else json(res, 201, { documentId: randomUUID() });
    };
    await invoke(sqsEvent(recovers));
    expect((await task(recovers)).status).toBe('completed');
    expect(ingestCallsFor(recovers)).toHaveLength(2);
    expect(auth.requests.length - authBefore).toBe(1);

    platformReply = (_req, res) => json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'invalid service token' } });
    await expect(invoke(sqsEvent(rejected))).resolves.toBeUndefined();
    const row = await task(rejected);
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toBe(
      'DELIVERY_REJECTED {"fileName":"protocol.pdf","status":"401","code":"UNAUTHORIZED","reason":"invalid service token"}',
    );
    expect(ingestCallsFor(rejected)).toHaveLength(2);
  });

  it('platform 429 is retryable (task stays in_progress)', async () => {
    const { taskIds } = await seed();
    platformReply = (_req, res) => json(res, 429, { error: { code: 'TOO_MANY_REQUESTS', message: 'slow down' } });

    await expect(invoke(sqsEvent(taskIds[0], 1))).rejects.toThrow(/Platform returned 429/);

    const row = await task(taskIds[0]);
    expect(row.status).toBe('in_progress');
    expect(row.failure_reason).toBeNull();
  });

  it('platform 422 CHECKSUM_MISMATCH fails the task immediately', async () => {
    const { taskIds } = await seed();
    platformReply = (_req, res) =>
      json(res, 422, { error: { code: 'CHECKSUM_MISMATCH', message: 'checksum does not match' } });

    await invoke(sqsEvent(taskIds[0]));

    expect((await task(taskIds[0])).failure_reason).toBe(
      'CHECKSUM_MISMATCH {"fileName":"protocol.pdf","reason":"checksum does not match"}',
    );
  });

  it('platform 5xx is retried by SQS, and the last attempt marks the task failed with a reason', async () => {
    const { taskIds, jobId } = await seed({ taskCount: 2 });
    const [taskId, otherTaskId] = taskIds;
    platformReply = (_req, res) => json(res, 503, { error: { code: 'UNAVAILABLE', message: 'down' } });

    await expect(invoke(sqsEvent(taskId, 1))).rejects.toThrow(/Platform returned 503/);
    let row = await task(taskId);
    expect(row.status).toBe('in_progress');
    expect(row.attempt_count).toBe(1);
    expect(row.failure_reason).toBeNull();
    expect((await job(jobId)).completed_at).toBeNull();

    await expect(invoke(sqsEvent(taskId, 3))).resolves.toBeUndefined();
    row = await task(taskId);
    expect(row.status).toBe('failed');
    expect(row.attempt_count).toBe(2);
    expect(row.failure_reason).toBe(
      `RETRIES_EXHAUSTED ${JSON.stringify({
        fileName: 'protocol.pdf',
        attemptCount: '2',
        reason: 'the destination service rejected the delivery',
      })}`,
    );
    // The other task of the job is still pending, so the job stays open.
    expect((await task(otherTaskId)).status).toBe('pending');
    expect((await job(jobId)).completed_at).toBeNull();
  });

  it('a dropped platform connection is retryable and becomes RETRIES_EXHAUSTED on the last attempt', async () => {
    const { taskIds } = await seed();
    platformReply = (_req, res) => {
      res.socket?.destroy();
    };

    await expect(invoke(sqsEvent(taskIds[0], 2))).rejects.toThrow();
    expect((await task(taskIds[0])).status).toBe('in_progress');

    await invoke(sqsEvent(taskIds[0], 3));
    const row = await task(taskIds[0]);
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toMatch(/^RETRIES_EXHAUSTED /);
  });

  it('skips a task that already failed', async () => {
    const { taskIds } = await seed();
    await pool.query("UPDATE tasks SET status = 'failed', failure_reason = 'earlier' WHERE id = $1", [taskIds[0]]);

    await invoke(sqsEvent(taskIds[0]));

    const row = await task(taskIds[0]);
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toBe('earlier');
    expect(row.attempt_count).toBe(0);
    expect(ingestCallsFor(taskIds[0])).toHaveLength(0);
  });
});
