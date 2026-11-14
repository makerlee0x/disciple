"use client";
/** Small shared pieces of the round 2 popups (Cash, invite, claim sheet): head, icons, dollars. No chain code. */

/** $1,234.56 */
export const usd2 = (n: number) => `$${(Math.floor(n * 100 + 1e-6) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function X() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>;
}
function Back() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M15 5l-7 7 7 7" /></svg>;
}
export function Warn() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18v.5" /></svg>;
}
export function ErrIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16v.5" /></svg>;
}
export function Check({ size = 30 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
}

/** Modal head: "Cash" + ✕ on desktop, back arrow + "Cash" on phones (CSS swaps them). */
export function CashHead({ title, onClose, onBack }: { title: string; onClose: () => void; onBack?: () => void }) {
  return (
    <div className="r2-mh cx-mh">
      <button type="button" className="r2-back" aria-label="Back" onClick={onBack ?? onClose}><Back /></button>
      <h2>{title}</h2>
      <button type="button" className="r2-x" aria-label="Close" onClick={onClose}><X /></button>
    </div>
  );
}

