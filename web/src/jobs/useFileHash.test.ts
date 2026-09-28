import { describe, expect, it } from 'vitest';
import { computeSha256 } from './useFileHash';

async function referenceSha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function bytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

describe('computeSha256', () => {
  it('matches known SHA-256 vectors', async () => {
    expect(await computeSha256(new File([], 'empty.bin'))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await computeSha256(new File([new Uint8Array([97, 98, 99])], 'abc.bin'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('gives the same digest however the file is sliced', async () => {
    const data = bytes(3_000);
    const expected = await referenceSha256(data);
    const file = new File([data], 'data.bin');
    // Chunk sizes that do and do not align with the 64-byte block size.
    for (const chunkSize of [37, 63, 64, 65, 1000, 3_000, 1 << 20]) {
      expect(await computeSha256(file, chunkSize)).toBe(expected);
    }
  });

  it('reads the file in slices rather than all at once', async () => {
    const data = bytes(1000);
    const file = new File([data], 'data.bin');
    const sliceSizes: number[] = [];
    const tracked = new Proxy(file, {
      get(target, prop) {
        if (prop === 'slice') {
          return (start: number, end: number) => {
            sliceSizes.push(end - start);
            return target.slice(start, end);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const digest = await computeSha256(tracked, 256);
    expect(sliceSizes).toEqual([256, 256, 256, 232]);
    expect(digest).toBe(await referenceSha256(data));
  });

  it('rejects when the file cannot be read, so the picker can show an error', async () => {
    const unreadable = {
      size: 10,
      slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }),
    } as unknown as Blob;
    await expect(computeSha256(unreadable)).rejects.toThrow('NotReadableError');
  });

  it('rejects an invalid chunk size', async () => {
    await expect(computeSha256(new File(['x'], 'x.bin'), 0)).rejects.toThrow(RangeError);
  });
});
