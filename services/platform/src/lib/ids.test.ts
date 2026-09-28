import { describe, expect, it } from 'vitest';
import { isUuid } from './ids.js';

describe('isUuid', () => {
  it.each(['11111111-1111-4111-8111-111111111111', 'ABCDEF01-2345-6789-abcd-ef0123456789'])('accepts %s', (value) => {
    expect(isUuid(value)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['plain text', 'not-a-uuid'],
    ['missing hyphens', '11111111111141118111111111111111'],
    ['too short', '11111111-1111-4111-8111-11111111111'],
    ['non-hex', '1111111g-1111-4111-8111-111111111111'],
    ['surrounding whitespace', ' 11111111-1111-4111-8111-111111111111'],
    ['braces', '{11111111-1111-4111-8111-111111111111}'],
    ['number', 42],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isUuid(value)).toBe(false);
  });
});
