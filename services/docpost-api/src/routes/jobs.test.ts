import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOLDER_DESTINATION_REQUIRED, ValidationError } from '@docpost/shared';
import { httpRequest, listen, type TestServer } from '../test-utils/http.js';
import { userToken } from '../test-utils/fakeAuth.js';
import { files as filesTable, jobs as jobsTable, tasks as tasksTable } from '../db/schema.js';

vi.hoisted(() => {
  // Upload plans are signed locally; the signer only needs credentials.
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
});

vi.mock('../middleware/auth.js', async () => ({
  requireUserAuth: (await import('../test-utils/fakeAuth.js')).fakeRequireUserAuth,
}));

const access = vi.hoisted(() => ({
  visibleTeams: vi.fn(),
  teamName: vi.fn(),
  assertFolderDestinations: vi.fn(),
  destinationPaths: vi.fn(),
  visibleSubmitterIds: vi.fn(),
}));
vi.mock('../lib/access.js', () => access);

const sqs = vi.hoisted(() => ({ publishJobMessage: vi.fn() }));
vi.mock('../lib/sqs.js', () => sqs);

// In-memory stand-in for the drizzle transaction used by POST /jobs.
const db = vi.hoisted(() => ({
  inserts: [] as Array<{ table: unknown; values: Array<Record<string, unknown>> }>,
  jobId: '',
  getDb: vi.fn(),
}));
vi.mock('../db/index.js', () => ({ getDb: db.getDb, closeDb: vi.fn() }));

const { createApp } = await import('../app.js');
const { computeAggregateStatus } = await import('./jobs.js');

const TEAM = '11111111-1111-4111-8111-111111111111';
const BINDER = '22222222-2222-4222-8222-222222222222';
const MB = 1024 * 1024;

function folder(n: number) {
  return { teamId: TEAM, binderId: BINDER, folderId: `33333333-3333-4333-8333-${String(n).padStart(12, '0')}` };
}

function file(overrides: Partial<{ name: string; sizeBytes: number; contentType: string; sha256: string }> = {}) {
  return { name: 'note.pdf', sizeBytes: 1024, contentType: 'application/pdf', sha256: 'c2hhMjU2', ...overrides };
}

function fakeDb() {
  const tx = {
    insert: (table: unknown) => ({
      values: (values: Array<Record<string, unknown>> | Record<string, unknown>) => {
        const rows = Array.isArray(values) ? values : [values];
        db.inserts.push({ table, values: rows });
        const done = Promise.resolve();
        return Object.assign(done, {
          returning: async () =>
            table === jobsTable
              ? [{ id: db.jobId }]
              : rows.map((r) => ({ id: r.id as string, s3Key: r.s3Key as string })),
        });
      },
    }),
  };
  return { transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) };
}

const inserted = (table: unknown) => db.inserts.filter((i) => i.table === table).flatMap((i) => i.values);

let server: TestServer;
const userId = crypto.randomUUID();
const token = userToken(userId);

beforeAll(async () => {
  server = await listen(createApp());
});

afterAll(async () => {
  await server?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  db.inserts = [];
  db.jobId = crypto.randomUUID();
  db.getDb.mockImplementation(fakeDb);
  access.visibleTeams.mockResolvedValue(new Map([[TEAM, 'Cardiology']]));
  access.assertFolderDestinations.mockResolvedValue(undefined);
  access.teamName.mockImplementation(async (id: string) => `name-of-${id}`);
  sqs.publishJobMessage.mockResolvedValue(undefined);
});

const postJobs = (body: unknown, auth: string | undefined = token) =>
  httpRequest(server.baseUrl, 'POST', '/jobs', { token: auth, body });

describe('POST /jobs auth', () => {
  it('requires a bearer token', async () => {
    const res = await postJobs({ files: [file()], destinations: [folder(1)] }, '');
    expect(res.status).toBe(401);
    expect(db.getDb).not.toHaveBeenCalled();
  });

  it('rejects service tokens', async () => {
    const res = await postJobs({ files: [file()], destinations: [folder(1)] }, 'service:delivery-worker');
    expect(res.status).toBe(403);
  });
});

