/** Dollar formatting for Turbo screens. Everything on the main surfaces is in dollars. */
export const usd = (v: number, digits?: number): string => {
  if (!Number.isFinite(v)) return "—";
  const d = digits ?? (Math.abs(v) >= 1000 ? 0 : 2);
  return `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
};
/** Asset price: BTC whole dollars with cents under $10k, ETH with cents. */
export const price = (v: number): string => (!Number.isFinite(v) || v <= 0 ? "—" : usd(v, v >= 10_000 ? 0 : 2));
export const signedUsd = (v: number): string => (!Number.isFinite(v) ? "—" : Math.abs(v) < 0.005 ? "$0.00" : `${v > 0 ? "+" : "−"}${usd(Math.abs(v))}`);
export const pct = (v: number, d = 2): string => (!Number.isFinite(v) ? "—" : `${v.toFixed(d)}%`);
/** Chip money like today's buy bar: $10 · $2.50 · $1.2K */
export const chipUsd = (v: number) => (!(v > 0) ? "$0" : v >= 1000 ? `$${+(v / 1e3).toFixed(2)}K` : Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`);
export const lev = (v: number) => `${+v.toFixed(1)}×`;
/** "$70,950 · 0.06% away" */
export function liqWithDistance(liq: number, mark: number): string {
  if (!(liq > 0) || !(mark > 0)) return "—";
  return `${price(liq)} · ${pct((Math.abs(mark - liq) / mark) * 100, Math.abs(mark - liq) / mark < 0.01 ? 2 : 1)} away`;
}
