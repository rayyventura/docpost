import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { CopyObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AppError, NotFoundError } from '@docpost/shared';
import {
  assertObjectMatchesIngest,
  copySource,
  copyStagingObjectToDocument,
  documentObjectKey,
  headStagingObject,
  hexSha256ToBase64,
  presignDocumentDownload,
  usesObjectStorage,
} from './s3.js';

const HEX = crypto.createHash('sha256').update('hello').digest('hex');
const B64 = crypto.createHash('sha256').update('hello').digest('base64');

function catchError(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected function to throw');
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
  it('accepts a matching size and full-object checksum', () => {
    expect(() =>
      assertObjectMatchesIngest({ contentLength: 5, checksumSha256Base64: B64, checksumType: 'FULL_OBJECT' }, 5, HEX),
    ).not.toThrow();
  });

  it('throws a 422 CHECKSUM_MISMATCH AppError on size mismatch', () => {
    const err = catchError(() => assertObjectMatchesIngest({ contentLength: 4 }, 5, HEX));
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'CHECKSUM_MISMATCH', statusCode: 422 });
    expect((err as Error).message).toBe('Declared size does not match. Expected 5, got 4');
  });

  it('checks size before checksum', () => {
    expect(() =>
      assertObjectMatchesIngest({ contentLength: 6, checksumSha256Base64: 'bogus', checksumType: 'FULL_OBJECT' }, 5, HEX),
    ).toThrow(/Declared size/);
  });

  it('throws CHECKSUM_MISMATCH when the full-object checksum differs', () => {
    const other = crypto.createHash('sha256').update('other').digest('base64');
    const err = catchError(() =>
      assertObjectMatchesIngest({ contentLength: 5, checksumSha256Base64: other, checksumType: 'FULL_OBJECT' }, 5, HEX),
    );
    expect(err).toMatchObject({ code: 'CHECKSUM_MISMATCH', statusCode: 422 });
    expect((err as Error).message).toContain(HEX);
  });

  it('strips quotes around the reported checksum', () => {
    expect(() =>
      assertObjectMatchesIngest(
        { contentLength: 5, checksumSha256Base64: `"${B64}"`, checksumType: 'FULL_OBJECT' },
        5,
        HEX,
      ),
    ).not.toThrow();
  });

  it('skips checksum comparison for COMPOSITE (multipart) checksums', () => {
    expect(() =>
      assertObjectMatchesIngest({ contentLength: 5, checksumSha256Base64: `${B64}-3`, checksumType: 'COMPOSITE' }, 5, HEX),
    ).not.toThrow();
  });

  it('skips checksum comparison when S3 reports no checksum', () => {
    expect(() => assertObjectMatchesIngest({ contentLength: 5 }, 5, HEX)).not.toThrow();
  });

  it('skips checksum comparison when the declared checksum is not valid hex', () => {
    expect(() =>
      assertObjectMatchesIngest({ contentLength: 5, checksumSha256Base64: B64, checksumType: 'FULL_OBJECT' }, 5, 'xyz'),
    ).not.toThrow();
  });

  // GAP: when ChecksumType is absent (LocalStack, or objects without the header) a
  // present, single-part ChecksumSHA256 is ignored even though it could be compared.
  it.fails('rejects a differing checksum when ChecksumType is not reported', () => {
    const other = crypto.createHash('sha256').update('other').digest('base64');
    expect(() => assertObjectMatchesIngest({ contentLength: 5, checksumSha256Base64: other }, 5, HEX)).toThrow(
      /Declared checksum/,
    );
  });

  it('treats a zero-length object as a size mismatch against any positive declared size', () => {
    expect(() => assertObjectMatchesIngest({ contentLength: 0 }, 1, HEX)).toThrow(/Expected 1, got 0/);
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
  const send = vi.spyOn(S3Client.prototype, 'send');

  afterEach(() => {
    send.mockReset();
  });

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
