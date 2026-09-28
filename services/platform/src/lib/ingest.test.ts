import { describe, expect, it } from 'vitest';
import { FOLDER_DESTINATION_REQUIRED, ValidationError } from '@docpost/shared';
import { assertStagingObjectKey, parseIngestBody } from './ingest.js';
import { assertObjectMatchesIngest, copySource, hexSha256ToBase64 } from './s3.js';

const valid = {
  taskId: '11111111-1111-4111-8111-111111111111',
  binderId: '22222222-2222-4222-8222-222222222222',
  folderId: '33333333-3333-4333-8333-333333333333',
  name: 'protocol.pdf',
  contentType: 'application/pdf',
  checksumSha256: 'a'.repeat(64),
  onBehalfOf: '44444444-4444-4444-8444-444444444444',
  s3Key: 'uploads/job/file/protocol.pdf',
  sizeBytes: 950 * 1024 * 1024,
};

describe('parseIngestBody', () => {
  it('accepts JSON metadata with a staging key and no file bytes', () => {
    expect(parseIngestBody(valid)).toEqual(valid);
  });

  it('rejects a binder with no folder', () => {
    expect(() => parseIngestBody({ ...valid, folderId: '' })).toThrow(FOLDER_DESTINATION_REQUIRED);
  });

  it('rejects keys outside uploads/', () => {
    expect(() => parseIngestBody({ ...valid, s3Key: 'documents/other' })).toThrow('Invalid source object key');
    expect(() => assertStagingObjectKey('uploads/../secret')).toThrow('Invalid source object key');
  });
});

describe('copySource', () => {
  it('encodes each key segment so filenames with spaces copy', () => {
    expect(copySource('bucket', 'uploads/job/file/large 950MB.pdf')).toBe(
      'bucket/uploads/job/file/large%20950MB.pdf',
    );
  });
});

describe('assertObjectMatchesIngest', () => {
  it('rejects a size mismatch without reading file bytes', async () => {
    await expect(
      assertObjectMatchesIngest(valid.s3Key, { contentLength: 10 }, 11, valid.checksumSha256),
    ).rejects.toThrow(/Declared size does not match/);
  });

  it('compares a full-object S3 checksum when present', async () => {
    const checksum = hexSha256ToBase64(valid.checksumSha256);
    expect(checksum).toBeTruthy();
    await expect(
      assertObjectMatchesIngest(
        valid.s3Key,
        { contentLength: valid.sizeBytes, checksumSha256Base64: checksum!, checksumType: 'FULL_OBJECT' },
        valid.sizeBytes,
        valid.checksumSha256,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('parseIngestBody edge cases', () => {
  it.each([null, undefined, 'string', 42, []])('rejects a non-object body %j', (raw) => {
    expect(() => parseIngestBody(raw)).toThrow(/Request body must be a JSON object|must include/);
  });

  it.each(['taskId', 'binderId', 'name', 'contentType', 'checksumSha256', 'onBehalfOf', 's3Key'])(
    'rejects a missing or non-string %s',
    (field) => {
      const { [field as keyof typeof valid]: _omit, ...rest } = valid;
      expect(() => parseIngestBody(rest)).toThrow(/must include/);
      expect(() => parseIngestBody({ ...valid, [field]: 123 })).toThrow(/must include/);
    },
  );

  it.each([undefined, null, 42])('rejects folderId %j as a missing folder destination', (folderId) => {
    expect(() => parseIngestBody({ ...valid, folderId })).toThrow(FOLDER_DESTINATION_REQUIRED);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '10', null])('rejects sizeBytes %j', (sizeBytes) => {
    expect(() => parseIngestBody({ ...valid, sizeBytes })).toThrow('sizeBytes must be a positive integer');
  });

  it('accepts sizes above 2^32 (large PDFs)', () => {
    expect(parseIngestBody({ ...valid, sizeBytes: 5 * 1024 ** 3 }).sizeBytes).toBe(5 * 1024 ** 3);
  });

  it.each([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/png',
    'image/jpeg',
  ])('accepts allow-listed content type %s', (contentType) => {
    expect(parseIngestBody({ ...valid, contentType }).contentType).toBe(contentType);
  });

  it.each(['application/x-msdownload', 'application/octet-stream', 'text/html', 'APPLICATION/PDF', 'application/pdf; charset=binary'])(
    'rejects content type %s',
    (contentType) => {
      expect(() => parseIngestBody({ ...valid, contentType })).toThrow(/Unsupported content type/);
    },
  );

  it.each(['taskId', 'binderId', 'folderId', 'onBehalfOf'])('rejects a malformed %s with a ValidationError', (field) => {
    for (const value of ['not-a-uuid', '1', `${valid[field as keyof typeof valid]}x`]) {
      const err = (() => {
        try {
          parseIngestBody({ ...valid, [field]: value });
        } catch (e) {
          return e;
        }
        return undefined;
      })();
      expect(err).toBeInstanceOf(ValidationError);
      expect(err).toMatchObject({ statusCode: 422, message: `${field} must be a UUID` });
    }
  });

  it('drops unknown fields from the parsed result', () => {
    expect(parseIngestBody({ ...valid, extra: 'x', uploadedByUserId: 'spoof' })).toEqual(valid);
  });
});

describe('assertStagingObjectKey', () => {
  it.each(['uploads/a', 'uploads/job/file/name with spaces.pdf', 'uploads/ünïcode.pdf'])('accepts %j', (key) => {
    expect(() => assertStagingObjectKey(key)).not.toThrow();
  });

  it.each(['', 'upload/a', '/uploads/a', 'Uploads/a', 'documents/x', 'uploads/a/../../documents/x', 'uploads\\a', 'uploads/a\0b'])(
    'rejects %j',
    (key) => {
      expect(() => assertStagingObjectKey(key)).toThrow('Invalid source object key');
    },
  );
});