describe('POST /jobs validation', () => {
  const expectRejected = async (body: unknown, message?: string | RegExp) => {
    const res = await postJobs(body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    if (message) expect(res.body.error.message).toMatch(message);
    expect(db.getDb).not.toHaveBeenCalled();
    expect(sqs.publishJobMessage).not.toHaveBeenCalled();
    return res;
  };

  it('rejects an empty file list', async () => {
    await expectRejected({ files: [], destinations: [folder(1)] });
  });

  it('rejects more than 100 files', async () => {
    const many = Array.from({ length: 101 }, (_, i) => file({ name: `f${i}.pdf` }));
    await expectRejected({ files: many, destinations: [folder(1)] });
  });

  it('rejects a zero-byte file', async () => {
    await expectRejected({ files: [file({ sizeBytes: 0 })], destinations: [folder(1)] });
  });

  it('rejects a file over the 1 GB ceiling', async () => {
    await expectRejected({ files: [file({ sizeBytes: 1024 * MB + 1 })], destinations: [folder(1)] });
  });

  it.each(['text/html', 'application/x-msdownload', 'application/zip', 'image/gif', 'application/msword'])(
    'rejects content type %s (not on the allow-list)',
    async (contentType) => {
      await expectRejected({ files: [file({ contentType })], destinations: [folder(1)] });
    },
  );

  it('rejects a file without a sha256', async () => {
    await expectRejected({ files: [file({ sha256: '' })], destinations: [folder(1)] });
  });

  it('rejects a request with no destinations', async () => {
    await expectRejected({ files: [file()] }, 'Choose at least one destination');
  });

  it('rejects a binder-level destination (folder required)', async () => {
    await expectRejected(
      { files: [file()], destinations: [{ teamId: TEAM, binderId: BINDER }] },
      FOLDER_DESTINATION_REQUIRED,
    );
  });

  it('rejects a non-uuid folder id', async () => {
    await expectRejected(
      { files: [file()], destinations: [{ teamId: TEAM, binderId: BINDER, folderId: 'root' }] },
      'Choose a folder in the selected binder',
    );
  });

  it('rejects more than 20 unique destinations', async () => {
    const destinations = Array.from({ length: 21 }, (_, i) => folder(i));
    await expectRejected({ files: [file()], destinations }, 'You can send to at most 20 destinations');
  });

  it('rejects more than 20 unique destinations inside a mapping', async () => {
    const destinations = Array.from({ length: 21 }, (_, i) => folder(i));
    await expectRejected(
      { files: [file()], mappings: [{ fileIndex: 0, destinations }] },
      'You can send to at most 20 destinations',
    );
  });

  it('rejects a mapping whose fileIndex is out of range', async () => {
    await expectRejected(
      { files: [file()], mappings: [{ fileIndex: 1, destinations: [folder(1)] }] },
      'fileIndex out of range',
    );
  });

  it('rejects a folder the platform says is not a folder destination', async () => {
    access.assertFolderDestinations.mockRejectedValueOnce(new ValidationError(FOLDER_DESTINATION_REQUIRED));
    await expectRejected({ files: [file()], destinations: [folder(1)] }, FOLDER_DESTINATION_REQUIRED);
  });

  it('forbids sending to a team the user cannot see, naming the team', async () => {
    const otherTeam = '44444444-4444-4444-8444-444444444444';
    const res = await postJobs({
      files: [file()],
      destinations: [{ ...folder(1), teamId: otherTeam }],
    });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe(`Not a member of team name-of-${otherTeam}`);
    expect(db.getDb).not.toHaveBeenCalled();
  });
});

describe('POST /jobs happy path', () => {
  it('creates 1 job, N files and N x D pending tasks and returns one plan per file in order', async () => {
    const inputFiles = [
      file({ name: 'a.pdf' }),
      file({ name: 'b.png', contentType: 'image/png', sizeBytes: 2048 }),
      file({ name: 'c.jpg', contentType: 'image/jpeg' }),
    ];
    const destinations = [folder(1), folder(2)];

    const res = await postJobs({ files: inputFiles, destinations });

    expect(res.status).toBe(201);
    expect(res.body.jobId).toBe(db.jobId);
    expect(res.body.taskCount).toBe(6);

    const [job] = inserted(jobsTable);
    expect(inserted(jobsTable)).toHaveLength(1);
    expect(job).toMatchObject({ submittedByUserId: userId, submitterName: 'Test User', taskCount: 6 });

    const fileRows = inserted(filesTable);
    expect(fileRows).toHaveLength(3);
    fileRows.forEach((row, i) => {
      expect(row).toMatchObject({
        ownerUserId: userId,
        jobId: db.jobId,
        originalName: inputFiles[i].name,
        sizeBytes: BigInt(inputFiles[i].sizeBytes),
        contentType: inputFiles[i].contentType,
        checksumSha256: inputFiles[i].sha256,
        s3Key: `uploads/${db.jobId}/${row.id}/${inputFiles[i].name}`,
      });
      // status is left to the column default ('pending')
      expect(row.status).toBeUndefined();
    });

    const taskRows = inserted(tasksTable);
    expect(taskRows).toHaveLength(6);
    for (const fileRow of fileRows) {
      const forFile = taskRows.filter((t) => t.fileId === fileRow.id);
      expect(forFile.map((t) => t.folderId)).toEqual(destinations.map((d) => d.folderId));
    }
    // tasks are inserted without a status, so the DB default 'pending' applies
    expect(taskRows.every((t) => t.status === undefined && t.jobId === db.jobId)).toBe(true);

    expect(res.body.uploads.map((u: { fileId: string }) => u.fileId)).toEqual(fileRows.map((r) => r.id));
    for (const [i, upload] of res.body.uploads.entries()) {
      expect(upload.presignedUrl).toEqual(expect.any(String));
      expect(upload.fields).toEqual({
        key: fileRows[i].s3Key,
        contentType: inputFiles[i].contentType,
        checksumSha256: inputFiles[i].sha256,
      });
    }

    expect(sqs.publishJobMessage).toHaveBeenCalledExactlyOnceWith(db.jobId, 60);
  });

  it('accepts every allow-listed content type', async () => {
    const types = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/png',
      'image/jpeg',
    ];
    const res = await postJobs({
      files: types.map((contentType, i) => file({ name: `f${i}`, contentType })),
      destinations: [folder(1)],
    });
    expect(res.status).toBe(201);
    expect(res.body.taskCount).toBe(5);
  });

  it('accepts exactly 20 destinations and collapses duplicates', async () => {
    const destinations = [...Array.from({ length: 20 }, (_, i) => folder(i)), folder(0), folder(1)];
    const res = await postJobs({ files: [file()], destinations });
    expect(res.status).toBe(201);
    expect(res.body.taskCount).toBe(20);
    expect(inserted(tasksTable)).toHaveLength(20);
  });

  it('honours per-file mappings', async () => {
    const res = await postJobs({
      files: [file({ name: 'a.pdf' }), file({ name: 'b.pdf' })],
      mappings: [
        { fileIndex: 0, destinations: [folder(1), folder(2), folder(3)] },
        { fileIndex: 1, destinations: [folder(4)] },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.taskCount).toBe(4);
    const [a, b] = inserted(filesTable);
    const taskRows = inserted(tasksTable);
    expect(taskRows.filter((t) => t.fileId === a.id)).toHaveLength(3);
    expect(taskRows.filter((t) => t.fileId === b.id)).toHaveLength(1);
  });

  it('returns a lazy multipart hint for a file over 100 MB', async () => {
    const res = await postJobs({
      files: [file({ name: 'small.pdf' }), file({ name: 'big.pdf', sizeBytes: 100 * MB + 1 })],
      destinations: [folder(1)],
    });
    expect(res.status).toBe(201);
    const [small, big] = res.body.uploads;
    expect(small.multipart).toBeUndefined();
    expect(big).toEqual({ fileId: expect.any(String), multipart: true, partSize: 16 * MB, partCount: 7 });
  });

  it('fails the submission when the watchdog message cannot be published', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sqs.publishJobMessage.mockRejectedValueOnce(new Error('SQS down'));
    const res = await postJobs({ files: [file()], destinations: [folder(1)] });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});

describe('computeAggregateStatus', () => {
  const counts = (c: Partial<Record<'pending' | 'in_progress' | 'completed' | 'failed', number>>) => ({
    pending: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
    ...c,
  });

  it('is pending when there are no tasks', () => {
    expect(computeAggregateStatus(counts({}))).toBe('pending');
  });

  it('is pending when nothing has started', () => {
    expect(computeAggregateStatus(counts({ pending: 4 }))).toBe('pending');
  });

  it('is in_progress once any task has started', () => {
    expect(computeAggregateStatus(counts({ pending: 3, in_progress: 1 }))).toBe('in_progress');
    expect(computeAggregateStatus(counts({ pending: 3, completed: 1 }))).toBe('in_progress');
  });

  it('is in_progress while work remains even if some tasks failed', () => {
    expect(computeAggregateStatus(counts({ failed: 1, in_progress: 1 }))).toBe('in_progress');
    expect(computeAggregateStatus(counts({ failed: 1, pending: 1 }))).toBe('in_progress');
  });

  it('is completed when every task completed', () => {
    expect(computeAggregateStatus(counts({ completed: 5 }))).toBe('completed');
  });

  it('is completed_with_errors when some failed and nothing is outstanding (blueprint)', () => {
    expect(computeAggregateStatus(counts({ completed: 2, failed: 1 }))).toBe('completed_with_errors');
  });

  it('is completed_with_errors when every task failed', () => {
    expect(computeAggregateStatus(counts({ failed: 3 }))).toBe('completed_with_errors');
  });

  it("never returns the old 'failed' job status", () => {
    const samples = [{ failed: 1 }, { failed: 2, completed: 1 }, { failed: 1, pending: 1 }, { failed: 1, in_progress: 1 }];
    for (const sample of samples) {
      expect(computeAggregateStatus(counts(sample))).not.toBe('failed');
    }
  });
});

describe('routing', () => {
  it('404s (not 401) for an unknown route', async () => {
    const res = await httpRequest(server.baseUrl, 'GET', '/no-such-route');
    expect(res.status).toBe(404);
  });

  it.each(['/jobs/not-a-uuid', '/jobs/not-a-uuid/tasks', "/jobs/1'%20OR%201=1"])(
    'GET %s 404s for a malformed job id without querying the database',
    async (path) => {
      const res = await httpRequest(server.baseUrl, 'GET', path, { token });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    },
  );

  it('still requires authentication before looking at the id', async () => {
    const res = await httpRequest(server.baseUrl, 'GET', '/jobs/not-a-uuid');
    expect(res.status).toBe(401);
  });
});
