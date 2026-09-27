import { describe, expect, it } from 'vitest';
import { uploadForTask, type JobUploadFile } from './jobUploads';

const upload: JobUploadFile = {
  serverFileId: 'file-1',
  fileName: 'note.pdf',
  status: 'uploading',
  progress: 42,
};

describe('uploadForTask', () => {
  it('matches by server file id first', () => {
    expect(uploadForTask({ fileId: 'file-1', fileName: 'other.pdf' }, { 'file-1': upload })).toBe(upload);
  });

  it('falls back to file name when the id is not on the row yet', () => {
    expect(uploadForTask({ fileId: '', fileName: 'note.pdf' }, { 'file-1': upload })).toBe(upload);
  });
});
