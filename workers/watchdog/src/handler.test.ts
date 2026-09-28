import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { files, jobs } from './schema.js';
import { fakeDb, render, type DbCall } from './test-utils/fake-db.js';

const mocks = vi.hoisted(() => ({
  s3Send: vi.fn(),
  sqsSend: vi.fn(),
  pushTaskUpdates: vi.fn(async (_jobId: string, _updates: unknown[]) => {}),
  db: undefined as unknown,
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mocks.s3Send;
  },
  HeadObjectCommand: class {
    constructor(public input: { Bucket: string; Key: string }) {}
  },
}));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = mocks.sqsSend;
  },
  SendMessageBatchCommand: class {
    kind = 'batch';
    constructor(public input: { QueueUrl: string; Entries: { Id: string; MessageBody: string }[] }) {}
  },
  SendMessageCommand: class {
    kind = 'single';
    constructor(public input: { QueueUrl: string; MessageBody: string; DelaySeconds: number }) {}
  },
}));

vi.mock('./db.js', () => ({ getDb: async () => mocks.db }));
vi.mock('./notify.js', () => ({ pushTaskUpdates: mocks.pushTaskUpdates }));

import { handler, processRecord } from './handler.js';

const BUCKET = 'staging-test';
const TASK_QUEUE = 'http://sqs.test/000000000000/tasks';
const JOB_QUEUE = 'http://sqs.test/000000000000/jobs';
const HOUR = 3_600_000;

type Job = typeof jobs.$inferSelect;
type FileRow = typeof files.$inferSelect;

function jobRow(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    submittedByUserId: 'user-1',
    taskCount: 2,
    nextCheckAt: new Date(Date.now() - 1000),
    completedAt: null,
    createdAt: new Date(Date.now() - HOUR),
    ...overrides,
  };
}

function fileRow(id: string, overrides: Partial<FileRow> = {}): FileRow {
  return {
    id,
    ownerUserId: 'user-1',
    jobId: 'job-1',
    originalName: `${id}.pdf`,
    sizeBytes: 2048n,
    contentType: 'application/pdf',
    checksumSha256: 'a'.repeat(64),
    s3Key: `uploads/job-1/${id}/${id}.pdf`,
    status: 'pending',
    verificationError: null,
    uploadedAt: null,
    stagingDeadlineAt: new Date(Date.now() - 1000), // past deadline by default
    createdAt: new Date(Date.now() - HOUR),
    ...overrides,
  };
}

interface Scenario {
  job?: Job | null;
  /** The job as re-read after the completion check. */
  jobAfter?: Job | null;
  pendingFiles?: FileRow[];
  /** Files of the job already 'uploaded' (only looked up on a redelivered watchdog message). */
  uploadedFiles?: string[];
  /** Keys that exist in S3 (HEAD succeeds). */
  stored?: Record<string, number>;
  promoted?: boolean;
  pendingTasks?: string[];
  stuck?: { id: string; attemptCount: number; fileName: string }[];
  rearmWins?: boolean;
}

