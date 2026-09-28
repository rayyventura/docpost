import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, render, type DbCall } from './test-utils/fake-db.js';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  clientConfigs: [] as unknown[],
  db: undefined as unknown,
}));

vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: class {
    send = mocks.send;
    constructor(config: unknown) {
      mocks.clientConfigs.push(config);
    }
  },
  PostToConnectionCommand: class {
    constructor(public input: { ConnectionId: string; Data: Uint8Array }) {}
  },
}));

vi.mock('./db.js', () => ({ getDb: async () => mocks.db }));

import { pushTaskUpdate } from './notify.js';

const CALLBACK = 'https://ws.example.test/prod';

function setupDb(connections: string[] = ['conn-a', 'conn-b']) {
  const fake = fakeDb((call: DbCall) => {
    if (call.op === 'select' && call.tableName === 'tasks') {
      return [
        { status: 'pending', count: 1 },
        { status: 'in_progress', count: 1 },
        { status: 'completed', count: 2 },
        { status: 'failed', count: 1 },
      ];
    }
    if (call.op === 'select' && call.tableName === 'ws_connections') {
      return connections.map((connectionId) => ({ connectionId }));
    }
    return [];
  });
  mocks.db = fake.db;
  return fake.calls;
}

function sentMessages() {
  return mocks.send.mock.calls.map(([cmd]) => ({
    connectionId: cmd.input.ConnectionId as string,
    message: JSON.parse(Buffer.from(cmd.input.Data).toString()) as Record<string, unknown>,
  }));
}

function gone() {
  return Object.assign(new Error('GoneException'), { name: 'GoneException', $metadata: { httpStatusCode: 410 } });
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.send.mockReset().mockResolvedValue({});
  mocks.clientConfigs.length = 0;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pushTaskUpdate via API Gateway management API', () => {
  beforeEach(() => vi.stubEnv('WS_CALLBACK_URL', CALLBACK));

  it('posts a task_update with counts to every connection subscribed to the job', async () => {
    const calls = setupDb();

    await pushTaskUpdate({
      jobId: 'job-1',
      taskId: 'task-1',
      fileId: 'file-1',
      fileName: 'protocol.pdf',
      attemptCount: 2,
      status: 'failed',
      failureReason: 'FILE_NOT_UPLOADED {"fileName":"protocol.pdf","reason":"missing"}',
    });

    expect(mocks.clientConfigs).toEqual([{ endpoint: CALLBACK }]);
    const sent = sentMessages();
    expect(sent.map((s) => s.connectionId)).toEqual(['conn-a', 'conn-b']);
    for (const { message } of sent) {
      expect(message).toEqual({
        type: 'task_update',
        jobId: 'job-1',
        taskId: 'task-1',
        fileId: 'file-1',
        fileName: 'protocol.pdf',
        attemptCount: 2,
        status: 'failed',
        failureReason: 'FILE_NOT_UPLOADED {"fileName":"protocol.pdf","reason":"missing"}',
        counts: { pending: 1, in_progress: 1, completed: 2, failed: 1 },
      });
    }

    // Both lookups are scoped to the job.
    const selects = calls.filter((c) => c.op === 'select');
    expect(selects.map((c) => c.tableName).sort()).toEqual(['tasks', 'ws_connections']);
    for (const select of selects) expect(render(select.where).params).toEqual(['job-1']);
  });

  it('omits failureReason when there is none', async () => {
    setupDb(['conn-a']);
    await pushTaskUpdate({ jobId: 'job-1', taskId: 'task-1', status: 'completed', failureReason: null });
    const [{ message }] = sentMessages();
    expect(message).toMatchObject({ type: 'task_update', jobId: 'job-1', taskId: 'task-1', status: 'completed' });
    expect(message).not.toHaveProperty('failureReason');
  });

  it('defaults missing status buckets to zero and ignores unknown statuses', async () => {
    const fake = fakeDb((call) => {
      if (call.tableName === 'tasks') return [{ status: 'completed', count: 3 }, { status: 'bogus', count: 7 }];
      if (call.tableName === 'ws_connections') return [{ connectionId: 'conn-a' }];
      return [];
    });
    mocks.db = fake.db;
    await pushTaskUpdate({ jobId: 'job-1', taskId: 'task-1', status: 'completed' });
    expect(sentMessages()[0].message.counts).toEqual({ pending: 0, in_progress: 0, completed: 3, failed: 0 });
  });

  it('deletes connections that API Gateway reports as gone (410) and still pushes to the rest', async () => {
    const calls = setupDb(['conn-gone', 'conn-live']);
    mocks.send.mockImplementation(async (cmd: { input: { ConnectionId: string } }) => {
      if (cmd.input.ConnectionId === 'conn-gone') throw gone();
      return {};
    });

    await expect(pushTaskUpdate({ jobId: 'job-1', taskId: 'task-1', status: 'completed' })).resolves.toBeUndefined();

    const deletes = calls.filter((c) => c.op === 'delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].tableName).toBe('ws_connections');
    expect(render(deletes[0].where).params).toEqual(['conn-gone']);
    expect(sentMessages().map((s) => s.connectionId)).toEqual(['conn-gone', 'conn-live']);
  });

  it('logs and swallows other push errors without deleting the connection', async () => {
    const calls = setupDb(['conn-a']);
    mocks.send.mockRejectedValue(
      Object.assign(new Error('throttled'), { $metadata: { httpStatusCode: 429 } }),
    );

    await expect(pushTaskUpdate({ jobId: 'job-1', taskId: 'task-1', status: 'completed' })).resolves.toBeUndefined();

    expect(calls.filter((c) => c.op === 'delete')).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith('Push failed:', expect.any(Error));
  });

  it('does nothing when nobody is subscribed', async () => {
    setupDb([]);
    await pushTaskUpdate({ jobId: 'job-1', taskId: 'task-1', status: 'completed' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('never throws when the database is unavailable (push is non-fatal)', async () => {
    mocks.db = {
      select: () => {
        throw new Error('connection refused');
      },
    };
    await expect(pushTaskUpdate({ jobId: 'job-1', taskId: 'task-1', status: 'completed' })).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('pushTaskUpdate via local WS_PUSH_URL', () => {
  it('POSTs the message to the dev push endpoint when no callback URL is configured', async () => {
    vi.stubEnv('WS_CALLBACK_URL', '');
    delete process.env.WS_CALLBACK_URL;
    vi.stubEnv('WS_PUSH_URL', 'http://localhost:3004/push');
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    setupDb(['conn-a']);

    await pushTaskUpdate({ jobId: 'job-1', taskId: 'task-1', status: 'in_progress' });

    expect(mocks.send).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:3004/push');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      type: 'task_update',
      jobId: 'job-1',
      taskId: 'task-1',
      status: 'in_progress',
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when neither WS_CALLBACK_URL nor WS_PUSH_URL is set', async () => {
    vi.stubEnv('WS_CALLBACK_URL', '');
    vi.stubEnv('WS_PUSH_URL', '');
    delete process.env.WS_CALLBACK_URL;
    delete process.env.WS_PUSH_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setupDb(['conn-a']);

    await pushTaskUpdate({ jobId: 'job-1', taskId: 'task-1', status: 'in_progress' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
