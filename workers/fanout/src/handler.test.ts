import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { files } from './schema.js';
import { fakeDb, render, type DbCall } from './test-utils/fake-db.js';

const mocks = vi.hoisted(() => ({
  s3Send: vi.fn(),
  sqsSend: vi.fn(),
  db: undefined as unknown,
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mocks.s3Send;
  },
  HeadObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = mocks.sqsSend;
  },
  SendMessageBatchCommand: class {
    constructor(public input: { QueueUrl: string; Entries: { Id: string; MessageBody: string }[] }) {}
  },
}));

vi.mock('./db.js', () => ({ getDb: async () => mocks.db }));

import { handler, processRecord } from './handler.js';

const BUCKET = 'staging-test';
const TASK_QUEUE = 'http://sqs.test/000000000000/tasks';
const KEY = 'uploads/job-1/file-1/protocol.pdf';

function fileRow(overrides: Partial<typeof files.$inferSelect> = {}): typeof files.$inferSelect {
  return {
    id: 'file-1',
    ownerUserId: 'user-1',
    jobId: 'job-1',
    originalName: 'protocol.pdf',
    sizeBytes: 2048n,
    contentType: 'application/pdf',
    checksumSha256: 'a'.repeat(64),
    s3Key: KEY,
    status: 'pending',
    verificationError: null,
    uploadedAt: null,
    stagingDeadlineAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(),
    ...overrides,
  };
}

interface Scenario {
  file?: typeof files.$inferSelect | null;
  promoted?: boolean;
  pendingTaskIds?: string[];
}

function setupDb({ file = fileRow(), promoted = true, pendingTaskIds = ['task-1', 'task-2'] }: Scenario = {}) {
  const fake = fakeDb((call: DbCall) => {
    if (call.op === 'select' && call.tableName === 'files') return file ? [file] : [];
    if (call.op === 'update' && call.tableName === 'files') return call.returning && promoted ? [{ id: file?.id }] : [];
    if (call.op === 'select' && call.tableName === 'tasks') return pendingTaskIds.map((id) => ({ id }));
    return [];
  });
  mocks.db = fake.db;
  return fake.calls;
}

function s3Event(...keys: string[]): SQSRecord {
  return {
    messageId: 'm-1',
    attributes: { ApproximateReceiveCount: '1' },
    body: JSON.stringify({ Records: keys.map((key) => ({ eventName: 'ObjectCreated:Post', s3: { object: { key } } })) }),
  } as unknown as SQSRecord;
}

function sentBatches() {
  return mocks.sqsSend.mock.calls.map(([cmd]) => cmd.input as { QueueUrl: string; Entries: { Id: string; MessageBody: string }[] });
}
function sentTaskIds() {
  return sentBatches().flatMap((b) => b.Entries.map((e) => (JSON.parse(e.MessageBody) as { taskId: string }).taskId));
}

