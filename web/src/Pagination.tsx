import { useEffect, useState } from 'react';
import { visiblePageNumbers } from './jobs/pageNumbers';

interface PaginationProps {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ page, pageCount, onPageChange }: PaginationProps) {
  const [draft, setDraft] = useState(String(page));

  useEffect(() => {
    setDraft(String(page));
  }, [page]);

  if (pageCount <= 1) return null;

  const goTo = (next: number) => {
    const clamped = Math.min(pageCount, Math.max(1, next));
    if (clamped !== page) onPageChange(clamped);
  };

  const jump = () => {
    const next = Number.parseInt(draft, 10);
    if (Number.isFinite(next)) goTo(next);
    else setDraft(String(page));
  };

  return (
    <nav className="pagination" aria-label="Pages">
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
    </nav>
  );
}
