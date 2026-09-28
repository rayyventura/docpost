export type PageToken = number | 'gap';

export function visiblePageNumbers(current: number, total: number): PageToken[] {
  if (total < 1) return [];
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }

  const pages = new Set<number>([1, total]);
  for (let page = current - 1; page <= current + 1; page += 1) {
    if (page >= 1 && page <= total) pages.add(page);
  }
  if (current <= 3) {
    [1, 2, 3, 4, 5].forEach((page) => pages.add(page));
  }
  if (current >= total - 2) {
    [total - 4, total - 3, total - 2, total - 1, total].forEach((page) => pages.add(page));
  }

  const ordered = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const tokens: PageToken[] = [];
  for (const page of ordered) {
    const previous = tokens[tokens.length - 1];
    if (typeof previous === 'number' && page - previous > 1) {
      tokens.push('gap');
    }
    tokens.push(page);
  }
  return tokens;
}