beforeEach(() => {
  vi.stubEnv('S3_BUCKET', BUCKET);
  vi.stubEnv('TASK_QUEUE_URL', TASK_QUEUE);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.s3Send.mockReset().mockResolvedValue({ ContentLength: 2048 });
  mocks.sqsSend.mockReset().mockResolvedValue({ Successful: [], Failed: [] });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('fanout: upload-complete signal', () => {
  it('promotes a verified pending file and enqueues one delivery message per pending task', async () => {
    const calls = setupDb();

    await processRecord(s3Event(KEY));

    expect(render(calls[0].where)).toMatchObject({ sql: '"files"."s3_key" = $1', params: [KEY] });
    expect(mocks.s3Send).toHaveBeenCalledTimes(1);
    expect(mocks.s3Send.mock.calls[0][0].input).toEqual({ Bucket: BUCKET, Key: KEY });

    const promote = calls.find((c) => c.op === 'update' && c.tableName === 'files')!;
    expect(promote.values).toEqual({ status: 'uploaded', uploadedAt: expect.any(Date), verificationError: null });
    expect(promote.returning).toBe(true);
    expect(render(promote.where)).toMatchObject({
      sql: '("files"."id" = $1 and "files"."status" = $2)',
      params: ['file-1', 'pending'],
    });

    const taskQuery = calls.find((c) => c.op === 'select' && c.tableName === 'tasks')!;
    expect(render(taskQuery.where).params).toEqual(['file-1', 'pending']);

    expect(sentBatches()).toEqual([
      {
        QueueUrl: TASK_QUEUE,
        Entries: [
          { Id: '0', MessageBody: JSON.stringify({ taskId: 'task-1' }) },
          { Id: '1', MessageBody: JSON.stringify({ taskId: 'task-2' }) },
        ],
      },
    ]);
  });

  it('splits more than 10 tasks into SendMessageBatch calls of at most 10, each task exactly once', async () => {
    const ids = Array.from({ length: 23 }, (_, i) => `task-${i}`);
    setupDb({ pendingTaskIds: ids });

    await processRecord(s3Event(KEY));

    expect(sentBatches().map((b) => b.Entries.length)).toEqual([10, 10, 3]);
    for (const batch of sentBatches()) {
      expect(new Set(batch.Entries.map((e) => e.Id)).size).toBe(batch.Entries.length);
    }
    expect(sentTaskIds()).toEqual(ids);
  });

  it('decodes URL-encoded S3 keys (spaces arrive as +)', async () => {
    const decoded = 'uploads/job-1/file-1/my protocol (v2).pdf';
    const calls = setupDb({ file: fileRow({ s3Key: decoded }) });

    await processRecord(s3Event('uploads/job-1/file-1/my+protocol+%28v2%29.pdf'));

    expect(render(calls[0].where).params).toEqual([decoded]);
    expect(mocks.s3Send.mock.calls[0][0].input.Key).toBe(decoded);
    expect(sentTaskIds()).toEqual(['task-1', 'task-2']);
  });

  it('accepts EventBridge-shaped events (detail.object.key)', async () => {
    setupDb();
    await processRecord({ body: JSON.stringify({ detail: { object: { key: KEY } } }) } as SQSRecord);
    expect(sentTaskIds()).toEqual(['task-1', 'task-2']);
  });

  it('handles several S3 records in one message', async () => {
    setupDb();
    await processRecord(s3Event(KEY, KEY));
    expect(mocks.s3Send).toHaveBeenCalledTimes(2);
  });

  it('handler processes every SQS record', async () => {
    setupDb();
    const event = { Records: [s3Event(KEY), s3Event(KEY)] } as SQSEvent;
    await handler(event, {} as never, () => {});
    expect(mocks.sqsSend).toHaveBeenCalledTimes(2);
  });
});

describe('fanout: nothing is enqueued unless the file is really uploaded', () => {
  it('skips events without a key', async () => {
    const calls = setupDb();
    await processRecord({ body: JSON.stringify({ Records: [{ s3: { object: {} } }] }) } as SQSRecord);
    expect(calls).toHaveLength(0);
    expect(mocks.sqsSend).not.toHaveBeenCalled();
  });

  it('skips keys with no file record', async () => {
    setupDb({ file: null });
    await processRecord(s3Event('uploads/unknown.pdf'));
    expect(mocks.s3Send).not.toHaveBeenCalled();
    expect(mocks.sqsSend).not.toHaveBeenCalled();
  });

  it.each(['uploaded', 'expired'] as const)('skips files already %s on a first delivery of the event', async (status) => {
    setupDb({ file: fileRow({ status }) });
    await processRecord(s3Event(KEY));
    expect(mocks.s3Send).not.toHaveBeenCalled();
    expect(mocks.sqsSend).not.toHaveBeenCalled();
  });

  it('does not promote or enqueue when the object cannot be HEADed', async () => {
    const calls = setupDb();
    mocks.s3Send.mockRejectedValue(Object.assign(new Error('NotFound'), { name: 'NotFound' }));

    await expect(processRecord(s3Event(KEY))).resolves.toBeUndefined();

    expect(calls.filter((c) => c.op === 'update')).toHaveLength(0);
    expect(mocks.sqsSend).not.toHaveBeenCalled();
  });

  it('records SIZE_MISMATCH on the file, leaves it pending and enqueues nothing', async () => {
    const calls = setupDb();
    mocks.s3Send.mockResolvedValue({ ContentLength: 4096 });

    await processRecord(s3Event(KEY));

    const updates = calls.filter((c) => c.op === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toEqual({
      verificationError: 'SIZE_MISMATCH {"fileName":"protocol.pdf","declaredSize":2048,"actualSize":4096}',
    });
    expect(updates[0].values).not.toHaveProperty('status');
    expect(mocks.sqsSend).not.toHaveBeenCalled();
  });

  it('enqueues nothing when another process won the promotion race', async () => {
    setupDb({ promoted: false });
    await processRecord(s3Event(KEY));
    expect(mocks.sqsSend).not.toHaveBeenCalled();
  });

  it('enqueues nothing when the file has no pending tasks', async () => {
    setupDb({ pendingTaskIds: [] });
    await processRecord(s3Event(KEY));
    expect(mocks.sqsSend).not.toHaveBeenCalled();
  });

  it('propagates SQS errors so the upload event is redelivered', async () => {
    setupDb();
    mocks.sqsSend.mockRejectedValue(new Error('SQS unavailable'));
    await expect(processRecord(s3Event(KEY))).rejects.toThrow('SQS unavailable');
  });
});

/** The same S3 event handed out again by SQS after an earlier attempt did not ack it. */
function redelivered(record: SQSRecord, receiveCount = 2): SQSRecord {
  return { ...record, attributes: { ...record.attributes, ApproximateReceiveCount: String(receiveCount) } };
}

describe('fanout: promotion clears an earlier rejection', () => {
  it('clears verification_error when promoting the file', async () => {
    const calls = setupDb({ file: fileRow({ verificationError: 'SIZE_MISMATCH {}' }) });
    await processRecord(s3Event(KEY));
    const promote = calls.find((c) => c.op === 'update' && c.returning)!;
    expect(promote.values).toEqual({ status: 'uploaded', uploadedAt: expect.any(Date), verificationError: null });
    expect(render(promote.where).params).toEqual(['file-1', 'pending']);
    expect(sentTaskIds()).toEqual(['task-1', 'task-2']);
  });
});

describe('fanout: crash mid batch (blueprint failure table)', () => {
  it('re-enqueues pending tasks when the upload event is redelivered after a failed send', async () => {
    setupDb();
    mocks.sqsSend.mockRejectedValueOnce(new Error('SQS unavailable'));
    await expect(processRecord(s3Event(KEY))).rejects.toThrow('SQS unavailable');
    mocks.sqsSend.mockClear();
    mocks.s3Send.mockClear();

    // Redelivery: the file is now 'uploaded', its tasks are still pending.
    const calls = setupDb({ file: fileRow({ status: 'uploaded', uploadedAt: new Date() }) });
    await processRecord(redelivered(s3Event(KEY)));

    expect(sentTaskIds()).toEqual(['task-1', 'task-2']);
    expect(sentBatches().map((b) => b.QueueUrl)).toEqual([TASK_QUEUE]);
    // Only still-pending tasks are re-sent; the file is neither re-verified nor re-promoted.
    const taskQuery = calls.find((c) => c.op === 'select' && c.tableName === 'tasks')!;
    expect(render(taskQuery.where).params).toEqual(['file-1', 'pending']);
    expect(mocks.s3Send).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.op === 'update')).toHaveLength(0);
  });

  it('a redelivered event for an uploaded file with no pending tasks sends nothing', async () => {
    setupDb({ file: fileRow({ status: 'uploaded', uploadedAt: new Date() }), pendingTaskIds: [] });
    await processRecord(redelivered(s3Event(KEY)));
    expect(mocks.sqsSend).not.toHaveBeenCalled();
  });

  it('a redelivered event never revives an expired file', async () => {
    setupDb({ file: fileRow({ status: 'expired' }) });
    await processRecord(redelivered(s3Event(KEY), 3));
    expect(mocks.s3Send).not.toHaveBeenCalled();
    expect(mocks.sqsSend).not.toHaveBeenCalled();
  });

  it('a redelivered event for a still-pending file goes through normal verification and promotion', async () => {
    const calls = setupDb();
    await processRecord(redelivered(s3Event(KEY)));
    expect(mocks.s3Send).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.op === 'update' && c.values?.status === 'uploaded')).toBe(true);
    expect(sentTaskIds()).toEqual(['task-1', 'task-2']);
  });
});

