import { describe, expect, it } from 'vitest';
import { computeSha256 } from './useFileHash';

describe('computeSha256', () => {
  it('matches known SHA-256 vectors', async () => {
    expect(await computeSha256(new File([], 'empty.bin'))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await computeSha256(new File([new Uint8Array([97, 98, 99])], 'abc.bin'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
