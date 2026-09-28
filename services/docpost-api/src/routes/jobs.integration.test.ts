import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { FOLDER_DESTINATION_REQUIRED } from '@docpost/shared';
import { BUCKET, fileFor, startHarness, type Harness } from '../test-utils/integration.js';

const MB = 1024 * 1024;

describe.skipIf(!process.env.INTEGRATION)('jobs API (integration)', () => {
  let h: Harness;
  let owner: string;
  let teammate: string;
  let stranger: string;
  let ownerToken: string;
  let teammateToken: string;
  let strangerToken: string;
  let teamId: string;
  const binderId = crypto.randomUUID();
  const folderIds = Array.from({ length: 21 }, () => crypto.randomUUID());
  const dest = (i: number) => ({ teamId, binderId, folderId: folderIds[i] });

  beforeAll(async () => {
    h = await startHarness();
    owner = crypto.randomUUID();
    teammate = crypto.randomUUID();
    stranger = crypto.randomUUID();
    teamId = h.addTeam([owner, teammate], { name: 'Cardiology' }).id;
    h.addTeam([stranger]);
    [ownerToken, teammateToken, strangerToken] = await Promise.all(
      [owner, teammate, stranger].map((id) => h.signUserToken(id)),
    );
  });

  afterAll(async () => {
    await h?.close();
  });

  async function submit(body: unknown, token = ownerToken) {
    const res = await h.api('POST', '/jobs', { token, body });
    if (res.status === 201) h.trackJob(res.body.jobId);
    return res;
  }

  async function jobsFor(userId: string) {
    return h.db.select().from(h.schema.jobs).where(eq(h.schema.jobs.submittedByUserId, userId));
  }

  describe('authentication', () => {
    const someId = crypto.randomUUID();
    const protectedRoutes: Array<[string, string]> = [
      ['POST', '/jobs'],
      ['GET', '/jobs'],
      ['GET', `/jobs/${someId}`],
      ['GET', `/jobs/${someId}/tasks`],
      ['POST', `/files/${someId}/multipart`],
      ['POST', `/files/${someId}/download-url`],
      ['GET', '/destinations/teams'],
    ];

    it.each(protectedRoutes)('%s %s returns 401 without a token', async (method, path) => {
      const res = await h.api(method, path);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it.each(protectedRoutes)('%s %s returns 401 with a forged token', async (method, path) => {
      const [header, payload] = ownerToken.split('.');
      const res = await h.api(method, path, { token: `${header}.${payload}.forged-signature` });
      expect(res.status).toBe(401);
    });

    it('returns 403 for a service token on a user endpoint', async () => {
      const res = await h.api('GET', '/jobs', { token: await h.signServiceToken() });
      expect(res.status).toBe(403);
    });

    it('answers 404 (not 401) for an unknown route', async () => {
      expect((await h.api('GET', '/no-such-route')).status).toBe(404);
      expect((await h.api('GET', '/no-such-route', { token: ownerToken })).status).toBe(404);
    });

    it.each([
      '/destinations/teams/x/binders',
      '/destinations/binders/x/contents',
      '/destinations/folders/x/contents',
      '/destinations/documents/x/download',
    ])('GET %s returns 401 without a token', async (path) => {
      expect((await h.api('GET', path)).status).toBe(401);
    });

    it('leaves /health open', async () => {
      expect((await h.api('GET', '/health')).status).toBe(200);
    });
  });

  describe('POST /jobs validation', () => {
    const pdf = { name: 'a.pdf', sizeBytes: 10, contentType: 'application/pdf', sha256: 'x' };

    it.each([
      ['no files', () => ({ files: [], destinations: [dest(0)] })],
      ['101 files', () => ({ files: Array.from({ length: 101 }, () => pdf), destinations: [dest(0)] })],
      ['a file over 1 GB', () => ({ files: [{ ...pdf, sizeBytes: 1024 * MB + 1 }], destinations: [dest(0)] })],
      ['a disallowed content type', () => ({ files: [{ ...pdf, contentType: 'application/x-sh' }], destinations: [dest(0)] })],
      ['21 destinations', () => ({ files: [pdf], destinations: folderIds.map((_, i) => dest(i)) })],
      ['a binder-level destination', () => ({ files: [pdf], destinations: [{ teamId, binderId }] })],
    ])('rejects %s with 422 and writes nothing', async (_label, body) => {
      const before = (await jobsFor(owner)).length;
      const res = await submit(body());
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect((await jobsFor(owner)).length).toBe(before);
    });

    it('names the 20-destination cap', async () => {
      const res = await submit({ files: [pdf], destinations: folderIds.map((_, i) => dest(i)) });
      expect(res.body.error.message).toBe('You can send to at most 20 destinations');
    });

    it('rejects a destination the platform says is not a folder', async () => {
      const notAFolder = crypto.randomUUID();
      h.nonFolderIds.add(notAFolder);
      const res = await submit({ files: [pdf], destinations: [{ teamId, binderId, folderId: notAFolder }] });
      expect(res.status).toBe(422);
      expect(res.body.error.message).toBe(FOLDER_DESTINATION_REQUIRED);
    });

    it('forbids a team the user is not a member of', async () => {
      const res = await submit({ files: [pdf], destinations: [dest(0)] }, strangerToken);
      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('Not a member of team Cardiology');
      expect(await jobsFor(stranger)).toHaveLength(0);
    });

    it('forbids a team that has DocPost disabled', async () => {
      const disabled = h.addTeam([owner], { docPostEnabled: false });
      const res = await submit({ files: [pdf], destinations: [{ teamId: disabled.id, binderId, folderId: folderIds[0] }] });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /jobs happy path', () => {
    it('creates 1 job, N files and N x D pending tasks before any upload', async () => {
      const inputs = [
        await fileFor('a.pdf', Buffer.from('file a')),
        await fileFor('b.png', Buffer.from('file b!'), 'image/png'),
      ];
      const destinations = [dest(0), dest(1), dest(2)];
      const started = Date.now();

      const res = await submit({ files: inputs, destinations });

      expect(res.status).toBe(201);
      expect(res.body.taskCount).toBe(6);
      const { jobId } = res.body;

      const [job] = await h.db.select().from(h.schema.jobs).where(eq(h.schema.jobs.id, jobId));
      expect(job).toMatchObject({ submittedByUserId: owner, taskCount: 6, completedAt: null });
      expect(job.submitterName).toBe(`User ${owner.slice(0, 8)}`);

      const fileRows = await h.db.select().from(h.schema.files).where(eq(h.schema.files.jobId, jobId));
      expect(fileRows).toHaveLength(2);
      for (const row of fileRows) {
        const input = inputs.find((f) => f.name === row.originalName)!;
        expect(row).toMatchObject({
          ownerUserId: owner,
          status: 'pending',
          contentType: input.contentType,
          checksumSha256: input.sha256,
          sizeBytes: BigInt(input.sizeBytes),
          s3Key: `uploads/${jobId}/${row.id}/${input.name}`,
          uploadedAt: null,
        });
        // Staging deadline: 30 minutes after submission.
        const deadlineMs = row.stagingDeadlineAt.getTime() - started;
        expect(deadlineMs).toBeGreaterThan(29 * 60_000);
        expect(deadlineMs).toBeLessThan(31 * 60_000);
      }

      const taskRows = await h.db.select().from(h.schema.tasks).where(eq(h.schema.tasks.jobId, jobId));
      expect(taskRows).toHaveLength(6);
      expect(taskRows.every((t) => t.status === 'pending' && t.attemptCount === 0 && t.region === 'us-east-1')).toBe(true);
      for (const row of fileRows) {
        const folders = taskRows.filter((t) => t.fileId === row.id).map((t) => t.folderId).sort();
        expect(folders).toEqual(destinations.map((d) => d.folderId).sort());
      }

      // One plan per file, same order as the request.
      expect(res.body.uploads).toHaveLength(2);
      res.body.uploads.forEach((plan: { fileId: string; presignedUrl: string; fields: Record<string, string> }, i: number) => {
        const row = fileRows.find((f) => f.id === plan.fileId)!;
        expect(row.originalName).toBe(inputs[i].name);
        expect(plan.fields).toEqual({ key: row.s3Key, contentType: inputs[i].contentType, checksumSha256: inputs[i].sha256 });
        const url = new URL(plan.presignedUrl);
        expect(url.pathname).toBe(`/${BUCKET}/${row.s3Key}`);
        expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
      });

      // The job is immediately visible with every task pending.
      const detail = await h.api('GET', `/jobs/${jobId}`, { token: ownerToken });
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({
        jobId,
        taskCount: 6,
        counts: { pending: 6, in_progress: 0, completed: 0, failed: 0 },
        aggregateStatus: 'pending',
      });
    });

    // Regression: the plan used to carry the SDK's CRC32 of an *empty* body
    // (x-amz-checksum-crc32=AAAAAA==) and S3/LocalStack rejected every real upload.
    // (The blueprint's presigned POST with policy conditions is still pending, see s3.test.ts.)
    it('the returned upload plan actually uploads the bytes to LocalStack', async () => {
      const bytes = Buffer.from('%PDF-1.4 integration upload');
      const res = await submit({ files: [await fileFor('upload.pdf', bytes)], destinations: [dest(0)] });
      expect(res.status).toBe(201);
      const [plan] = res.body.uploads as Array<{ presignedUrl: string; fields: { key: string; contentType: string } }>;
      h.trackS3Key(plan.fields.key);
      expect(new URL(plan.presignedUrl).searchParams.get('x-amz-checksum-crc32')).toBeNull();

      const put = await fetch(plan.presignedUrl, {
        method: 'PUT',
        body: bytes,
        headers: { 'Content-Type': plan.fields.contentType },
      });

      expect(put.status).toBe(200);
      const head = await h.s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: plan.fields.key }));
      expect(head.ContentLength).toBe(bytes.length);
      expect(head.ContentType).toBe('application/pdf');
    });

    it('returns a lazy multipart plan for files over 100 MB and initiates it on demand', async () => {
      const res = await submit({
        files: [{ name: 'scan.pdf', sizeBytes: 100 * MB + 1, contentType: 'application/pdf', sha256: 'x' }],
        destinations: [dest(0)],
      });
      expect(res.status).toBe(201);
      const [plan] = res.body.uploads;
      expect(plan).toEqual({ fileId: expect.any(String), multipart: true, partSize: 16 * MB, partCount: 7 });

      const init = await h.api('POST', `/files/${plan.fileId}/multipart`, { token: ownerToken });
      expect(init.status).toBe(200);
      expect(init.body.uploadId).toEqual(expect.any(String));
      expect(init.body.parts.map((p: { partNumber: number }) => p.partNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);

      const resign = await h.api('POST', `/files/${plan.fileId}/multipart`, {
        token: ownerToken,
        body: { uploadId: init.body.uploadId, partNumbers: [6, 7] },
      });
      expect(resign.status).toBe(200);
      expect(resign.body.uploadId).toBe(init.body.uploadId);
      expect(resign.body.parts.map((p: { partNumber: number }) => p.partNumber)).toEqual([6, 7]);

      // Clean up the in-flight upload through the returned abort URL.
      const abort = await fetch(init.body.abortUrl, { method: 'DELETE' });
      expect(abort.status).toBe(204);
    });

    // Regression: part URLs carried the same empty-body CRC32 checksum and LocalStack
    // answered 400 "Checksum Type mismatch" to a real part upload.
    it('a multipart part URL accepts a real part upload', async () => {
      const res = await submit({
        files: [{ name: 'scan2.pdf', sizeBytes: 100 * MB + 1, contentType: 'application/pdf', sha256: 'x' }],
        destinations: [dest(0)],
      });
      const init = await h.api('POST', `/files/${res.body.uploads[0].fileId}/multipart`, { token: ownerToken });
      expect(init.status).toBe(200);
      try {
        const put = await fetch(init.body.parts[0].url, { method: 'PUT', body: Buffer.alloc(16 * MB, 1) });
        expect(put.status).toBe(200);
        expect(put.headers.get('etag')).toBeTruthy();
      } finally {
        await fetch(init.body.abortUrl, { method: 'DELETE' });
      }
    });

    it('rejects re-signing a fractional or out-of-range part number with 422', async () => {
      const res = await submit({
        files: [{ name: 'scan3.pdf', sizeBytes: 100 * MB + 1, contentType: 'application/pdf', sha256: 'x' }],
        destinations: [dest(0)],
      });
      const fileId = res.body.uploads[0].fileId;
      for (const partNumbers of [[1.5], [8], [0]]) {
        const resign = await h.api('POST', `/files/${fileId}/multipart`, {
          token: ownerToken,
          body: { uploadId: 'any-upload', partNumbers },
        });
        expect(resign.status).toBe(422);
        expect(resign.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('lets another user neither initiate multipart nor see the job', async () => {
      const res = await submit({
        files: [{ name: 'big.pdf', sizeBytes: 200 * MB, contentType: 'application/pdf', sha256: 'x' }],
        destinations: [dest(0)],
      });
      const { jobId } = res.body;
      const fileId = res.body.uploads[0].fileId;

      expect((await h.api('POST', `/files/${fileId}/multipart`, { token: strangerToken })).status).toBe(404);
      // A teammate can see the job but only the submitter may upload its bytes.
      expect((await h.api('POST', `/files/${fileId}/multipart`, { token: teammateToken })).status).toBe(404);
      expect((await h.api('GET', `/jobs/${jobId}`, { token: teammateToken })).status).toBe(200);
      expect((await h.api('GET', `/jobs/${jobId}`, { token: strangerToken })).status).toBe(404);
      expect((await h.api('GET', `/jobs/${jobId}/tasks`, { token: strangerToken })).status).toBe(404);
    });
  });

  describe('job status derivation', () => {
    let jobId: string;
    let taskIds: string[];

    beforeAll(async () => {
      const res = await submit({
        files: [await fileFor('s.pdf', Buffer.from('status'))],
        destinations: [dest(0), dest(1), dest(2)],
      });
      jobId = res.body.jobId;
      const rows = await h.db.select({ id: h.schema.tasks.id }).from(h.schema.tasks).where(eq(h.schema.tasks.jobId, jobId));
      taskIds = rows.map((r) => r.id);
    });

    async function setStatuses(statuses: Array<'pending' | 'in_progress' | 'completed' | 'failed'>) {
      for (const [i, status] of statuses.entries()) {
        await h.db.update(h.schema.tasks).set({ status }).where(eq(h.schema.tasks.id, taskIds[i]));
      }
    }

    async function statusOf() {
      const res = await h.api('GET', `/jobs/${jobId}`, { token: ownerToken });
      expect(res.status).toBe(200);
      return res.body as { aggregateStatus: string; counts: Record<string, number> };
    }

    it('is pending when no task has started', async () => {
      await setStatuses(['pending', 'pending', 'pending']);
      expect((await statusOf()).aggregateStatus).toBe('pending');
    });

    it('is in_progress when any task is in progress', async () => {
      await setStatuses(['in_progress', 'pending', 'pending']);
      expect((await statusOf()).aggregateStatus).toBe('in_progress');
    });

    it('is in_progress when some completed and some are pending', async () => {
      await setStatuses(['completed', 'pending', 'pending']);
      const body = await statusOf();
      expect(body.aggregateStatus).toBe('in_progress');
      expect(body.counts).toEqual({ pending: 2, in_progress: 0, completed: 1, failed: 0 });
    });

    it('is in_progress when one failed but others are outstanding', async () => {
      await setStatuses(['failed', 'in_progress', 'pending']);
      expect((await statusOf()).aggregateStatus).toBe('in_progress');
    });

    it('is completed when every task completed', async () => {
      await setStatuses(['completed', 'completed', 'completed']);
      expect((await statusOf()).aggregateStatus).toBe('completed');
    });

    it('is completed_with_errors when some failed and nothing is outstanding (blueprint)', async () => {
      await setStatuses(['completed', 'failed', 'completed']);
      expect((await statusOf()).aggregateStatus).toBe('completed_with_errors');
      const list = await h.api('GET', '/jobs?limit=100', { token: ownerToken });
      const listed = list.body.jobs.find((j: { jobId: string }) => j.jobId === jobId);
      expect(listed.aggregateStatus).toBe('completed_with_errors');
    });

    it('is completed_with_errors when every task failed', async () => {
      await setStatuses(['failed', 'failed', 'failed']);
      expect((await statusOf()).aggregateStatus).toBe('completed_with_errors');
    });

    it('is visible with the same status to a teammate, and in the list', async () => {
      await setStatuses(['completed', 'completed', 'completed']);
      const detail = await h.api('GET', `/jobs/${jobId}`, { token: teammateToken });
      expect(detail.status).toBe(200);
      expect(detail.body.aggregateStatus).toBe('completed');
      const list = await h.api('GET', '/jobs?limit=100', { token: teammateToken });
      const listed = list.body.jobs.find((j: { jobId: string }) => j.jobId === jobId);
      expect(listed).toMatchObject({ aggregateStatus: 'completed', counts: { completed: 3 } });
    });

    it('fails tasks whose retries are exhausted and closes the job on read', async () => {
      await setStatuses(['completed', 'completed', 'in_progress']);
      await h.db.update(h.schema.tasks).set({ attemptCount: 3 }).where(eq(h.schema.tasks.id, taskIds[2]));

      const body = (await h.api('GET', `/jobs/${jobId}`, { token: ownerToken })).body;

      expect(body.counts).toEqual({ pending: 0, in_progress: 0, completed: 2, failed: 1 });
      expect(body.completedAt).not.toBeNull();
      const [task] = await h.db.select().from(h.schema.tasks).where(eq(h.schema.tasks.id, taskIds[2]));
      expect(task.status).toBe('failed');
      expect(task.failureReason).toMatch(/^RETRIES_EXHAUSTED /);
      expect(task.failureReason).toContain('s.pdf');
    });
  });

  describe('GET /jobs/:id/tasks', () => {
    it('paginates tasks, filters by status and labels destinations', async () => {
      const res = await submit({
        files: [await fileFor('t.pdf', Buffer.from('tasks'))],
        destinations: [dest(0), dest(1), dest(2)],
      });
      const { jobId } = res.body;
      await h.db
        .update(h.schema.tasks)
        .set({ status: 'failed', failureReason: 'FILE_NOT_UPLOADED' })
        .where(and(eq(h.schema.tasks.jobId, jobId), eq(h.schema.tasks.folderId, folderIds[1])));

      const page1 = await h.api('GET', `/jobs/${jobId}/tasks?limit=2&page=1`, { token: ownerToken });
      const page2 = await h.api('GET', `/jobs/${jobId}/tasks?limit=2&page=2`, { token: ownerToken });
      expect(page1.body).toMatchObject({ total: 3, page: 1, limit: 2 });
      expect(page1.body.tasks).toHaveLength(2);
      expect(page2.body.tasks).toHaveLength(1);
      const all = [...page1.body.tasks, ...page2.body.tasks];
      expect(new Set(all.map((t: { taskId: string }) => t.taskId)).size).toBe(3);
      expect(all[0]).toMatchObject({ fileName: 't.pdf', teamName: 'Cardiology', destination: 'Cardiology / binder / folder' });

      const failed = await h.api('GET', `/jobs/${jobId}/tasks?status=failed`, { token: ownerToken });
      expect(failed.body.total).toBe(1);
      expect(failed.body.tasks[0]).toMatchObject({ folderId: folderIds[1], failureReason: 'FILE_NOT_UPLOADED' });
    });
  });

  describe('failure reasons', () => {
    it('passes the recorded failure reason through unchanged', async () => {
      const res = await submit({
        files: [await fileFor('r.pdf', Buffer.from('reasons'))],
        destinations: [dest(0), dest(1)],
      });
      const { jobId } = res.body;
      const platformReason =
        'Platform rejected the document (422 CHECKSUM_MISMATCH): Declared checksum does not match "r.pdf" → ünïcode';
      const structured = `NOT_AUTHORIZED_AT_DELIVERY ${JSON.stringify({ fileName: 'r.pdf', status: 403, code: 'FORBIDDEN', message: 'Not a member' })}`;
      await h.db
        .update(h.schema.tasks)
        .set({ status: 'failed', failureReason: platformReason })
        .where(and(eq(h.schema.tasks.jobId, jobId), eq(h.schema.tasks.folderId, folderIds[0])));
      await h.db
        .update(h.schema.tasks)
        .set({ status: 'failed', failureReason: structured })
        .where(and(eq(h.schema.tasks.jobId, jobId), eq(h.schema.tasks.folderId, folderIds[1])));

      const list = await h.api('GET', `/jobs/${jobId}/tasks`, { token: ownerToken });
      expect(list.status).toBe(200);
      const byFolder = new Map(list.body.tasks.map((t: { folderId: string; failureReason: string }) => [t.folderId, t.failureReason]));
      expect(byFolder.get(folderIds[0])).toBe(platformReason);
      expect(byFolder.get(folderIds[1])).toBe(structured);

      const detail = await h.api('GET', `/jobs/${jobId}`, { token: ownerToken });
      expect(detail.body.aggregateStatus).toBe('completed_with_errors');
    });
  });

  describe('GET /jobs pagination and scope', () => {
    let listUser: string;
    let listToken: string;
    const ids: string[] = [];

    beforeAll(async () => {
      listUser = crypto.randomUUID();
      listToken = await h.signUserToken(listUser);
      // A user on no team sees only their own jobs.
      const base = Date.now() - 60_000;
      for (let i = 0; i < 5; i++) {
        const [job] = await h.db
          .insert(h.schema.jobs)
          .values({ submittedByUserId: listUser, submitterName: 'Lister', taskCount: 0, createdAt: new Date(base + i * 1000) })
          .returning({ id: h.schema.jobs.id });
        ids.push(job.id);
        h.trackJob(job.id);
      }
    });

    it('returns newest first, limited per page', async () => {
      const newestFirst = [...ids].reverse();
      const page1 = await h.api('GET', '/jobs?page=1&limit=2', { token: listToken });
      const page2 = await h.api('GET', '/jobs?page=2&limit=2', { token: listToken });
      const page3 = await h.api('GET', '/jobs?page=3&limit=2', { token: listToken });
      const page4 = await h.api('GET', '/jobs?page=4&limit=2', { token: listToken });

      const idsOf = (r: { body: { jobs: Array<{ jobId: string }> } }) => r.body.jobs.map((j) => j.jobId);
      expect(idsOf(page1)).toEqual(newestFirst.slice(0, 2));
      expect(idsOf(page2)).toEqual(newestFirst.slice(2, 4));
      expect(idsOf(page3)).toEqual(newestFirst.slice(4));
      expect(page4.body).toEqual({ jobs: [] });
    });

    it('defaults to page 1 / limit 20 and clamps bad values', async () => {
      const defaults = await h.api('GET', '/jobs', { token: listToken });
      expect(defaults.body.jobs).toHaveLength(5);
      const clamped = await h.api('GET', '/jobs?page=-3&limit=0', { token: listToken });
      expect(clamped.body.jobs).toHaveLength(5);
      const huge = await h.api('GET', '/jobs?limit=100000', { token: listToken });
      expect(huge.status).toBe(200);
      expect(huge.body.jobs).toHaveLength(5);
    });

    it('reports zero counts and pending for a job with no tasks', async () => {
      const res = await h.api('GET', '/jobs?limit=1', { token: listToken });
      expect(res.body.jobs[0]).toMatchObject({
        taskCount: 0,
        submitterName: 'Lister',
        counts: { pending: 0, in_progress: 0, completed: 0, failed: 0 },
        aggregateStatus: 'pending',
      });
    });

    it("does not list another user's jobs outside shared teams", async () => {
      const res = await h.api('GET', '/jobs?limit=100', { token: strangerToken });
      const leaked = res.body.jobs.filter((j: { jobId: string }) => ids.includes(j.jobId));
      expect(leaked).toHaveLength(0);
      const ownerJobs = await h.db
        .select({ id: h.schema.jobs.id })
        .from(h.schema.jobs)
        .where(inArray(h.schema.jobs.submittedByUserId, [owner]));
      const ownerIds = new Set(ownerJobs.map((j) => j.id));
      expect(res.body.jobs.some((j: { jobId: string }) => ownerIds.has(j.jobId))).toBe(false);
    });
  });

  describe('GET /jobs/:id lookups', () => {
    it('404s for an unknown job id', async () => {
      const res = await h.api('GET', `/jobs/${crypto.randomUUID()}`, { token: ownerToken });
      expect(res.status).toBe(404);
    });

    // Regression: a non-UUID id reached Postgres ("invalid input syntax for type uuid")
    // and surfaced as 500 INTERNAL_ERROR instead of 404.
    it.each(['/jobs/not-a-uuid', '/jobs/not-a-uuid/tasks', '/jobs/12345'])('404s for a malformed job id (%s)', async (path) => {
      const res = await h.api('GET', path, { token: ownerToken });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('404s for a malformed file id', async () => {
      expect((await h.api('POST', '/files/not-a-uuid/multipart', { token: ownerToken })).status).toBe(404);
      expect((await h.api('POST', '/files/not-a-uuid/download-url', { token: ownerToken })).status).toBe(404);
    });
  });
});