describe('fanout: SendMessageBatch partial failures', () => {
  it('re-sends only the failed entries and succeeds when the retry gets through', async () => {
    setupDb({ pendingTaskIds: ['task-1', 'task-2', 'task-3'] });
    mocks.sqsSend
      .mockResolvedValueOnce({ Successful: [{ Id: '0' }, { Id: '2' }], Failed: [{ Id: '1', Code: 'InternalError', SenderFault: false }] })
      .mockResolvedValueOnce({ Successful: [{ Id: '1' }], Failed: [] });

    await expect(processRecord(s3Event(KEY))).resolves.toBeUndefined();

    expect(sentBatches().map((b) => b.Entries)).toEqual([
      [
        { Id: '0', MessageBody: JSON.stringify({ taskId: 'task-1' }) },
        { Id: '1', MessageBody: JSON.stringify({ taskId: 'task-2' }) },
        { Id: '2', MessageBody: JSON.stringify({ taskId: 'task-3' }) },
      ],
      [{ Id: '1', MessageBody: JSON.stringify({ taskId: 'task-2' }) }],
    ]);
  });

  it('does not ack the event when SendMessageBatch keeps reporting failed entries', async () => {
    setupDb();
    mocks.sqsSend.mockResolvedValue({
      Successful: [{ Id: '0' }],
      Failed: [{ Id: '1', Code: 'InternalError', SenderFault: false }],
    });

    await expect(processRecord(s3Event(KEY))).rejects.toThrow(/1 task message\(s\) unsent after 3 attempts: 1:InternalError/);

    // Bounded: the first send plus two retries of just the failed entry.
    expect(sentBatches().map((b) => b.Entries.map((e) => e.Id))).toEqual([['0', '1'], ['1'], ['1']]);
  });

  it('the redelivery after a partial failure re-sends the tasks that are still pending', async () => {
    setupDb();
    mocks.sqsSend.mockResolvedValue({ Successful: [{ Id: '0' }], Failed: [{ Id: '1', Code: 'InternalError' }] });
    await expect(processRecord(s3Event(KEY))).rejects.toThrow();

    mocks.sqsSend.mockReset().mockResolvedValue({ Successful: [], Failed: [] });
    setupDb({ file: fileRow({ status: 'uploaded', uploadedAt: new Date() }) });
    await processRecord(redelivered(s3Event(KEY)));

    expect(sentTaskIds()).toEqual(['task-1', 'task-2']);
  });
});
