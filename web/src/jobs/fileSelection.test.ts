import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SelectedFile } from './types';
import {
  ACCEPT_ATTRIBUTE,
  MAX_FILES,
  MAX_SIZE,
  applyFileUpdate,
  createFileId,
  fileContentType,
  planFileSelection,
} from './fileSelection';

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const pick = (name: string, type: string, size = 10) => ({ name, type, size });

describe('fileContentType', () => {
  it('keeps a supported reported type', () => {
    expect(fileContentType(pick('a.pdf', PDF))).toBe(PDF);
  });

  it('falls back to the extension when mobile pickers report no type', () => {
    expect(fileContentType(pick('Scan 12.PDF', ''))).toBe(PDF);
    expect(fileContentType(pick('report.docx', ''))).toBe(DOCX);
  });

  it('falls back to the extension for generic types from cloud providers', () => {
    expect(fileContentType(pick('report.docx', 'application/octet-stream'))).toBe(DOCX);
  });

  it('normalises non-standard JPEG types', () => {
    expect(fileContentType(pick('photo', 'image/jpg'))).toBe('image/jpeg');
    expect(fileContentType(pick('photo', 'IMAGE/PJPEG'))).toBe('image/jpeg');
  });

  it('rejects HEIC photos and files with no usable type or extension', () => {
    expect(fileContentType(pick('IMG_0001.HEIC', 'image/heic'))).toBe('');
    expect(fileContentType(pick('document', ''))).toBe('');
    expect(fileContentType(pick('archive.pdf.zip', 'application/zip'))).toBe('');
  });
});

describe('ACCEPT_ATTRIBUTE', () => {
  it('lists MIME types and extensions so mobile pickers do not grey files out', () => {
    const parts = ACCEPT_ATTRIBUTE.split(',');
    expect(parts).toEqual(expect.arrayContaining([PDF, DOCX, 'image/jpeg', '.pdf', '.docx', '.jpg']));
    expect(parts).not.toContain('image/heic');
  });
});

describe('createFileId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses crypto.randomUUID when available', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'from-random-uuid' });
    expect(createFileId()).toBe('from-random-uuid');
  });

  it('works without crypto.randomUUID (iOS Safari < 15.4, non-secure pages)', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(0xab));
    vi.stubGlobal('crypto', { getRandomValues });
    const id = createFileId();
    expect(getRandomValues).toHaveBeenCalled();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('works with no crypto at all', () => {
    vi.stubGlobal('crypto', undefined);
    const ids = new Set(Array.from({ length: 50 }, () => createFileId()));
    expect(ids.size).toBe(50);
  });
});

describe('planFileSelection', () => {
  it('accepts supported files with no error', () => {
    const files = [pick('a.pdf', ''), pick('b.jpg', 'image/jpeg')];
    expect(planFileSelection(files, 0)).toEqual({ accepted: files, error: null });
  });

  it('explains why a lone unsupported file was not added', () => {
    const plan = planFileSelection([pick('IMG_0001.HEIC', 'image/heic')], 0);
    expect(plan.accepted).toEqual([]);
    expect(plan.error).toBe("IMG_0001.HEIC can't be sent. Use PDF, DOCX, XLSX, PNG, or JPG.");
  });

  it('explains why an empty file was not added instead of silently dropping it', () => {
    const plan = planFileSelection([pick('blank.pdf', PDF, 0)], 0);
    expect(plan.accepted).toEqual([]);
    expect(plan.error).toBe('blank.pdf is empty and cannot be sent.');
  });

  it('always reports oversize files', () => {
    const ok = pick('a.pdf', PDF);
    const plan = planFileSelection([ok, pick('big.pdf', PDF, MAX_SIZE + 1)], 0);
    expect(plan.accepted).toEqual([ok]);
    expect(plan.error).toBe('big.pdf is larger than 1 GB and cannot be sent.');
  });

  it('does not raise a blocking error when some files were added', () => {
    const ok = pick('a.pdf', PDF);
    const plan = planFileSelection([ok, pick('b.heic', 'image/heic')], 0);
    expect(plan).toEqual({ accepted: [ok], error: null });
  });

  it('caps at the file limit and says so when nothing fits', () => {
    const files = [pick('a.pdf', PDF), pick('b.pdf', PDF)];
    expect(planFileSelection(files, MAX_FILES - 1).accepted).toEqual([files[0]]);
    expect(planFileSelection(files, MAX_FILES)).toEqual({
      accepted: [],
      error: `You can send up to ${MAX_FILES} files at a time.`,
    });
  });
});

describe('applyFileUpdate', () => {
  const selected = (id: string): SelectedFile => ({
    id,
    file: new File(['x'], `${id}.pdf`, { type: PDF }),
    sha256: '',
    status: 'hashing',
    progress: 0,
  });

  it('returns a new array and a new object for the updated file only', () => {
    const files = [selected('a'), selected('b')];
    const next = applyFileUpdate(files, 'b', { status: 'ready', sha256: 'abc' });
    expect(next).not.toBe(files);
    expect(next[0]).toBe(files[0]);
    expect(next[1]).not.toBe(files[1]);
    expect(next[1]).toMatchObject({ id: 'b', status: 'ready', sha256: 'abc' });
    expect(files[1].status).toBe('hashing');
  });

  it('is a no-op when the file was removed while hashing', () => {
    const files = [selected('a')];
    expect(applyFileUpdate(files, 'gone', { status: 'ready' })).toBe(files);
  });
});
