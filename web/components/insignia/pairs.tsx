/** Pair marks — small original logos for the base tokens a Disciple coin can follow. */
import { emblemFor } from "./PairInsignia";

export type PairInfo = { key: "STRATEGY" | "USDG" | "WETH" | "OTHER"; label: string; short: string; color: string; color2: string };

export function pairInfo(sym = "STRATEGY"): PairInfo {
  const s = sym.toUpperCase();
  if (s === "STRATEGY" || s === "MSTR") return { key: "STRATEGY", label: "STRATEGY", short: "STRATEGY", color: "#f7931a", color2: "#a34d00" };
  if (s === "USDG" || s === "MUSDG") return { key: "USDG", label: sym, short: sym, color: "#2fd39a", color2: "#0b6b52" };
  if (s === "WETH" || s === "ETH") return { key: "WETH", label: "WETH", short: "WETH", color: "#8c9cff", color2: "#3a3f8f" };
  const e = emblemFor("pair:" + s, s);
  return { key: "OTHER", label: sym, short: sym.slice(0, 8), color: e.bg, color2: e.bg2 };
}

/** `bare` = mark only (no disc), for use inside the pair shield. */
export function PairMark({ sym = "STRATEGY", size = 16, bare }: { sym?: string; size?: number; bare?: boolean }) {
  const p = pairInfo(sym);
  const disc = bare ? null : <circle cx="12" cy="12" r="12" fill={p.color} />;
  const ink = bare ? "#fff" : "#0b0f22";
  let mark: React.ReactNode;
  if (p.key === "STRATEGY") {
    // Stylised "S" bolt (original): two offset bars forming an S.
    mark = <path d="M7 6h10v3.5H10.5V11H17v7H7v-3.5h6.5V13H7Z" fill={ink} />;
  } else if (p.key === "USDG") {
    mark = <><path d="M12 4v16" stroke={ink} strokeWidth="1.8" /><path d="M16 8.5c-.6-1.4-2-2-4-2-2.4 0-3.6 1.2-3.6 2.6 0 3.6 7.6 1.8 7.6 5.6 0 1.6-1.5 2.8-4 2.8-2.2 0-3.6-.8-4.2-2.3" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" /></>;
  } else if (p.key === "WETH") {
    mark = <><path d="M12 3l6 9-6 3.5L6 12Z" fill={ink} /><path d="M12 16.8l6-3.6-6 8-6-8Z" fill={ink} opacity=".75" /></>;
  } else {
    const mono = sym.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
    mark = <text x="12" y="16" textAnchor="middle" fontFamily="Georgia, serif" fontWeight="700" fontSize="10" fill={ink}>{mono}</text>;
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-label={p.label} role="img">{disc}{mark}</svg>;
}
