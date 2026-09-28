import { describe, expect, it } from 'vitest';
import { FOLDER_DESTINATION_REQUIRED } from '@docpost/shared';
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
  it('rejects a size mismatch without reading file bytes', () => {
    expect(() =>
      assertObjectMatchesIngest({ contentLength: 10 }, 11, valid.checksumSha256),
    ).toThrow(/Declared size does not match/);
  });

  it('compares a full-object S3 checksum when present', () => {
    const checksum = hexSha256ToBase64(valid.checksumSha256);
    expect(checksum).toBeTruthy();
    expect(() =>
      assertObjectMatchesIngest(
        { contentLength: valid.sizeBytes, checksumSha256Base64: checksum!, checksumType: 'FULL_OBJECT' },
        valid.sizeBytes,
        valid.checksumSha256,
      ),
    ).not.toThrow();
  });
});
