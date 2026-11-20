import { useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/** Paginate the already loaded records without changing requests or polling. */
export function PaginatedList<T>({ items, label, initialPageSize = 10, children }: {
  items: T[];
  label: string;
  initialPageSize?: number;
  children: (items: T[]) => ReactNode;
}) {
  const [requestedPage, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(requestedPage, pages);
  const start = (page - 1) * pageSize;
  return <>
    {children(items.slice(start, start + pageSize))}
    <nav className="admin-pagination" aria-label={`${label} pagination`}>
      <span role="status">{items.length ? start + 1 : 0}–{Math.min(start + pageSize, items.length)} of {items.length} {label.toLowerCase()}</span>
      <div className="admin-pagination-controls">
        <label>Per page<select aria-label={`${label} per page`} value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>{[5, 6, 10, 20].filter((size) => size !== 6 || initialPageSize === 6).map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
        <span>Page {page} of {pages}</span>
        <button type="button" disabled={page === 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft size={15} />Previous</button>
        <button type="button" disabled={page === pages} onClick={() => setPage(page + 1)} aria-label="Next page">Next<ChevronRight size={15} /></button>
      </div>
    </nav>
  </>;
}