function setup(s: Scenario = {}) {
  const job = s.job === undefined ? jobRow() : s.job;
  const jobAfter = s.jobAfter === undefined ? job : s.jobAfter;
  let jobSelects = 0;
  const fake = fakeDb((call: DbCall) => {
    if (call.op === 'select' && call.tableName === 'jobs') {
      jobSelects += 1;
      const row = jobSelects === 1 ? job : jobAfter;
      return row ? [row] : [];
    }
    if (call.op === 'select' && call.tableName === 'files') {
      if (render(call.where).params.includes('uploaded')) return (s.uploadedFiles ?? []).map((id) => ({ id }));
      return s.pendingFiles ?? [];
    }
    if (call.op === 'update' && call.tableName === 'files') return call.returning && (s.promoted ?? true) ? [{ id: 'x' }] : [];
    if (call.op === 'select' && call.tableName === 'tasks' && call.join) return s.stuck ?? [];
    if (call.op === 'select' && call.tableName === 'tasks') return (s.pendingTasks ?? []).map((id) => ({ id }));
    if (call.op === 'update' && call.tableName === 'tasks') {
      if (!call.returning) return [];
      // Deadline failure returns this file's pending tasks; exhausted-retry failure returns the one task.
      const params = render(call.where).params;
      return params.length === 2 ? (s.pendingTasks ?? []).map((id) => ({ id, attemptCount: 0 })) : [{ id: params[0] }];
    }
    if (call.op === 'update' && call.tableName === 'jobs') return (s.rearmWins ?? true) ? [{ id: job?.id }] : [];
    return [];
  });
  mocks.db = fake.db;
  mocks.s3Send.mockImplementation(async (cmd: { input: { Key: string } }) => {
    const size = s.stored?.[cmd.input.Key];
    if (size === undefined) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
    return { ContentLength: size };
  });
  return fake.calls;
}

function watchdogMessage(jobId = 'job-1', receiveCount = 1): SQSRecord {
  return {
    messageId: 'm',
    attributes: { ApproximateReceiveCount: String(receiveCount) },
    body: JSON.stringify({ jobId }),
  } as unknown as SQSRecord;
}

const updates = (calls: DbCall[], table: string) => calls.filter((c) => c.op === 'update' && c.tableName === table);
const batchSends = (): { QueueUrl: string; Entries: { Id: string; MessageBody: string }[] }[] =>
  mocks.sqsSend.mock.calls.map(([c]) => c).filter((c) => c.kind === 'batch').map((c) => c.input);
const pushed = () => mocks.pushTaskUpdates.mock.calls.flatMap(([jobId, list]) => (list as object[]).map((u) => ({ jobId, ...u })));
const rearmSends = () =>
  mocks.sqsSend.mock.calls.map(([c]) => c).filter((c) => c.kind === 'single').map((c) => c.input);

