/** Formatting shared by the share card (server) and ShareModal (client). */
export const fmtMoney = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `${(a / 1e3).toFixed(1)}K` : a >= 100 ? Math.round(a).toLocaleString("en-US") : a.toFixed(2);
  return `${v < 0 ? "-" : "+"}$${s}`;
};
export const fmtMcap = (v: number) => {
  const a = Math.abs(v);
  return "$" + (a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a.toFixed(0));
};
export const fmtPct = (v: number) => `${v < 0 ? "" : "+"}${Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(1)}%`;
/** "OCT 16, 2026 · 7:38 AM CT" (America/Chicago) */
export function fmtCt(ms: number) {
  const d = new Date(ms);
  const date = d.toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric" }).toUpperCase();
  const time = d.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
  return `${date} · ${time} CT`;
}
export function shareText(p: { gainUsd: number; gainPct: number; ticker: string; kind: string }, link: string) {
  const verb = p.kind === "realized" ? "Closed" : "Riding";
  return `${verb} $${p.ticker} ${fmtMoney(p.gainUsd)} (${fmtPct(p.gainPct)}) on DISCIPLE. Board my rocket: ${link}`;
}
