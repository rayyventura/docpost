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

import { pushTaskUpdates } from './notify.js';

const CALLBACK = 'https://ws.example.test/prod';
const DEADLINE = 'FILE_NOT_UPLOADED {"fileName":"scan.pdf","reason":"deadline"}';

const failedAtDeadline = (taskId: string) => ({
  taskId,
  fileId: 'file-1',
  fileName: 'scan.pdf',
  attemptCount: 0,
  status: 'failed',
  failureReason: DEADLINE,
});

function setupDb(connections: string[] = ['conn-a', 'conn-b']) {
  const fake = fakeDb((call: DbCall) => {
    if (call.op === 'select' && call.tableName === 'tasks') {
      return [
        { status: 'pending', count: 1 },
        { status: 'completed', count: 2 },
        { status: 'failed', count: 2 },
        { status: 'bogus', count: 9 },
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

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.send.mockReset().mockResolvedValue({});
  mocks.clientConfigs.length = 0;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('watchdog pushTaskUpdates via API Gateway management API', () => {
  beforeEach(() => vi.stubEnv('WS_CALLBACK_URL', CALLBACK));

  it('posts one task_update per changed task, with job counts, to every subscribed connection', async () => {
    const calls = setupDb();

    await pushTaskUpdates('job-1', [failedAtDeadline('task-1'), failedAtDeadline('task-2')]);

    expect(mocks.clientConfigs).toEqual([{ endpoint: CALLBACK }]);
    const sent = sentMessages();
    expect(sent.map((s) => [s.connectionId, s.message.taskId]).sort()).toEqual([
      ['conn-a', 'task-1'],
      ['conn-a', 'task-2'],
      ['conn-b', 'task-1'],
      ['conn-b', 'task-2'],
    ]);
    // Same shape the delivery worker pushes.
    expect(sent[0].message).toEqual({
      type: 'task_update',
      jobId: 'job-1',
      taskId: 'task-1',
      fileId: 'file-1',
      fileName: 'scan.pdf',
      attemptCount: 0,
      status: 'failed',
      failureReason: DEADLINE,
      counts: { pending: 1, in_progress: 0, completed: 2, failed: 2 },
    });

    // One counts query and one connection lookup for the whole batch, both scoped to the job.
    const selects = calls.filter((c) => c.op === 'select');
    expect(selects.map((c) => c.tableName).sort()).toEqual(['tasks', 'ws_connections']);
    for (const select of selects) expect(render(select.where).params).toEqual(['job-1']);
  });

  it('deletes a connection API Gateway reports as gone (410), stops pushing to it, and keeps pushing to the rest', async () => {
    const calls = setupDb(['conn-gone', 'conn-live']);
    mocks.send.mockImplementation(async (cmd: { input: { ConnectionId: string } }) => {
      if (cmd.input.ConnectionId === 'conn-gone') {
        throw Object.assign(new Error('GoneException'), { $metadata: { httpStatusCode: 410 } });
      }
      return {};
    });

    await expect(pushTaskUpdates('job-1', [failedAtDeadline('task-1'), failedAtDeadline('task-2')])).resolves.toBeUndefined();

    const deletes = calls.filter((c) => c.op === 'delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].tableName).toBe('ws_connections');
    expect(render(deletes[0].where).params).toEqual(['conn-gone']);
    expect(sentMessages().filter((s) => s.connectionId === 'conn-gone')).toHaveLength(1);
    expect(sentMessages().filter((s) => s.connectionId === 'conn-live')).toHaveLength(2);
  });

  it('logs and swallows other push errors', async () => {
    const calls = setupDb(['conn-a']);
    mocks.send.mockRejectedValue(Object.assign(new Error('throttled'), { $metadata: { httpStatusCode: 429 } }));

    await expect(pushTaskUpdates('job-1', [failedAtDeadline('task-1')])).resolves.toBeUndefined();

    expect(calls.filter((c) => c.op === 'delete')).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith('Push failed:', expect.any(Error));
  });

  it('never throws when the database is unavailable', async () => {
    mocks.db = {
      select: () => {
        throw new Error('connection refused');
      },
    };
    await expect(pushTaskUpdates('job-1', [failedAtDeadline('task-1')])).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('Push failed:', expect.any(Error));
  });

  it('does nothing (no queries) when there are no updates', async () => {
    const calls = setupDb();
    await pushTaskUpdates('job-1', []);
    expect(calls).toHaveLength(0);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('sends nothing when nobody is subscribed', async () => {
    setupDb([]);
    await pushTaskUpdates('job-1', [failedAtDeadline('task-1')]);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe('watchdog pushTaskUpdates without an API Gateway endpoint', () => {
  beforeEach(() => {
    vi.stubEnv('WS_CALLBACK_URL', '');
    delete process.env.WS_CALLBACK_URL;
  });

  it('POSTs each message to WS_PUSH_URL in local development', async () => {
    vi.stubEnv('WS_PUSH_URL', 'http://localhost:3004/push');
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    setupDb(['conn-a']);

    await pushTaskUpdates('job-1', [failedAtDeadline('task-1'), failedAtDeadline('task-2')]);

    expect(mocks.send).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)));
    expect(bodies.map((b) => b.taskId)).toEqual(['task-1', 'task-2']);
    expect(bodies[0]).toMatchObject({ type: 'task_update', jobId: 'job-1', status: 'failed', failureReason: DEADLINE });
  });

  it('is a logged no-op when no endpoint is configured, without touching the database', async () => {
    vi.stubEnv('WS_PUSH_URL', '');
    delete process.env.WS_PUSH_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const calls = setupDb(['conn-a']);

    await expect(pushTaskUpdates('job-1', [failedAtDeadline('task-1')])).resolves.toBeUndefined();

    expect(calls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/WebSocket push disabled \(WS_CALLBACK_URL not set\).*job-1/));
  });
});
