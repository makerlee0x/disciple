import { PROFILE_COPY as C } from "@/lib/copy/profile";

export const pageCount = (n: number, size: number) => Math.max(1, Math.ceil(n / size));
export const pageSlice = <T,>(rows: T[], page: number, size: number) => rows.slice((page - 1) * size, page * size);

/** ‹ Prev · Page x of y · Next ›. Paging replaces endless scroll on every profile tab. Hidden when one page. */
export default function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <nav className="pf-pager" aria-label="Pages">
      <button type="button" className="ds-btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ {C["pager.prev"]}</button>
      <span className="pf-pager-status">{C["pager.status"](page, pages)}</span>
      <button type="button" className="ds-btn" disabled={page >= pages} onClick={() => onPage(page + 1)}>{C["pager.next"]} ›</button>
    </nav>
  );
}
