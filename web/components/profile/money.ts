/** Profile r5 money formats: always dollars and cents, grouped (e.g. $1,240.00), signed changes with a real minus. */
export const usd2 = (v: number) => `$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const signedUsd2 = (v: number) => (Math.abs(v) < 0.005 ? usd2(0) : `${v > 0 ? "+" : "−"}${usd2(v)}`);
/** Big total split for the r2 type spec: "$" and cents at a smaller size. */
export function moneyParts(v: number): { whole: string; cents: string } {
  const [whole, cents] = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).split(".");
  return { whole, cents };
}
/** "2h ago" · "Yesterday" · "3 days ago" · "Nov 2" (older than a week). */
export function agoLabel(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d === 1) return "Yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(new Date(ts).getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}