beforeEach(() => {
  vi.stubEnv('S3_BUCKET', BUCKET);
  vi.stubEnv('TASK_QUEUE_URL', TASK_QUEUE);
  vi.stubEnv('JOB_QUEUE_URL', JOB_QUEUE);
  vi.stubEnv('MAX_RECEIVE_COUNT', '3');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.s3Send.mockReset();
  mocks.sqsSend.mockReset().mockResolvedValue({});
  mocks.pushTaskUpdates.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('watchdog: guards', () => {
  it('skips unknown jobs', async () => {
    const calls = setup({ job: null });
    await processRecord(watchdogMessage());
    expect(calls).toHaveLength(1);
    expect(mocks.sqsSend).not.toHaveBeenCalled();
  });

  it('skips jobs that are already complete (and does not re-arm)', async () => {
    const calls = setup({ job: jobRow({ completedAt: new Date() }) });
    await processRecord(watchdogMessage());
    expect(calls).toHaveLength(1);
    expect(mocks.sqsSend).not.toHaveBeenCalled();
  });

  it('only looks at pending files of this job', async () => {
    const calls = setup();
    await processRecord(watchdogMessage());
    const fileQuery = calls.find((c) => c.op === 'select' && c.tableName === 'files')!;
    expect(render(fileQuery.where).params).toEqual(['job-1', 'pending']);
  });
});

describe('watchdog: staging deadline', () => {
  it('expires a missing file past its deadline and fails its pending tasks with FILE_NOT_UPLOADED', async () => {
    const late = fileRow('file-late');
    const calls = setup({ pendingFiles: [late] });

    await processRecord(watchdogMessage());

    expect(mocks.s3Send.mock.calls[0][0].input).toEqual({ Bucket: BUCKET, Key: late.s3Key });
    const [expire] = updates(calls, 'files');
    expect(expire.values).toEqual({ status: 'expired' });
    expect(render(expire.where).params).toEqual(['file-late']);

    const [failTasks] = updates(calls, 'tasks');
    expect(failTasks.values).toEqual({
      status: 'failed',
      failureReason: 'FILE_NOT_UPLOADED {"fileName":"file-late.pdf","reason":"deadline"}',
      updatedAt: expect.any(Date),
    });
    // Only this file's *pending* tasks: in-flight or finished tasks are left alone.
    expect(render(failTasks.where)).toMatchObject({
      sql: '("tasks"."file_id" = $1 and "tasks"."status" = $2)',
      params: ['file-late', 'pending'],
    });
    expect(batchSends()).toHaveLength(0);
  });

  it('leaves a missing file alone while its deadline has not passed', async () => {
    const calls = setup({ pendingFiles: [fileRow('file-early', { stagingDeadlineAt: new Date(Date.now() + HOUR) })] });

    await processRecord(watchdogMessage());

    expect(updates(calls, 'files')).toHaveLength(0);
    expect(updates(calls, 'tasks')).toHaveLength(0);
    expect(rearmSends()).toHaveLength(1);
  });

  it('handles a mix: expires the late one, promotes the stored one, ignores the early one', async () => {
    const late = fileRow('file-late');
    const early = fileRow('file-early', { stagingDeadlineAt: new Date(Date.now() + HOUR) });
    const stored = fileRow('file-stored');
    const calls = setup({
      pendingFiles: [late, early, stored],
      stored: { [stored.s3Key]: 2048 },
      pendingTasks: ['task-a', 'task-b'],
    });

    await processRecord(watchdogMessage());

    const fileUpdates = updates(calls, 'files').map((u) => ({ id: render(u.where).params[0], values: u.values }));
    expect(fileUpdates).toEqual([
      { id: 'file-late', values: { status: 'expired' } },
      { id: 'file-stored', values: { status: 'uploaded', uploadedAt: expect.any(Date), verificationError: null } },
    ]);
    expect(updates(calls, 'tasks').map((u) => render(u.where).params[0])).toEqual(['file-late']);
  });
});

describe('watchdog: late promotion (lost S3 event)', () => {
  it('promotes a stored pending file and enqueues its pending tasks in batches of 10', async () => {
    const f = fileRow('file-1', { stagingDeadlineAt: new Date(Date.now() + HOUR) });
    const ids = Array.from({ length: 12 }, (_, i) => `task-${i}`);
    const calls = setup({ pendingFiles: [f], stored: { [f.s3Key]: 2048 }, pendingTasks: ids });

    await processRecord(watchdogMessage());

    const [promote] = updates(calls, 'files');
    expect(promote.returning).toBe(true);
    expect(render(promote.where).params).toEqual(['file-1', 'pending']);
    expect(batchSends().map((b) => b.QueueUrl)).toEqual([TASK_QUEUE, TASK_QUEUE]);
    expect(batchSends().map((b) => b.Entries.length)).toEqual([10, 2]);
    expect(batchSends().flatMap((b) => b.Entries.map((e) => JSON.parse(e.MessageBody).taskId))).toEqual(ids);
  });

  it('does not enqueue when fan-out already promoted the file (race lost)', async () => {
    const f = fileRow('file-1');
    setup({ pendingFiles: [f], stored: { [f.s3Key]: 2048 }, promoted: false, pendingTasks: ['t'] });
    await processRecord(watchdogMessage());
    expect(batchSends()).toHaveLength(0);
  });
});

describe('watchdog: exhausted retries', () => {
  it('fails pending/in_progress tasks that reached MAX_RECEIVE_COUNT attempts', async () => {
    const calls = setup({ stuck: [{ id: 'task-stuck', attemptCount: 3, fileName: 'protocol.pdf' }] });

    await processRecord(watchdogMessage());

    const stuckQuery = calls.find((c) => c.op === 'select' && c.join)!;
    expect(render(stuckQuery.where)).toMatchObject({
      sql: '("tasks"."job_id" = $1 and "tasks"."status" in ($2, $3) and "tasks"."attempt_count" >= $4)',
      params: ['job-1', 'pending', 'in_progress', 3],
    });
    const [fail] = updates(calls, 'tasks');
    expect(fail.values).toEqual({
      status: 'failed',
      failureReason: `RETRIES_EXHAUSTED ${JSON.stringify({
        fileName: 'protocol.pdf',
        attemptCount: '3',
        reason: 'the delivery worker stopped after the maximum number of retries',
      })}`,
      updatedAt: expect.any(Date),
    });
    expect(render(fail.where).params).toEqual(['task-stuck', 'pending', 'in_progress']);
  });

  it('honours MAX_RECEIVE_COUNT', async () => {
    vi.stubEnv('MAX_RECEIVE_COUNT', '5');
    const calls = setup();
    await processRecord(watchdogMessage());
    expect(render(calls.find((c) => c.join)!.where).params.at(-1)).toBe(5);
  });
});

describe('watchdog: completion and re-arm', () => {
  it('runs the job completion check and stops when the job became complete', async () => {
    const calls = setup({ jobAfter: jobRow({ completedAt: new Date() }) });

    await processRecord(watchdogMessage());

    const exec = calls.find((c) => c.op === 'execute')!;
    expect(render(exec.sql).sql).toMatch(/UPDATE jobs SET completed_at = now\(\)/);
    expect(render(exec.sql).sql).toMatch(/status IN \('pending', 'in_progress'\)/);
    expect(updates(calls, 'jobs')).toHaveLength(0);
    expect(rearmSends()).toHaveLength(0);
  });

  it('re-arms itself with a 60s delayed message guarded by next_check_at', async () => {
    const previous = new Date('2026-01-01T00:00:00.000Z');
    const calls = setup({ job: jobRow({ nextCheckAt: previous }) });
    const before = Date.now();

    await processRecord(watchdogMessage());

    const [rearm] = updates(calls, 'jobs');
    const next = (rearm.values?.nextCheckAt as Date).getTime();
    expect(next - before).toBeGreaterThanOrEqual(60_000);
    expect(next - before).toBeLessThan(65_000);
    expect(render(rearm.where).params).toEqual(['job-1', previous]);
    expect(rearmSends()).toEqual([{ QueueUrl: JOB_QUEUE, MessageBody: JSON.stringify({ jobId: 'job-1' }), DelaySeconds: 60 }]);
  });

  it('does not send a second watchdog message when another invocation already re-armed', async () => {
    setup({ rearmWins: false });
    await processRecord(watchdogMessage());
    expect(rearmSends()).toHaveLength(0);
  });

  it('handler processes every record', async () => {
    setup({ job: null });
    await handler({ Records: [watchdogMessage('a'), watchdogMessage('b')] } as SQSEvent, {} as never, () => {});
    expect(console.log).toHaveBeenCalledWith('Job a not found, skipping');
    expect(console.log).toHaveBeenCalledWith('Job b not found, skipping');
  });
});

describe('watchdog: size verification (same check as fan-out)', () => {
  const MISMATCH = 'SIZE_MISMATCH {"fileName":"file-1.pdf","declaredSize":2048,"actualSize":4096}';

  it('does not promote a stored file that failed verification', async () => {
    const f = fileRow('file-1', { stagingDeadlineAt: new Date(Date.now() + HOUR), verificationError: MISMATCH });
    const calls = setup({ pendingFiles: [f], stored: { [f.s3Key]: 4096 }, pendingTasks: ['task-1'] });

    await processRecord(watchdogMessage());

    // Already recorded by fan-out: nothing to write, nothing promoted, nothing enqueued, nothing failed yet.
    expect(updates(calls, 'files')).toHaveLength(0);
    expect(updates(calls, 'tasks')).toHaveLength(0);
    expect(batchSends()).toHaveLength(0);
    expect(rearmSends()).toHaveLength(1);
  });

  it('records SIZE_MISMATCH itself when fan-out never saw the upload, and still does not promote', async () => {
    const f = fileRow('file-1', { stagingDeadlineAt: new Date(Date.now() + HOUR) });
    const calls = setup({ pendingFiles: [f], stored: { [f.s3Key]: 4096 }, pendingTasks: ['task-1'] });

    await processRecord(watchdogMessage());

    const fileUpdates = updates(calls, 'files');
    expect(fileUpdates.map((u) => u.values)).toEqual([{ verificationError: MISMATCH }]);
    expect(render(fileUpdates[0].where).params).toEqual(['file-1', 'pending']);
    expect(batchSends()).toHaveLength(0);
  });

  it('promotes a stored file whose size now matches and clears the earlier verification error', async () => {
    const f = fileRow('file-1', { stagingDeadlineAt: new Date(Date.now() + HOUR), verificationError: MISMATCH });
    const calls = setup({ pendingFiles: [f], stored: { [f.s3Key]: 2048 }, pendingTasks: ['task-1'] });

    await processRecord(watchdogMessage());

    expect(updates(calls, 'files').map((u) => u.values)).toEqual([
      { status: 'uploaded', uploadedAt: expect.any(Date), verificationError: null },
    ]);
    expect(batchSends().flatMap((b) => b.Entries.map((e) => JSON.parse(e.MessageBody).taskId))).toEqual(['task-1']);
  });
});

describe('watchdog: failure reason at the deadline', () => {
  it('fails tasks with the verification error text when the file was rejected', async () => {
    const reason = 'SIZE_MISMATCH {"fileName":"file-1.pdf","declaredSize":2048,"actualSize":4096}';
    const f = fileRow('file-1', { verificationError: reason });
    const calls = setup({ pendingFiles: [f], pendingTasks: ['task-1'] });

    await processRecord(watchdogMessage());

    expect(updates(calls, 'files').map((u) => u.values)).toEqual([{ status: 'expired' }]);
    const [failTasks] = updates(calls, 'tasks');
    expect(failTasks.values).toEqual({ status: 'failed', failureReason: reason, updatedAt: expect.any(Date) });
    expect(render(failTasks.where).params).toEqual(['file-1', 'pending']);
  });

  it('a mismatched object still in storage at the deadline expires the file with the mismatch reason', async () => {
    const f = fileRow('file-1');
    const calls = setup({ pendingFiles: [f], stored: { [f.s3Key]: 10 }, pendingTasks: ['task-1'] });

    await processRecord(watchdogMessage());

    const reason = 'SIZE_MISMATCH {"fileName":"file-1.pdf","declaredSize":2048,"actualSize":10}';
    expect(updates(calls, 'files').map((u) => u.values)).toEqual([{ verificationError: reason }, { status: 'expired' }]);
    expect(updates(calls, 'tasks')[0].values?.failureReason).toBe(reason);
    expect(batchSends()).toHaveLength(0);
  });

  it('falls back to FILE_NOT_UPLOADED when there is no verification error', async () => {
    const calls = setup({ pendingFiles: [fileRow('file-1')] });
    await processRecord(watchdogMessage());
    expect(updates(calls, 'tasks')[0].values?.failureReason).toBe(
      'FILE_NOT_UPLOADED {"fileName":"file-1.pdf","reason":"deadline"}',
    );
  });
});

describe('watchdog: live task_update pushes', () => {
  it('pushes a failed task_update for every task failed at the deadline', async () => {
    setup({ pendingFiles: [fileRow('file-late')], pendingTasks: ['task-a', 'task-b'] });

    await processRecord(watchdogMessage());

    const reason = 'FILE_NOT_UPLOADED {"fileName":"file-late.pdf","reason":"deadline"}';
    expect(pushed()).toEqual(
      ['task-a', 'task-b'].map((taskId) => ({
        jobId: 'job-1',
        taskId,
        fileId: 'file-late',
        fileName: 'file-late.pdf',
        attemptCount: 0,
        status: 'failed',
        failureReason: reason,
      })),
    );
  });

  it('pushes a failed task_update for tasks failed with RETRIES_EXHAUSTED', async () => {
    setup({ stuck: [{ id: 'task-stuck', attemptCount: 3, fileName: 'protocol.pdf', fileId: 'file-9' } as never] });

    await processRecord(watchdogMessage());

    expect(pushed()).toEqual([
      {
        jobId: 'job-1',
        taskId: 'task-stuck',
        fileId: 'file-9',
        fileName: 'protocol.pdf',
        attemptCount: 3,
        status: 'failed',
        failureReason: expect.stringMatching(/^RETRIES_EXHAUSTED /),
      },
    ]);
  });

  it('pushes nothing when no task changed status', async () => {
    const f = fileRow('file-1', { stagingDeadlineAt: new Date(Date.now() + HOUR) });
    setup({ pendingFiles: [f], stored: { [f.s3Key]: 2048 }, pendingTasks: ['task-1'] });
    await processRecord(watchdogMessage());
    expect(pushed()).toEqual([]);
  });

  it('pushes before the completion check and re-arm', async () => {
    const calls = setup({ pendingFiles: [fileRow('file-late')], pendingTasks: ['task-a'] });
    let callsAtPush = -1;
    mocks.pushTaskUpdates.mockImplementationOnce(async () => {
      callsAtPush = calls.length;
    });
    await processRecord(watchdogMessage());
    expect(calls.slice(callsAtPush).some((c) => c.op === 'execute')).toBe(true);
  });
});

describe('watchdog: recovering tasks stranded on uploaded files', () => {
  it('on a redelivered message, re-enqueues pending tasks of the job\'s uploaded files', async () => {
    const calls = setup({ uploadedFiles: ['file-up'], pendingTasks: ['task-1', 'task-2'] });

    await processRecord(watchdogMessage('job-1', 2));

    const uploadedQuery = calls.find((c) => c.op === 'select' && c.tableName === 'files' && render(c.where).params.includes('uploaded'))!;
    expect(render(uploadedQuery.where).params).toEqual(['job-1', 'uploaded']);
    const taskQuery = calls.find((c) => c.op === 'select' && c.tableName === 'tasks' && !c.join)!;
    expect(render(taskQuery.where)).toMatchObject({
      sql: '("tasks"."file_id" in ($1) and "tasks"."status" = $2)',
      params: ['file-up', 'pending'],
    });
    expect(batchSends().flatMap((b) => b.Entries.map((e) => JSON.parse(e.MessageBody).taskId))).toEqual(['task-1', 'task-2']);
  });

  it('does not look at uploaded files on a first delivery', async () => {
    const calls = setup({ uploadedFiles: ['file-up'], pendingTasks: ['task-1'] });
    await processRecord(watchdogMessage('job-1', 1));
    expect(calls.some((c) => c.op === 'select' && c.tableName === 'files' && render(c.where).params.includes('uploaded'))).toBe(false);
    expect(batchSends()).toHaveLength(0);
  });

  it('throws (so the message is redelivered) when SendMessageBatch keeps reporting failed entries', async () => {
    const f = fileRow('file-1', { stagingDeadlineAt: new Date(Date.now() + HOUR) });
    setup({ pendingFiles: [f], stored: { [f.s3Key]: 2048 }, pendingTasks: ['task-1', 'task-2'] });
    mocks.sqsSend.mockImplementation(async (cmd: { kind: string; input: { Entries?: { Id: string }[] } }) =>
      cmd.kind === 'batch' ? { Failed: [{ Id: cmd.input.Entries!.at(-1)!.Id, Code: 'InternalError' }] } : {},
    );

    await expect(processRecord(watchdogMessage())).rejects.toThrow(/unsent after 3 attempts/);
    expect(batchSends().map((b) => b.Entries.length)).toEqual([2, 1, 1]);
    expect(rearmSends()).toHaveLength(0);
  });
});
