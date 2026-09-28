import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { errorHandler } from '@docpost/shared';
import { httpRequest, listen, type TestServer } from '../test-utils/http.js';
import { userToken } from '../test-utils/fakeAuth.js';

vi.mock('../middleware/auth.js', async () => ({
  requireUserAuth: (await import('../test-utils/fakeAuth.js')).fakeRequireUserAuth,
}));

const access = vi.hoisted(() => ({ visibleSubmitterIds: vi.fn() }));
vi.mock('../lib/access.js', () => access);

const s3 = vi.hoisted(() => ({
  presignDownload: vi.fn(),
  initiateMultipartUpload: vi.fn(),
  resignMultipartParts: vi.fn(),
}));
vi.mock('../lib/s3.js', () => s3);

// Each awaited drizzle query pops the next queued result.
const db = vi.hoisted(() => ({ results: [] as unknown[][] }));
vi.mock('../db/index.js', () => {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'from', 'innerJoin', 'where']) chain[method] = () => chain;
  chain.then = (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) => {
    const next = db.results.shift();
    return next ? Promise.resolve(next).then(resolve) : Promise.reject(new Error('unexpected query')).catch(reject);
  };
  return { getDb: () => chain, closeDb: vi.fn() };
});

const { default: filesRouter } = await import('./files.js');

const owner = crypto.randomUUID();
const teammate = crypto.randomUUID();
const stranger = crypto.randomUUID();
const fileId = crypto.randomUUID();

let server: TestServer;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(filesRouter);
  app.use(errorHandler);
  server = await listen(app);
});

afterAll(async () => {
  await server?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  db.results = [];
  access.visibleSubmitterIds.mockImplementation(async (userId: string) =>
    userId === stranger ? new Set([stranger]) : new Set([owner, teammate]),
  );
  s3.presignDownload.mockResolvedValue('https://s3.example/signed-get');
});

describe('POST /files/:fileId/download-url', () => {
  const call = (token?: string) =>
    httpRequest(server.baseUrl, 'POST', `/files/${fileId}/download-url`, { token });

  it('requires authentication', async () => {
    expect((await call()).status).toBe(401);
  });

  it('returns a 2-minute URL to the submitter', async () => {
    db.results.push([{ s3Key: 'uploads/j/f/a.pdf', status: 'uploaded', submittedByUserId: owner }]);
    const res = await call(userToken(owner));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'https://s3.example/signed-get', expiresIn: 120 });
    expect(s3.presignDownload).toHaveBeenCalledWith('uploads/j/f/a.pdf');
  });

  it('returns a URL to a teammate of the submitter, passing the caller token', async () => {
    db.results.push([{ s3Key: 'k', status: 'uploaded', submittedByUserId: owner }]);
    const res = await call(userToken(teammate));
    expect(res.status).toBe(200);
    expect(access.visibleSubmitterIds).toHaveBeenCalledWith(teammate, userToken(teammate));
  });

  it('404s (not 403) for a user outside the submitter teams', async () => {
    db.results.push([{ s3Key: 'k', status: 'uploaded', submittedByUserId: owner }]);
    const res = await call(userToken(stranger));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(s3.presignDownload).not.toHaveBeenCalled();
  });

  it('404s for an unknown file', async () => {
    db.results.push([]);
    expect((await call(userToken(owner))).status).toBe(404);
  });

  it.each(['pending', 'expired'])('404s for a file that is still %s', async (status) => {
    db.results.push([{ s3Key: 'k', status, submittedByUserId: owner }]);
    expect((await call(userToken(owner))).status).toBe(404);
    expect(s3.presignDownload).not.toHaveBeenCalled();
  });
});

describe('POST /files/:fileId/multipart', () => {
  const fileRow = {
    id: fileId,
    ownerUserId: owner,
    s3Key: 'uploads/j/f/big.pdf',
    contentType: 'application/pdf',
    sizeBytes: BigInt(200 * 1024 * 1024),
  };
  const call = (token?: string, body?: unknown) =>
    httpRequest(server.baseUrl, 'POST', `/files/${fileId}/multipart`, { token, body });
  const plan = { uploadId: 'up-1', parts: [], completeUrl: 'c', abortUrl: 'a' };

  it('requires authentication', async () => {
    expect((await call()).status).toBe(401);
  });

  it('initiates a multipart upload when no body is sent', async () => {
    db.results.push([fileRow]);
    s3.initiateMultipartUpload.mockResolvedValue(plan);
    const res = await call(userToken(owner));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(plan);
    expect(s3.initiateMultipartUpload).toHaveBeenCalledWith(fileRow.s3Key, 'application/pdf', 200 * 1024 * 1024);
    expect(s3.resignMultipartParts).not.toHaveBeenCalled();
  });

  it('re-signs only the listed parts when uploadId and partNumbers are sent', async () => {
    db.results.push([fileRow]);
    s3.resignMultipartParts.mockResolvedValue(plan);
    const res = await call(userToken(owner), { uploadId: 'up-1', partNumbers: [3, 4] });
    expect(res.status).toBe(200);
    expect(s3.resignMultipartParts).toHaveBeenCalledWith(fileRow.s3Key, 'up-1', [3, 4], 200 * 1024 * 1024);
    expect(s3.initiateMultipartUpload).not.toHaveBeenCalled();
  });

  it.each([[[0]], [['1']], [[-2]]])('rejects invalid partNumbers %j', async (partNumbers) => {
    db.results.push([fileRow]);
    const res = await call(userToken(owner), { uploadId: 'up-1', partNumbers });
    expect(res.status).toBe(422);
    expect(s3.resignMultipartParts).not.toHaveBeenCalled();
  });

  it('404s for an unknown file', async () => {
    db.results.push([]);
    expect((await call(userToken(owner))).status).toBe(404);
  });

  it('refuses a user who does not own the file', async () => {
    db.results.push([fileRow]);
    const res = await call(userToken(teammate));
    expect(res.status).toBeGreaterThanOrEqual(403);
    expect(s3.initiateMultipartUpload).not.toHaveBeenCalled();
  });

  // BUG (spec drift): blueprint says multipart is "submitter-only, same as the job reads",
  // and job/file reads answer 404 outside scope so existence is not confirmed. The route
  // answers 403 ForbiddenError for someone else's file.
  it.fails('404s (not 403) for a user who does not own the file (blueprint)', async () => {
    db.results.push([fileRow]);
    expect((await call(userToken(stranger))).status).toBe(404);
  });
});
