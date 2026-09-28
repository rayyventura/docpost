import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AppError, NotFoundError } from '@docpost/shared';
import {
  assertObjectMatchesIngest,
  copySource,
  copyStagingObjectToDocument,
  documentObjectKey,
  headStagingObject,
  hexSha256ToBase64,
  presignDocumentDownload,
  sha256OfStagingObject,
  usesObjectStorage,
} from './s3.js';

const HEX = crypto.createHash('sha256').update('hello').digest('hex');
const B64 = crypto.createHash('sha256').update('hello').digest('base64');

const KEY = 'uploads/job/file.pdf';

// Every S3 call in this file goes through this spy; tests that need S3 queue responses.
const send = vi.spyOn(S3Client.prototype, 'send');

afterEach(() => {
  send.mockReset();
});

function objectBody(...chunks: Array<string | Buffer>) {
  return { Body: Readable.from(chunks.map((c) => Buffer.from(c))) } as never;
}

describe('hexSha256ToBase64', () => {
  it('converts a 64-char hex digest to the base64 form S3 reports', () => {
    expect(hexSha256ToBase64(HEX)).toBe(B64);
  });

  it('accepts upper-case hex', () => {
    expect(hexSha256ToBase64(HEX.toUpperCase())).toBe(B64);
  });

  it.each([
    ['empty', ''],
    ['too short', HEX.slice(0, 63)],
    ['too long', `${HEX}0`],
    ['non-hex characters', `${HEX.slice(0, 63)}g`],
    ['already base64', B64],
    ['surrounding whitespace', ` ${HEX}`],
    ['trailing newline', `${HEX}\n`],
  ])('returns null for %s', (_label, value) => {
    expect(hexSha256ToBase64(value)).toBeNull();
  });
});

