import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getDb } from '../db/index.js';
import { documents } from '../db/schema.js';
import type { Harness } from '../test/harness.js';
import { BUCKET, sha256Hex, startHarness, uid } from '../test/harness.js';

describe.skipIf(!process.env.INTEGRATION)('platform documents routes (integration)', () => {
  let h: Harness;
  let ingestToken: string;
  const member = uid();
  const outsider = uid();
  let binderId: string;
  let folderId: string;
  let otherBinderFolderId: string;

  beforeAll(async () => {
    h = await startHarness();
    ingestToken = await h.serviceToken('documents:ingest');
    const f = h.fixtures;
    const teamId = await f.team();
    const otherTeam = await f.team();
    await f.member(teamId, member);
    await f.member(otherTeam, outsider);
    binderId = await f.binder(teamId);
    folderId = await f.folder(binderId);
    const secondBinder = await f.binder(teamId);
    otherBinderFolderId = await f.folder(secondBinder);
  });

  afterAll(async () => {
    await h?.close();
  });

  async function rowsForTask(taskId: string) {
    return getDb().select().from(documents).where(eq(documents.sourceTaskId, taskId));
  }

  async function staged(content = `pdf bytes ${uid()}`) {
    const bytes = Buffer.from(content);
    const s3Key = await h.fixtures.stageObject(bytes);
    return { bytes, s3Key, checksumSha256: sha256Hex(bytes), sizeBytes: bytes.length };
  }

  function body(over: Record<string, unknown> & { s3Key: string; sizeBytes: number; checksumSha256: string }) {
    return {
      taskId: uid(),
      binderId,
      folderId,
      name: 'Protocol "v2".pdf',
      contentType: 'application/pdf',
      onBehalfOf: member,
      ...over,
    };
  }

  async function ingest(payload: unknown, token = ingestToken) {
    const res = await h.request('/documents', { method: 'POST', token, json: payload });
    const json = res.status === 204 ? null : await res.json();
    if (json?.documentId) h.fixtures.trackDocument(json.documentId);
    return { status: res.status, json };
  }

  describe('POST /documents', () => {
    it('copies the staged object to documents/<id> and creates the row (201)', async () => {
      const obj = await staged();
      const payload = body(obj);
      const { status, json } = await ingest(payload);

      expect(status).toBe(201);
      expect(json.documentId).toMatch(/^[0-9a-f-]{36}$/);

      const [row] = await rowsForTask(payload.taskId);
      expect(row).toMatchObject({
        id: json.documentId,
        binderId,
        folderId,
        name: payload.name,
        sizeBytes: BigInt(obj.sizeBytes),
        contentType: 'application/pdf',
        checksumSha256: obj.checksumSha256,
        sourceTaskId: payload.taskId,
        uploadedByUserId: member,
      });

      const copied = await h.fixtures.getObject(`documents/${json.documentId}`);
      expect(copied.bytes.equals(obj.bytes)).toBe(true);
      expect(copied.contentType).toBe('application/pdf');
      // The staged source is left in place (lifecycle expiry removes it).
      await expect(h.s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: obj.s3Key }))).resolves.toBeDefined();
    });

    it('is idempotent on a repeated taskId: 200 with the same documentId and a single row', async () => {
      const obj = await staged();
      const payload = body(obj);
      const first = await ingest(payload);
      const second = await ingest(payload);
      const third = await ingest(payload);

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(third.status).toBe(200);
      expect(second.json.documentId).toBe(first.json.documentId);
      expect(third.json.documentId).toBe(first.json.documentId);
      expect(await rowsForTask(payload.taskId)).toHaveLength(1);
    });

    it('stays idempotent under concurrent deliveries of the same taskId', async () => {
      const obj = await staged();
      const payload = body(obj);
      const results = await Promise.all([ingest(payload), ingest(payload), ingest(payload)]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 200, 201]);
      expect(new Set(results.map((r) => r.json.documentId)).size).toBe(1);
      expect(await rowsForTask(payload.taskId)).toHaveLength(1);
    });

    it('returns 403 when onBehalfOf is not a member of the binder team', async () => {
      const obj = await staged();
      const payload = body({ ...obj, onBehalfOf: outsider });
      const { status, json } = await ingest(payload);
      expect(status).toBe(403);
      expect(json.error.code).toBe('FORBIDDEN');
      expect(await rowsForTask(payload.taskId)).toHaveLength(0);
    });

    it('returns 403 when the binder does not exist', async () => {
      const obj = await staged();
      const payload = body({ ...obj, binderId: uid() });
      expect((await ingest(payload)).status).toBe(403);
      expect(await rowsForTask(payload.taskId)).toHaveLength(0);
    });

    it('returns 422 when the folder belongs to a different binder', async () => {
      const obj = await staged();
      const payload = body({ ...obj, folderId: otherBinderFolderId });
      const { status, json } = await ingest(payload);
      expect(status).toBe(422);
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(await rowsForTask(payload.taskId)).toHaveLength(0);
    });

    it('returns 422 CHECKSUM_MISMATCH when the declared size differs from the staged object', async () => {
      const obj = await staged();
      const payload = body({ ...obj, sizeBytes: obj.sizeBytes + 1 });
      const { status, json } = await ingest(payload);
      expect(status).toBe(422);
      expect(json.error.code).toBe('CHECKSUM_MISMATCH');
      expect(await rowsForTask(payload.taskId)).toHaveLength(0);
    });

    // LocalStack reports ChecksumSHA256 without ChecksumType (and multipart uploads
    // report COMPOSITE), so this exercises the streamed-hash path.
    it('returns 422 CHECKSUM_MISMATCH when the declared SHA-256 differs (same size)', async () => {
      const obj = await staged();
      const payload = body({ ...obj, checksumSha256: sha256Hex(Buffer.from('something else')) });
      const { status, json } = await ingest(payload);
      expect(status).toBe(422);
      expect(json.error.code).toBe('CHECKSUM_MISMATCH');
      expect(await rowsForTask(payload.taskId)).toHaveLength(0);
    });

    it('verifies the checksum of a staged object uploaded without an S3 checksum', async () => {
      const bytes = Buffer.from(`no s3 checksum ${uid()}`);
      const s3Key = `uploads/it-${uid()}/unchecksummed.pdf`;
      await h.s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, Body: bytes, ContentType: 'application/pdf' }));
      h.fixtures.objectKeys.push(s3Key);
      const head = await h.s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: s3Key, ChecksumMode: 'ENABLED' }));
      expect(head.ChecksumType).not.toBe('FULL_OBJECT');

      const bad = body({ s3Key, sizeBytes: bytes.length, checksumSha256: sha256Hex(Buffer.from('nope')) });
      const rejected = await ingest(bad);
      expect(rejected.status).toBe(422);
      expect(rejected.json.error.code).toBe('CHECKSUM_MISMATCH');

      const good = body({ s3Key, sizeBytes: bytes.length, checksumSha256: sha256Hex(bytes) });
      expect((await ingest(good)).status).toBe(201);
    });

    it('returns 404 when the staged source object is missing', async () => {
      const payload = body({
        s3Key: `uploads/it-${uid()}/never-uploaded.pdf`,
        sizeBytes: 10,
        checksumSha256: 'a'.repeat(64),
      });
      const { status, json } = await ingest(payload);
      expect(status).toBe(404);
      expect(json.error.code).toBe('NOT_FOUND');
      expect(await rowsForTask(payload.taskId)).toHaveLength(0);
    });

    it('rejects a source key outside uploads/ with 422', async () => {
      const obj = await staged();
      const payload = body({ ...obj, s3Key: 'documents/someone-else' });
      expect((await ingest(payload)).status).toBe(422);
    });

    it('rejects a disallowed content type with 422', async () => {
      const obj = await staged();
      const payload = body({ ...obj, contentType: 'application/x-msdownload' });
      expect((await ingest(payload)).status).toBe(422);
    });

    it('requires the documents:ingest service scope', async () => {
      const obj = await staged();
      const payload = body(obj);
      expect((await ingest(payload, await h.serviceToken('memberships:read'))).status).toBe(403);
      expect((await ingest(payload, await h.serviceToken('documents:ingest:extra memberships:write'))).status).toBe(
        403,
      );
      expect((await ingest(payload, await h.userToken(member, { scope: 'documents:ingest' }))).status).toBe(403);
      const noToken = await h.request('/documents', { method: 'POST', json: payload });
      expect(noToken.status).toBe(401);
      expect(await rowsForTask(payload.taskId)).toHaveLength(0);

      // A token carrying the scope among others is accepted.
      expect((await ingest(payload, await h.serviceToken('memberships:read documents:ingest'))).status).toBe(201);
    });

    // 422 (not 5xx) so the delivery worker fails fast instead of retrying to the DLQ.
    it.each(['taskId', 'binderId', 'folderId', 'onBehalfOf'])(
      'returns 422 VALIDATION_ERROR for a malformed %s',
      async (field) => {
        const obj = await staged();
        const payload = body({ ...obj, [field]: 'not-a-uuid' });
        const { status, json } = await ingest(payload);
        expect(status).toBe(422);
        expect(json.error).toMatchObject({ code: 'VALIDATION_ERROR', message: `${field} must be a UUID` });
        if (field !== 'taskId') expect(await rowsForTask(payload.taskId as string)).toHaveLength(0);
      },
    );
  });

  describe('GET /documents/:documentId/download', () => {
    let documentId: string;
    let bytes: Buffer;
    const filename = 'Protocol "v2".pdf';

    beforeAll(async () => {
      const obj = await staged(`download bytes ${uid()}`);
      bytes = obj.bytes;
      const { status, json } = await ingest(body({ ...obj, name: filename }));
      expect(status).toBe(201);
      documentId = json.documentId;
    });

    it('returns a 120s presigned URL that fetches the bytes from S3', async () => {
      const res = await h.request(`/documents/${documentId}/download`, { token: await h.userToken(member) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.expiresIn).toBe(120);

      const url = new URL(json.url);
      expect(url.pathname).toBe(`/${BUCKET}/documents/${documentId}`);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
      expect(url.searchParams.get('response-content-type')).toBe('application/pdf');
      expect(url.searchParams.get('response-content-disposition')).toBe(
        `attachment; filename="Protocol v2.pdf"; filename*=UTF-8''Protocol%20v2.pdf`,
      );

      const download = await fetch(json.url);
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true);
      expect(download.headers.get('content-type')).toBe('application/pdf');
      expect(download.headers.get('content-disposition')).toContain('attachment; filename="Protocol v2.pdf"');
    });

    it('returns 403 for a non-member', async () => {
      const res = await h.request(`/documents/${documentId}/download`, { token: await h.userToken(outsider) });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('FORBIDDEN');
    });

    it('returns 404 for an unknown document', async () => {
      const res = await h.request(`/documents/${uid()}/download`, { token: await h.userToken(member) });
      expect(res.status).toBe(404);
    });

    it('returns the same 404 as an unknown document for a malformed document id', async () => {
      const res = await h.request('/documents/not-a-uuid/download', { token: await h.userToken(member) });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('NOT_FOUND');
    });

    it('returns 403 (not a 500) for a token whose subject is not a uuid', async () => {
      const res = await h.request(`/documents/${documentId}/download`, { token: await h.userToken('not-a-uuid') });
      expect(res.status).toBe(403);
    });

    it('rejects service tokens and missing tokens', async () => {
      const svc = await h.request(`/documents/${documentId}/download`, {
        token: await h.serviceToken('documents:ingest'),
      });
      expect(svc.status).toBe(403);
      const none = await h.request(`/documents/${documentId}/download`);
      expect(none.status).toBe(401);
    });
  });
});
