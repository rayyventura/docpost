import { describe, expect, it } from 'vitest';
import { documentIngestBody } from './handler.js';

describe('documentIngestBody', () => {
  it('sends staging metadata with s3Key and sizeBytes and no file bytes', () => {
    const body = documentIngestBody(
      {
        originalName: 'protocol.pdf',
        contentType: 'application/pdf',
        checksumSha256: 'a'.repeat(64),
        ownerUserId: 'user-1',
        s3Key: 'uploads/job/file/protocol.pdf',
        sizeBytes: 950 * 1024 * 1024,
      },
      {
        id: 'task-1',
        binderId: 'binder-1',
        folderId: 'folder-1',
      },
    );

    expect(body).toEqual({
      taskId: 'task-1',
      binderId: 'binder-1',
      folderId: 'folder-1',
      name: 'protocol.pdf',
      contentType: 'application/pdf',
      checksumSha256: 'a'.repeat(64),
      onBehalfOf: 'user-1',
      s3Key: 'uploads/job/file/protocol.pdf',
      sizeBytes: 950 * 1024 * 1024,
    });
    expect(Object.keys(body).sort()).toEqual(
      [
        'binderId',
        'checksumSha256',
        'contentType',
        'folderId',
        'name',
        'onBehalfOf',
        's3Key',
        'sizeBytes',
        'taskId',
      ].sort(),
    );
    expect(JSON.stringify(body)).not.toMatch(/data:|buffer|blob/i);
  });
});