describe('assertObjectMatchesIngest', () => {
  describe('full-object checksum fast path', () => {
    it('accepts a matching size and full-object checksum without reading the object', async () => {
      await expect(
        assertObjectMatchesIngest(KEY, { contentLength: 5, checksumSha256Base64: B64, checksumType: 'FULL_OBJECT' }, 5, HEX),
      ).resolves.toBeUndefined();
      expect(send).not.toHaveBeenCalled();
    });

    it('throws CHECKSUM_MISMATCH when the full-object checksum differs, without reading the object', async () => {
      const other = crypto.createHash('sha256').update('other').digest('base64');
      const err = await assertObjectMatchesIngest(
        KEY,
        { contentLength: 5, checksumSha256Base64: other, checksumType: 'FULL_OBJECT' },
        5,
        HEX,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ code: 'CHECKSUM_MISMATCH', statusCode: 422 });
      expect((err as Error).message).toContain(HEX);
      expect(send).not.toHaveBeenCalled();
    });

    it('strips quotes around the reported checksum', async () => {
      await expect(
        assertObjectMatchesIngest(
          KEY,
          { contentLength: 5, checksumSha256Base64: `"${B64}"`, checksumType: 'FULL_OBJECT' },
          5,
          HEX,
        ),
      ).resolves.toBeUndefined();
    });

    it('accepts an upper-case declared digest', async () => {
      await expect(
        assertObjectMatchesIngest(
          KEY,
          { contentLength: 5, checksumSha256Base64: B64, checksumType: 'FULL_OBJECT' },
          5,
          HEX.toUpperCase(),
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('size', () => {
    it('throws a 422 CHECKSUM_MISMATCH AppError on size mismatch without reading the object', async () => {
      const err = await assertObjectMatchesIngest(KEY, { contentLength: 4 }, 5, HEX).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ code: 'CHECKSUM_MISMATCH', statusCode: 422 });
      expect((err as Error).message).toBe('Declared size does not match. Expected 5, got 4');
      expect(send).not.toHaveBeenCalled();
    });

    it('checks size before checksum', async () => {
      await expect(
        assertObjectMatchesIngest(KEY, { contentLength: 6, checksumSha256Base64: 'bogus', checksumType: 'FULL_OBJECT' }, 5, HEX),
      ).rejects.toThrow(/Declared size/);
    });

    it('treats a zero-length object as a size mismatch against any positive declared size', async () => {
      await expect(assertObjectMatchesIngest(KEY, { contentLength: 0 }, 1, HEX)).rejects.toThrow(/Expected 1, got 0/);
    });
  });

  describe('streamed checksum (no full-object checksum from S3)', () => {
    it.each([
      ['S3 reports no checksum', { contentLength: 5 }],
      ['S3 reports a checksum but no ChecksumType', { contentLength: 5, checksumSha256Base64: B64 }],
      ['S3 reports a COMPOSITE (multipart) checksum', { contentLength: 5, checksumSha256Base64: `${B64}-3`, checksumType: 'COMPOSITE' }],
    ])('streams the staged object and accepts a matching digest when %s', async (_label, info) => {
      send.mockResolvedValueOnce(objectBody('hel', 'lo'));
      await expect(assertObjectMatchesIngest(KEY, info, 5, HEX)).resolves.toBeUndefined();
      expect(send).toHaveBeenCalledTimes(1);
      const cmd = send.mock.calls[0][0] as GetObjectCommand;
      expect(cmd).toBeInstanceOf(GetObjectCommand);
      expect(cmd.input).toEqual({ Bucket: 'docpost-staging-local', Key: KEY });
    });

    it('rejects a differing checksum when ChecksumType is not reported', async () => {
      // The stored bytes are 'other' (5 bytes), matching the checksum S3 reports.
      const other = crypto.createHash('sha256').update('other').digest('base64');
      send.mockResolvedValueOnce(objectBody('other'));
      const err = await assertObjectMatchesIngest(KEY, { contentLength: 5, checksumSha256Base64: other }, 5, HEX).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ code: 'CHECKSUM_MISMATCH', statusCode: 422 });
      expect((err as Error).message).toMatch(/Declared checksum/);
    });

    it('rejects when the streamed bytes do not hash to the declared digest (COMPOSITE)', async () => {
      send.mockResolvedValueOnce(objectBody('hellx'));
      await expect(
        assertObjectMatchesIngest(KEY, { contentLength: 5, checksumSha256Base64: `${B64}-2`, checksumType: 'COMPOSITE' }, 5, HEX),
      ).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH', statusCode: 422 });
    });

    it('accepts an upper-case declared digest', async () => {
      send.mockResolvedValueOnce(objectBody('hello'));
      await expect(assertObjectMatchesIngest(KEY, { contentLength: 5 }, 5, HEX.toUpperCase())).resolves.toBeUndefined();
    });

    it.each([
      ['NoSuchKey name', Object.assign(new Error('x'), { name: 'NoSuchKey' })],
      ['404 status', Object.assign(new Error('x'), { name: 'Unknown', $metadata: { httpStatusCode: 404 } })],
    ])('maps a missing object on GetObject (%s) to NotFoundError', async (_label, err) => {
      send.mockRejectedValueOnce(err);
      await expect(assertObjectMatchesIngest(KEY, { contentLength: 5 }, 5, HEX)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('maps a response without a body to NotFoundError', async () => {
      send.mockResolvedValueOnce({} as never);
      await expect(assertObjectMatchesIngest(KEY, { contentLength: 5 }, 5, HEX)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('rethrows a stream error mid-read unchanged', async () => {
      const boom = new Error('socket hang up');
      const body = new Readable({ read() {} });
      body.push(Buffer.from('he'));
      process.nextTick(() => body.destroy(boom));
      send.mockResolvedValueOnce({ Body: body } as never);
      await expect(assertObjectMatchesIngest(KEY, { contentLength: 5 }, 5, HEX)).rejects.toBe(boom);
    });

    it('rethrows other GetObject errors unchanged', async () => {
      const err = Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
      send.mockRejectedValueOnce(err);
      await expect(assertObjectMatchesIngest(KEY, { contentLength: 5 }, 5, HEX)).rejects.toBe(err);
    });
  });

  it.each(['xyz', B64, ''])(
    'rejects a declared checksum %j that is not a SHA-256 hex digest without reading the object',
    async (declared) => {
      await expect(
        assertObjectMatchesIngest(KEY, { contentLength: 5, checksumSha256Base64: B64, checksumType: 'FULL_OBJECT' }, 5, declared),
      ).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH', statusCode: 422 });
      await expect(assertObjectMatchesIngest(KEY, { contentLength: 5 }, 5, declared)).rejects.toMatchObject({
        code: 'CHECKSUM_MISMATCH',
      });
      expect(send).not.toHaveBeenCalled();
    },
  );
});

describe('sha256OfStagingObject', () => {
  it('hashes a large multi-chunk body incrementally', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const chunks = Array.from({ length: 8 }, () => chunk);
    const expected = crypto.createHash('sha256');
    chunks.forEach((c) => expected.update(c));
    send.mockResolvedValueOnce({ Body: Readable.from(chunks) } as never);
    await expect(sha256OfStagingObject(KEY)).resolves.toBe(expected.digest('hex'));
  });
});

describe('copySource', () => {
  it('joins bucket and key', () => {
    expect(copySource('b', 'uploads/a/b.pdf')).toBe('b/uploads/a/b.pdf');
  });

  it('preserves slashes while encoding each segment', () => {
    expect(copySource('b', 'uploads/job 1/file#2?.pdf')).toBe('b/uploads/job%201/file%232%3F.pdf');
  });

  it('encodes unicode, plus and percent characters', () => {
    expect(copySource('b', 'uploads/ré sumé+100%.pdf')).toBe('b/uploads/r%C3%A9%20sum%C3%A9%2B100%25.pdf');
  });

  it('keeps empty segments from consecutive or trailing slashes', () => {
    expect(copySource('b', 'uploads//x/')).toBe('b/uploads//x/');
  });

  it('encodes a key with no slashes', () => {
    expect(copySource('b', 'a&b=c')).toBe('b/a%26b%3Dc');
  });
});

describe('documentObjectKey', () => {
  it('stores documents under documents/<id>', () => {
    expect(documentObjectKey('abc')).toBe('documents/abc');
  });
});

describe('usesObjectStorage', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is false with neither S3_BUCKET nor S3_ENDPOINT', () => {
    vi.stubEnv('S3_BUCKET', '');
    vi.stubEnv('S3_ENDPOINT', '');
    expect(usesObjectStorage()).toBe(false);
  });

  it('is true with S3_BUCKET', () => {
    vi.stubEnv('S3_BUCKET', 'bucket');
    vi.stubEnv('S3_ENDPOINT', '');
    expect(usesObjectStorage()).toBe(true);
  });

  it('is true with S3_ENDPOINT', () => {
    vi.stubEnv('S3_BUCKET', '');
    vi.stubEnv('S3_ENDPOINT', 'http://localhost:4566');
    expect(usesObjectStorage()).toBe(true);
  });
});

describe('S3 calls (mocked client)', () => {
  describe('headStagingObject', () => {
    it('HEADs the staging key with checksum mode and maps the response', async () => {
      send.mockResolvedValueOnce({ ContentLength: 42, ChecksumSHA256: B64, ChecksumType: 'FULL_OBJECT' } as never);
      await expect(headStagingObject('uploads/x.pdf')).resolves.toEqual({
        contentLength: 42,
        checksumSha256Base64: B64,
        checksumType: 'FULL_OBJECT',
      });
      const cmd = send.mock.calls[0][0] as HeadObjectCommand;
      expect(cmd).toBeInstanceOf(HeadObjectCommand);
      expect(cmd.input).toEqual({ Bucket: 'docpost-staging-local', Key: 'uploads/x.pdf', ChecksumMode: 'ENABLED' });
    });

    it('defaults a missing ContentLength to 0', async () => {
      send.mockResolvedValueOnce({} as never);
      await expect(headStagingObject('uploads/x')).resolves.toMatchObject({ contentLength: 0 });
    });

    it.each([
      ['NotFound name', Object.assign(new Error('x'), { name: 'NotFound' })],
      ['NoSuchKey name', Object.assign(new Error('x'), { name: 'NoSuchKey' })],
      ['404 status', Object.assign(new Error('x'), { name: 'Unknown', $metadata: { httpStatusCode: 404 } })],
    ])('maps %s to NotFoundError', async (_label, err) => {
      send.mockRejectedValueOnce(err);
      await expect(headStagingObject('uploads/x')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('rethrows other errors unchanged', async () => {
      const err = Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
      send.mockRejectedValueOnce(err);
      await expect(headStagingObject('uploads/x')).rejects.toBe(err);
    });
  });

  describe('copyStagingObjectToDocument', () => {
    it('copies into documents/<id> with an encoded CopySource and replaced content type', async () => {
      send.mockResolvedValueOnce({} as never);
      await copyStagingObjectToDocument('uploads/job/my file.pdf', 'doc-1', 'application/pdf');
      const cmd = send.mock.calls[0][0] as CopyObjectCommand;
      expect(cmd).toBeInstanceOf(CopyObjectCommand);
      expect(cmd.input).toEqual({
        Bucket: 'docpost-staging-local',
        CopySource: 'docpost-staging-local/uploads/job/my%20file.pdf',
        Key: 'documents/doc-1',
        ContentType: 'application/pdf',
        MetadataDirective: 'REPLACE',
      });
    });

    it('maps a missing source to NotFoundError', async () => {
      send.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NoSuchKey' }));
      await expect(copyStagingObjectToDocument('uploads/x', 'd', 'application/pdf')).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('rethrows other errors', async () => {
      const err = new Error('boom');
      send.mockRejectedValueOnce(err);
      await expect(copyStagingObjectToDocument('uploads/x', 'd', 'application/pdf')).rejects.toBe(err);
    });
  });
});

describe('presignDocumentDownload', () => {
  beforeAll(() => {
    // Presigning is local computation; static fake credentials keep it offline.
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAUNITTEST');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'unit-test-secret');
    vi.stubEnv('AWS_SESSION_TOKEN', '');
    return () => vi.unstubAllEnvs();
  });

  it('signs a GET for documents/<id> that expires in 120 seconds', async () => {
    const url = new URL(await presignDocumentDownload('doc-1', 'report.pdf', 'application/pdf'));
    expect(url.pathname).toMatch(/documents\/doc-1$/);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it('strips quotes and CR/LF from the filename to prevent header injection', async () => {
    const url = new URL(await presignDocumentDownload('d', 'a"b\r\nSet-Cookie: x.pdf', 'application/pdf'));
    const disposition = url.searchParams.get('response-content-disposition')!;
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toBe(
      `attachment; filename="abSet-Cookie: x.pdf"; filename*=UTF-8''abSet-Cookie%3A%20x.pdf`,
    );
  });

  it('adds an RFC 5987 filename* for non-ASCII names', async () => {
    const url = new URL(await presignDocumentDownload('d', 'résumé.pdf', 'application/pdf'));
    expect(url.searchParams.get('response-content-disposition')).toContain(
      `filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`,
    );
  });
});
