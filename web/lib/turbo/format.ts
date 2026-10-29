/** TURBO number formatting (dollars only). */
export function usd(v: number, dp = 2) {
  if (!Number.isFinite(v)) return "$0";
  const a = Math.abs(v), s = a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return (v < 0 ? "−$" : "$") + s;
}
export const signedUsd = (v: number, dp = 2) => (v > 0 ? "+" : v < 0 ? "−" : "") + usd(Math.abs(v), dp);
export const chip = (v: number) => (Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`);
export const levTxt = (v: number) => `${v}×`;
export const price = (v: number) => usd(v, v >= 1000 ? 2 : v >= 1 ? 2 : 4);
export const pct = (v: number, dp = 2) => `${v.toFixed(dp)}%`;
