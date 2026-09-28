import { FOLDER_DESTINATION_REQUIRED } from '@docpost/shared';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { files, tasks } from './schema.js';
import { fakeDb, render, type DbCall } from './test-utils/fake-db.js';

const mocks = vi.hoisted(() => ({
  s3Send: vi.fn(),
  s3Configs: [] as unknown[],
  pushTaskUpdate: vi.fn(async (_input: unknown) => {}),
  db: undefined as unknown,
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mocks.s3Send;
    constructor(config: unknown) {
      mocks.s3Configs.push(config);
    }
  },
  HeadObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('./db.js', () => ({ getDb: async () => mocks.db }));
vi.mock('./notify.js', () => ({ pushTaskUpdate: mocks.pushTaskUpdate }));

const AUTH_URL = 'http://auth.test/auth/token';
const PLATFORM_URL = 'http://platform.test';
const BUCKET = 'staging-bucket-test';

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

const TOKEN = jwt({ sub: 'delivery-worker', token_use: 'service', exp: Math.floor(Date.now() / 1000) + 900 });

function taskRow(overrides: Partial<typeof tasks.$inferSelect> = {}): typeof tasks.$inferSelect {
  return {
    id: 'task-1',
    jobId: 'job-1',
    fileId: 'file-1',
    teamId: 'team-1',
    binderId: 'binder-1',
    folderId: 'folder-1',
    region: 'us',
    status: 'in_progress',
    attemptCount: 1,
    failureReason: null,
    platformDocumentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fileRow(overrides: Partial<typeof files.$inferSelect> = {}): typeof files.$inferSelect {
  return {
    id: 'file-1',
    ownerUserId: 'user-1',
    jobId: 'job-1',
    originalName: 'protocol.pdf',
    sizeBytes: 2048n,
    contentType: 'application/pdf',
    checksumSha256: 'a'.repeat(64),
    s3Key: 'uploads/job-1/file-1/protocol.pdf',
    status: 'uploaded',
    verificationError: null,
    uploadedAt: new Date(),
    stagingDeadlineAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(),
    ...overrides,
  };
}

function record(taskId = 'task-1', receiveCount = 1): SQSRecord {
  return {
    messageId: `msg-${taskId}-${receiveCount}`,
    receiptHandle: 'rh',
    body: JSON.stringify({ taskId }),
    attributes: { ApproximateReceiveCount: String(receiveCount) },
  } as unknown as SQSRecord;
}

interface Scenario {
  claim?: (typeof tasks.$inferSelect)[];
  file?: typeof files.$inferSelect | null;
}

function setupDb({ claim = [taskRow()], file = fileRow() }: Scenario = {}) {
  const fake = fakeDb((call: DbCall) => {
    if (call.op === 'update' && call.tableName === 'tasks' && call.values?.status === 'in_progress') {
      return call.returning ? claim : [];
    }
    if (call.op === 'select' && call.tableName === 'files') return file ? [file] : [];
    return [];
  });
  mocks.db = fake.db;
  return fake.calls;
}

type PlatformReply = (init: RequestInit) => Response | Promise<Response>;

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
let platformReply: PlatformReply;
let authReply: () => Response;

function platformCalls() {
  return fetchMock.mock.calls.filter(([url]) => url === `${PLATFORM_URL}/documents`);
}
function authCalls() {
  return fetchMock.mock.calls.filter(([url]) => url === AUTH_URL);
}
function statusWrites(calls: DbCall[]) {
  return calls.filter((c) => c.op === 'update' && c.tableName === 'tasks' && c.values?.status !== 'in_progress');
}

let processRecord: typeof import('./handler.js').processRecord;
let handler: typeof import('./handler.js').handler;
let documentIngestBody: typeof import('./handler.js').documentIngestBody;

beforeEach(async () => {
  vi.resetModules(); // fresh service-token cache and S3 client per test
  vi.stubEnv('AUTH_TOKEN_URL', AUTH_URL);
  vi.stubEnv('PLATFORM_URL', PLATFORM_URL);
  vi.stubEnv('S3_BUCKET', BUCKET);
  vi.stubEnv('SERVICE_CLIENT_ID', 'delivery-worker');
  vi.stubEnv('SERVICE_CLIENT_SECRET', 'shh');
  vi.stubEnv('MAX_RECEIVE_COUNT', '3');
  vi.spyOn(console, 'log').mockImplementation(() => {});

  mocks.s3Send.mockReset().mockResolvedValue({ ContentLength: 2048 });
  mocks.pushTaskUpdate.mockClear();
  authReply = () => Response.json({ accessToken: TOKEN, expiresIn: 900 });
  platformReply = () => Response.json({ documentId: 'doc-123' }, { status: 201 });
  fetchMock.mockReset().mockImplementation(async (url, init) => {
    if (url === AUTH_URL) return authReply();
    if (url === `${PLATFORM_URL}/documents`) return platformReply(init ?? {});
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  ({ processRecord, handler, documentIngestBody } = await import('./handler.js'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('delivery processRecord: happy path', () => {
  it('claims the task, HEADs the staged object, ingests with a service token and marks it completed', async () => {
    const calls = setupDb();

    await processRecord(record());

    // Conditional claim: only pending / in_progress tasks can be claimed, attempt count bumps.
    const claim = calls[0];
    expect(claim.op).toBe('update');
    expect(claim.tableName).toBe('tasks');
    expect(claim.returning).toBe(true);
    expect(claim.values?.status).toBe('in_progress');
    expect(render(claim.values?.attemptCount as never).sql).toContain('"attempt_count" + 1');
    const claimWhere = render(claim.where);
    expect(claimWhere.sql).toMatch(/"tasks"\."id" = \$1 and "tasks"\."status" in \(\$2, \$3\)/);
    expect(claimWhere.params).toEqual(['task-1', 'pending', 'in_progress']);

    // Staged object is checked in the configured bucket.
    expect(mocks.s3Send).toHaveBeenCalledTimes(1);
    expect(mocks.s3Send.mock.calls[0][0].input).toEqual({ Bucket: BUCKET, Key: 'uploads/job-1/file-1/protocol.pdf' });

    // Service token is requested with the documents:ingest scope (ADR-013).
    expect(authCalls()).toHaveLength(1);
    const [, authInit] = authCalls()[0];
    expect(authInit?.method).toBe('POST');
    expect(JSON.parse(String(authInit?.body))).toEqual({
      clientId: 'delivery-worker',
      clientSecret: 'shh',
      scope: 'documents:ingest',
    });

    // Platform ingest call: JSON metadata only, bearer service token.
    expect(platformCalls()).toHaveLength(1);
    const [, init] = platformCalls()[0];
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({
      taskId: 'task-1',
      binderId: 'binder-1',
      folderId: 'folder-1',
      name: 'protocol.pdf',
      contentType: 'application/pdf',
      checksumSha256: 'a'.repeat(64),
      onBehalfOf: 'user-1',
      s3Key: 'uploads/job-1/file-1/protocol.pdf',
      sizeBytes: 2048,
    });

    // Task completed with the platform document id, then the job completion check runs.
    const writes = statusWrites(calls);
    expect(writes).toHaveLength(1);
    expect(writes[0].values).toMatchObject({ status: 'completed', platformDocumentId: 'doc-123' });
    expect(render(writes[0].where).params).toEqual(['task-1']);
    const exec = calls.find((c) => c.op === 'execute');
    expect(exec).toBeDefined();
    expect(render(exec!.sql).params).toEqual(['job-1', 'job-1']);

    // Live updates: in_progress on claim, completed at the end.
    expect(mocks.pushTaskUpdate.mock.calls.map(([u]) => u)).toEqual([
      { jobId: 'job-1', taskId: 'task-1', fileId: 'file-1', attemptCount: 1, status: 'in_progress' },
      {
        jobId: 'job-1',
        taskId: 'task-1',
        fileId: 'file-1',
        fileName: 'protocol.pdf',
        attemptCount: 1,
        status: 'completed',
      },
    ]);
  });

  it('treats 200 (task already ingested) as completed', async () => {
    const calls = setupDb();
    platformReply = () => Response.json({ documentId: 'doc-existing' }, { status: 200 });

    await processRecord(record());

    expect(statusWrites(calls)[0].values).toMatchObject({ status: 'completed', platformDocumentId: 'doc-existing' });
  });

  it('sends sizeBytes as a number even when the bigint column is large', () => {
    const body = documentIngestBody(fileRow({ sizeBytes: 1_000_000_000n }), taskRow());
    expect(body.sizeBytes).toBe(1_000_000_000);
  });

  it('reuses a cached service token until it is about to expire', async () => {
    setupDb();
    await processRecord(record());
    await processRecord(record());
    expect(authCalls()).toHaveLength(1);
    expect(platformCalls()).toHaveLength(2);
  });

  it('fetches a new service token when the cached one expires within 30s', async () => {
    setupDb();
    const shortLived = jwt({ sub: 'delivery-worker', exp: Math.floor(Date.now() / 1000) + 10 });
    authReply = () => Response.json({ accessToken: shortLived });
    await processRecord(record());
    await processRecord(record());
    expect(authCalls()).toHaveLength(2);
  });

  it('handler processes every record in the batch in order', async () => {
    setupDb();
    const event = { Records: [record('task-1'), record('task-2')] } as SQSEvent;
    await handler(event, {} as never, () => {});
    expect(platformCalls()).toHaveLength(2);
  });
});

describe('delivery processRecord: idempotency', () => {
  it('skips a task that is already terminal (claim matches no row) without touching S3 or the platform', async () => {
    const calls = setupDb({ claim: [] });

    await expect(processRecord(record())).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(mocks.s3Send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.pushTaskUpdate).not.toHaveBeenCalled();
  });

  it('re-claims an in_progress task (visibility-timeout redelivery) and delivers it', async () => {
    const calls = setupDb({ claim: [taskRow({ attemptCount: 2 })] });
    await processRecord(record('task-1', 2));
    expect(statusWrites(calls)[0].values?.status).toBe('completed');
  });
});

describe('delivery processRecord: non-retryable failures', () => {
  it('fails with FILE_NOT_UPLOADED when the staged object is missing', async () => {
    const calls = setupDb();
    mocks.s3Send.mockRejectedValue(Object.assign(new Error('NotFound'), { name: 'NotFound' }));

    await expect(processRecord(record())).resolves.toBeUndefined();

    const reason = 'FILE_NOT_UPLOADED {"fileName":"protocol.pdf","reason":"missing"}';
    expect(statusWrites(calls).map((c) => c.values)).toEqual([
      expect.objectContaining({ status: 'failed', failureReason: reason }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.pushTaskUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', failureReason: reason, taskId: 'task-1', jobId: 'job-1' }),
    );
    expect(calls.some((c) => c.op === 'execute')).toBe(true);
  });

  it('fails when the file record does not exist', async () => {
    const calls = setupDb({ file: null });
    await processRecord(record());
    expect(statusWrites(calls)[0].values).toMatchObject({
      status: 'failed',
      failureReason: 'File record file-1 not found',
    });
    expect(mocks.s3Send).not.toHaveBeenCalled();
  });

  it('fails with INVALID_DESTINATION when the task has no folder', async () => {
    const calls = setupDb({ claim: [taskRow({ folderId: null })] });
    await processRecord(record());
    expect(statusWrites(calls)[0].values?.failureReason).toBe(
      `INVALID_DESTINATION ${JSON.stringify({ fileName: 'protocol.pdf', reason: FOLDER_DESTINATION_REQUIRED })}`,
    );
    expect(mocks.s3Send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [403, null, 'NOT_AUTHORIZED_AT_DELIVERY {"fileName":"protocol.pdf"}'],
    [404, null, 'FILE_NOT_UPLOADED {"fileName":"protocol.pdf","reason":"missing"}'],
    [
      422,
      { error: { code: 'CHECKSUM_MISMATCH', message: 'sha256 differs' } },
      'CHECKSUM_MISMATCH {"fileName":"protocol.pdf","reason":"sha256 differs"}',
    ],
    [
      422,
      { error: { code: 'VALIDATION_ERROR', message: 'folder is archived' } },
      'INVALID_DESTINATION {"fileName":"protocol.pdf","reason":"folder is archived"}',
    ],
    [422, 'not json', 'INVALID_DESTINATION {"fileName":"protocol.pdf"}'],
  ])('platform %i fails the task on the first attempt without retrying', async (status, body, reason) => {
    const calls = setupDb();
    platformReply = () =>
      typeof body === 'string' ? new Response(body, { status }) : Response.json(body ?? {}, { status });

    await expect(processRecord(record('task-1', 1))).resolves.toBeUndefined();

    expect(platformCalls()).toHaveLength(1);
    expect(statusWrites(calls).map((c) => c.values)).toEqual([
      expect.objectContaining({ status: 'failed', failureReason: reason }),
    ]);
    expect(mocks.pushTaskUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', failureReason: reason }));
  });
});

describe('delivery processRecord: other platform 4xx are terminal and explain why', () => {
  it.each([
    [
      400,
      { error: { code: 'VALIDATION_ERROR', message: 'binderId must be a UUID' } },
      'DELIVERY_REJECTED {"fileName":"protocol.pdf","status":"400","code":"VALIDATION_ERROR","reason":"binderId must be a UUID"}',
    ],
    [
      409,
      { error: { code: 'CONFLICT', message: 'a document with this name already exists in the folder' } },
      'DELIVERY_REJECTED {"fileName":"protocol.pdf","status":"409","code":"CONFLICT","reason":"a document with this name already exists in the folder"}',
    ],
    [413, 'Request Entity Too Large', 'DELIVERY_REJECTED {"fileName":"protocol.pdf","status":"413","reason":"Request Entity Too Large"}'],
    [410, '', 'DELIVERY_REJECTED {"fileName":"protocol.pdf","status":"410"}'],
    [400, { unexpected: true }, 'DELIVERY_REJECTED {"fileName":"protocol.pdf","status":"400"}'],
  ])('platform %i fails the task on the first attempt with the platform error', async (status, body, reason) => {
    const calls = setupDb();
    platformReply = () =>
      typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status });

    await expect(processRecord(record('task-1', 1))).resolves.toBeUndefined();

    expect(platformCalls()).toHaveLength(1);
    expect(statusWrites(calls).map((c) => c.values)).toEqual([
      expect.objectContaining({ status: 'failed', failureReason: reason }),
    ]);
    // The dashboard gets the same reason live.
    expect(mocks.pushTaskUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ jobId: 'job-1', taskId: 'task-1', status: 'failed', failureReason: reason }),
    );
    expect(calls.some((c) => c.op === 'execute')).toBe(true);
  });

  it('a second 401 after refreshing the service token is terminal', async () => {
    const calls = setupDb();
    platformReply = () => Response.json({ error: { code: 'UNAUTHORIZED', message: 'invalid service token' } }, { status: 401 });

    await expect(processRecord(record('task-1', 1))).resolves.toBeUndefined();

    expect(platformCalls()).toHaveLength(2);
    expect(authCalls()).toHaveLength(2);
    const reason = 'DELIVERY_REJECTED {"fileName":"protocol.pdf","status":"401","code":"UNAUTHORIZED","reason":"invalid service token"}';
    expect(statusWrites(calls).map((c) => c.values)).toEqual([
      expect.objectContaining({ status: 'failed', failureReason: reason }),
    ]);
    expect(mocks.pushTaskUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', failureReason: reason }));
  });

  it('never copies tokens or signed links from the platform error into failure_reason', async () => {
    const calls = setupDb();
    platformReply = () =>
      Response.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: `bad source https://bucket.s3.amazonaws.com/k?X-Amz-Signature=abc for Bearer ${TOKEN} {x} ${'y'.repeat(400)}`,
          },
        },
        { status: 400 },
      );

    await processRecord(record());

    const reason = String(statusWrites(calls)[0].values?.failureReason);
    const values = JSON.parse(reason.replace(/^DELIVERY_REJECTED /, ''));
    expect(values.reason).toMatch(/^bad source \[link removed\] for Bearer \[redacted\] x y+$/);
    expect(values.reason.length).toBeLessThanOrEqual(180);
    expect(reason).not.toContain('X-Amz-Signature');
    expect(reason).not.toContain(TOKEN.split('.')[1]);
  });

  it('drops a platform error code that is not a plain identifier', async () => {
    const calls = setupDb();
    platformReply = () => Response.json({ error: { code: '<script>', message: 'nope' } }, { status: 400 });
    await processRecord(record());
    expect(statusWrites(calls)[0].values?.failureReason).toBe(
      'DELIVERY_REJECTED {"fileName":"protocol.pdf","status":"400","reason":"nope"}',
    );
  });
});

describe('delivery processRecord: retryable failures', () => {
  it.each([500, 502, 503])('platform %i throws so SQS redelivers (task stays in_progress)', async (status) => {
    const calls = setupDb();
    platformReply = () => new Response('upstream down', { status });

    await expect(processRecord(record('task-1', 1))).rejects.toThrow(`Platform returned ${status}: upstream down`);

    expect(statusWrites(calls)).toHaveLength(0);
    expect(mocks.pushTaskUpdate).toHaveBeenCalledTimes(1); // only the in_progress push
  });

  it('network errors are retryable', async () => {
    const calls = setupDb();
    platformReply = () => {
      throw new TypeError('fetch failed');
    };
    await expect(processRecord(record())).rejects.toThrow('fetch failed');
    expect(statusWrites(calls)).toHaveLength(0);
  });

  it('auth token endpoint failures are retryable and never reach the platform', async () => {
    const calls = setupDb();
    authReply = () => new Response('', { status: 503 });
    await expect(processRecord(record())).rejects.toThrow('Failed to get service token: 503');
    expect(platformCalls()).toHaveLength(0);
    expect(statusWrites(calls)).toHaveLength(0);
  });

  it.each([408, 429])('platform %i (timeout / throttled) is retryable', async (status) => {
    const calls = setupDb();
    platformReply = () => Response.json({ error: { code: 'TOO_MANY_REQUESTS', message: 'slow down' } }, { status });

    await expect(processRecord(record('task-1', 1))).rejects.toThrow(`Platform returned ${status}`);

    expect(platformCalls()).toHaveLength(1);
    expect(statusWrites(calls)).toHaveLength(0);
  });

  it('platform 401 drops the cached service token and retries once with a fresh one', async () => {
    const calls = setupDb();
    const fresh = jwt({ sub: 'delivery-worker', exp: Math.floor(Date.now() / 1000) + 900, jti: 'fresh' });
    // Warm the cache with TOKEN.
    await processRecord(record());
    expect(authCalls()).toHaveLength(1);

    authReply = () => Response.json({ accessToken: fresh });
    let platformHits = 0;
    platformReply = (init) => {
      platformHits += 1;
      const auth = (init.headers as Record<string, string>).Authorization;
      if (platformHits === 1) {
        expect(auth).toBe(`Bearer ${TOKEN}`);
        return Response.json({ error: { code: 'UNAUTHORIZED', message: 'token expired' } }, { status: 401 });
      }
      expect(auth).toBe(`Bearer ${fresh}`);
      return Response.json({ documentId: 'doc-after-refresh' }, { status: 201 });
    };

    await expect(processRecord(record())).resolves.toBeUndefined();

    expect(platformHits).toBe(2);
    expect(authCalls()).toHaveLength(2);
    expect(statusWrites(calls).at(-1)?.values).toMatchObject({ status: 'completed', platformDocumentId: 'doc-after-refresh' });
  });
  it('aborts the platform request after 55s and treats the timeout as retryable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const calls = setupDb();
    let started!: () => void;
    const platformStarted = new Promise<void>((r) => (started = r));
    platformReply = (init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        started();
      });

    const run = processRecord(record('task-1', 1));
    const outcome = run.then(
      () => 'resolved',
      (err: unknown) => err,
    );
    await platformStarted;
    await vi.advanceTimersByTimeAsync(54_999);
    expect(fetchMock.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const err = await outcome;
    expect((err as Error).name).toBe('AbortError');
    expect(statusWrites(calls)).toHaveLength(0);
  });
});

describe('delivery processRecord: last attempt', () => {
  it('marks the task failed with RETRIES_EXHAUSTED when ApproximateReceiveCount reaches the limit', async () => {
    const calls = setupDb();
    platformReply = () => new Response('boom', { status: 503 });

    await expect(processRecord(record('task-1', 3))).resolves.toBeUndefined();

    const reason = `RETRIES_EXHAUSTED ${JSON.stringify({
      fileName: 'protocol.pdf',
      attemptCount: '1',
      reason: 'the destination service rejected the delivery',
    })}`;
    expect(statusWrites(calls).map((c) => c.values)).toEqual([
      expect.objectContaining({ status: 'failed', failureReason: reason }),
    ]);
    expect(mocks.pushTaskUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', failureReason: reason }),
    );
    expect(calls.some((c) => c.op === 'execute')).toBe(true);
  });

  it('also treats attemptCount >= MAX_RECEIVE_COUNT as the last attempt', async () => {
    const calls = setupDb({ claim: [taskRow({ attemptCount: 3 })] });
    platformReply = () => new Response('boom', { status: 500 });
    await processRecord(record('task-1', 1));
    expect(statusWrites(calls)[0].values?.failureReason).toMatch(/^RETRIES_EXHAUSTED .*"attemptCount":"3"/);
  });

  it('honours a custom MAX_RECEIVE_COUNT', async () => {
    vi.stubEnv('MAX_RECEIVE_COUNT', '5');
    setupDb();
    platformReply = () => new Response('boom', { status: 500 });
    await expect(processRecord(record('task-1', 3))).rejects.toThrow('Platform returned 500');
  });

  it.each([
    [Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), 'the request timed out'],
    [Object.assign(new Error('timeout'), { name: 'TimeoutError' }), 'the request timed out'],
    [new RangeError('JavaScript heap out of memory'), 'the file is too large to deliver'],
    [new TypeError('fetch failed {cause}'), 'fetch failed cause'],
    [new Error(''), 'an unexpected error occurred'],
  ])('maps the last error %s to a readable reason', async (error, expected) => {
    const calls = setupDb();
    platformReply = () => {
      throw error;
    };
    await processRecord(record('task-1', 3));
    const reason = String(statusWrites(calls)[0].values?.failureReason);
    expect(JSON.parse(reason.replace(/^RETRIES_EXHAUSTED /, '')).reason).toBe(expected);
  });

  it('fails the task when the service token cannot be obtained on the last attempt', async () => {
    const calls = setupDb();
    authReply = () => new Response('', { status: 500 });
    await processRecord(record('task-1', 3));
    expect(statusWrites(calls)[0].values?.failureReason).toContain('Failed to get service token: 500');
  });
});
