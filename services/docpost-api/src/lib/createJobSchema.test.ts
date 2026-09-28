import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOLDER_DESTINATION_REQUIRED } from '@docpost/shared';
import { createJobSchema } from './createJobSchema.js';

const file = {
  name: 'note.pdf',
  sizeBytes: 12,
  contentType: 'application/pdf' as const,
  sha256: 'abc',
};

const folderDest = {
  teamId: '11111111-1111-4111-8111-111111111111',
  binderId: '22222222-2222-4222-8222-222222222222',
  folderId: '33333333-3333-4333-8333-333333333333',
};

function dest(folderId: string) {
  return { ...folderDest, folderId };
}

describe('createJobSchema', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects a binder with no folder', () => {
    const parsed = createJobSchema.safeParse({
      files: [file],
      destinations: [{ teamId: folderDest.teamId, binderId: folderDest.binderId }],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toBe(FOLDER_DESTINATION_REQUIRED);
  });

  it('rejects a null folderId', () => {
    const parsed = createJobSchema.safeParse({
      files: [file],
      destinations: [{ ...folderDest, folderId: null }],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toBe(FOLDER_DESTINATION_REQUIRED);
  });

  it('accepts a folder destination', () => {
    const parsed = createJobSchema.safeParse({
      files: [file],
      destinations: [folderDest],
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects more unique destinations than TOTAL_SUPPORTED_DESTINATIONS', () => {
    vi.stubEnv('TOTAL_SUPPORTED_DESTINATIONS', '2');
    const parsed = createJobSchema.safeParse({
      files: [file],
      destinations: [
        dest('33333333-3333-4333-8333-333333333331'),
        dest('33333333-3333-4333-8333-333333333332'),
        dest('33333333-3333-4333-8333-333333333333'),
      ],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toBe('You can send to at most 2 destinations');
  });

  it('accepts unique destinations up to the cap', () => {
    vi.stubEnv('TOTAL_SUPPORTED_DESTINATIONS', '2');
    const parsed = createJobSchema.safeParse({
      files: [file],
      destinations: [
        dest('33333333-3333-4333-8333-333333333331'),
        dest('33333333-3333-4333-8333-333333333332'),
      ],
    });

    expect(parsed.success).toBe(true);
  });
});
