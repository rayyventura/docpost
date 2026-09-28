import { useEffect, useState } from 'react';
import { visiblePageNumbers } from './jobs/pageNumbers';

export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

interface PaginationProps {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  pageSize?: number;
  onPageSizeChange?: (pageSize: number) => void;
}

export function Pagination({
  page,
  pageCount,
  onPageChange,
  pageSize,
  onPageSizeChange,
}: PaginationProps) {
  const [draft, setDraft] = useState(String(page));
  const showPageNav = pageCount > 1;
  const showPageSize = Boolean(onPageSizeChange && pageSize);

  useEffect(() => {
    setDraft(String(page));
  }, [page]);

  if (!showPageNav && !showPageSize) return null;

  const goTo = (next: number) => {
    const clamped = Math.min(pageCount, Math.max(1, next));
    if (clamped !== page) onPageChange(clamped);
  };

  const jump = () => {
    const next = Number.parseInt(draft, 10);
    if (Number.isFinite(next)) goTo(next);
    else setDraft(String(page));
  };

  const changePageSize = (value: string) => {
    const next = Number.parseInt(value, 10);
    if (!Number.isFinite(next) || !onPageSizeChange) return;
    onPageSizeChange(Math.min(MAX_PAGE_SIZE, Math.max(1, next)));
  };

  return (
    <nav className="pagination" aria-label="Pages">
      {showPageNav ? (
        <>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page <= 1}
            onClick={() => goTo(page - 1)}
          >
            Previous
          </button>
          <div className="pagination-pages">
            {visiblePageNumbers(page, pageCount).map((token, index) =>
              token === 'gap' ? (
                <span key={`gap-${index}`} className="pagination-gap" aria-hidden="true">
                  …
                </span>
              ) : (
                <button
                  key={token}
                  type="button"
                  className={`pagination-page${token === page ? ' pagination-page--current' : ''}`}
                  aria-current={token === page ? 'page' : undefined}
                  onClick={() => goTo(token)}
                >
                  {token}
                </button>
              ),
            )}
          </div>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page >= pageCount}
            onClick={() => goTo(page + 1)}
          >
            Next
          </button>
          <label className="pagination-jump">
            <span>Go to</span>
            <input
              type="number"
              min={1}
              max={pageCount}
              value={draft}
              aria-label="Page number"
              onChange={(event) => setDraft(event.target.value)}
              onBlur={jump}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  jump();
                }
              }}
            />
          </label>
        </>
      ) : null}
      {showPageSize ? (
        <label className="pagination-size">
          <span>Per page</span>
          <select
            value={pageSize}
            aria-label="Items per page"
            onChange={(event) => changePageSize(event.target.value)}
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </nav>
  );
}
