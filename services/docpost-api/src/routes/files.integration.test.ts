import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { BUCKET, fileFor, startHarness, type Harness } from '../test-utils/integration.js';

describe.skipIf(!process.env.INTEGRATION)('files API (integration)', () => {
  let h: Harness;
  let owner: string;
  let ownerToken: string;
  let teammateToken: string;
  let strangerToken: string;
  let teamId: string;
  const binderId = crypto.randomUUID();
  const folderId = crypto.randomUUID();
  const bytes = Buffer.from('%PDF-1.4 download me');

  let uploadedFileId: string;
  let pendingFileId: string;

  beforeAll(async () => {
    h = await startHarness();
    owner = crypto.randomUUID();
    const teammate = crypto.randomUUID();
    const stranger = crypto.randomUUID();
    teamId = h.addTeam([owner, teammate]).id;
    h.addTeam([stranger]);
    [ownerToken, teammateToken, strangerToken] = await Promise.all(
      [owner, teammate, stranger].map((id) => h.signUserToken(id)),
    );

    const res = await h.api('POST', '/jobs', {
      token: ownerToken,
      body: {
        files: [await fileFor('ready.pdf', bytes), await fileFor('waiting.pdf', Buffer.from('later'))],
        destinations: [{ teamId, binderId, folderId }],
      },
    });
    expect(res.status).toBe(201);
    h.trackJob(res.body.jobId);
    [uploadedFileId, pendingFileId] = res.body.uploads.map((u: { fileId: string }) => u.fileId);

    // Stand in for browser upload + upload-event promotion: put the bytes with the SDK
    // (the presigned plan itself is currently unusable, see jobs.integration.test.ts)
    // and mark the row uploaded.
    const [row] = await h.db.select().from(h.schema.files).where(eq(h.schema.files.id, uploadedFileId));
    await h.s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: row.s3Key, Body: bytes, ContentType: 'application/pdf' }));
    h.trackS3Key(row.s3Key);
    await h.db
      .update(h.schema.files)
      .set({ status: 'uploaded', uploadedAt: new Date() })
      .where(eq(h.schema.files.id, uploadedFileId));
  });

  afterAll(async () => {
    await h?.close();
  });

  const downloadUrl = (fileId: string, token?: string) =>
    h.api('POST', `/files/${fileId}/download-url`, { token });

  it('requires authentication', async () => {
    expect((await downloadUrl(uploadedFileId)).status).toBe(401);
  });

  it('returns url + expiresIn 120 to the submitter, and the URL serves the bytes', async () => {
    const res = await downloadUrl(uploadedFileId, ownerToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: expect.any(String), expiresIn: 120 });
    const url = new URL(res.body.url);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');

    const download = await fetch(res.body.url);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  });

  it('returns a URL to a teammate of the submitter', async () => {
    const res = await downloadUrl(uploadedFileId, teammateToken);
    expect(res.status).toBe(200);
    expect(res.body.expiresIn).toBe(120);
  });

  it("404s (not 403) on someone else's file outside the caller's teams", async () => {
    const res = await downloadUrl(uploadedFileId, strangerToken);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('404s while the file is still pending upload', async () => {
    expect((await downloadUrl(pendingFileId, ownerToken)).status).toBe(404);
  });

  it('404s for an unknown file', async () => {
    expect((await downloadUrl(crypto.randomUUID(), ownerToken)).status).toBe(404);
  });

  // Blueprint: multipart is "submitter-only, same as the job reads", which answer 404
  // outside scope so the file's existence is not confirmed.
  it("404s multipart initiation on someone else's file (blueprint)", async () => {
    const res = await h.api('POST', `/files/${pendingFileId}/multipart`, { token: strangerToken });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    // Same answer as a file that does not exist at all.
    const unknown = await h.api('POST', `/files/${crypto.randomUUID()}/multipart`, { token: strangerToken });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(res.body);
  });
});
