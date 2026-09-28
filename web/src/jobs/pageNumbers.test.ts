import { describe, expect, it } from 'vitest';
import { visiblePageNumbers } from './pageNumbers';

describe('visiblePageNumbers', () => {
  it('lists every page when there are few of them', () => {
    expect(visiblePageNumbers(2, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps the first, last, and a window around the current page', () => {
    expect(visiblePageNumbers(8, 20)).toEqual([1, 'gap', 7, 8, 9, 'gap', 20]);
  });

  it('opens the start of the range without a leading gap', () => {
    expect(visiblePageNumbers(1, 20)).toEqual([1, 2, 3, 4, 5, 'gap', 20]);
  });
});
