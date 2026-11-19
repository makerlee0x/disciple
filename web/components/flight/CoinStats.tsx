"use client";
/**
 * Coin stats strip under the desktop chart (maker 2026-11-18, the DEX-site row; market cap stays the big number in the
 * top card): Price · 24H · 24H Vol. · Liquidity · Holders. Data: /api/coin/stats (lib/server/coinStats), refreshed every
 * 15 s and shortly after a trade on this coin; price and 24H follow the live mark between reads.
 */
import { useEffect, useRef, useState } from "react";
import { fmtCount, fmtPrice, fmtUsdShort, type CoinStats as Stats } from "@/lib/coinStats";
import { HUD } from "@/lib/game/hudStyle";

const REFRESH_MS = 15_000;
export const COIN_STATS_H = 52;
/** 43.61 · 760 · 12.4K (fits a fifth of the card) */
const pct = (a: number) => (a >= 10_000 ? `${(a / 1000).toFixed(0)}K` : a >= 1000 ? `${(a / 1000).toFixed(1)}K` : a >= 100 ? a.toFixed(0) : a.toFixed(2));

export default function CoinStats({ coin }: { coin: string }) {
  const [s, setS] = useState<Stats | null>(null);
  const [mark, setMark] = useState<{ m: number; sup: number } | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(coin)) return;
    let alive = true, soon: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      if (busy.current || document.hidden) return; busy.current = true;
      try { const r = await fetch(`/api/coin/stats?coin=${coin}`); if (r.ok && alive) setS((await r.json()) as Stats); } catch { /* keep last */ } finally { busy.current = false; }
    };
    void load(); const iv = setInterval(load, REFRESH_MS);
    const onEv = (e: Event) => { const d = (e as CustomEvent<{ type?: string; token?: string }>).detail;
      if (d?.type === "Trade" && String(d.token || "").toLowerCase() === coin.toLowerCase()) { if (soon) clearTimeout(soon); soon = setTimeout(load, 2500); } };
    const onMark = (e: Event) => { const d = (e as CustomEvent<{ mcap?: number; supply?: number }>).detail; const m = Number(d?.mcap), sup = Number(d?.supply);
      // only a real (on-chain) mark: a guest's paper HUD price never moves the strip (same rule as DexChart)
      if (m > 0 && (window as unknown as { __discipleTrade?: unknown }).__discipleTrade) setMark((o) => (o && o.m === m ? o : { m, sup: sup > 0 ? sup : o?.sup ?? 0 })); };
    addEventListener("disciple:event", onEv); addEventListener("disciple:mark", onMark);
    return () => { alive = false; clearInterval(iv); if (soon) clearTimeout(soon); removeEventListener("disciple:event", onEv); removeEventListener("disciple:mark", onMark); };
  }, [coin]);

  // live price / 24H from the mark: the server's mcap and change give the 24 h base
  const base = s?.mcapUsd && s.change24hPct != null ? s.mcapUsd / (1 + s.change24hPct / 100) : null;
  const m = mark?.m ?? s?.mcapUsd ?? null;
  const price = mark && mark.sup > 0 ? mark.m / mark.sup : s?.priceUsd ?? null;
  const chg = base && m ? (m / base - 1) * 100 : s?.change24hPct ?? null;
  const up = (chg ?? 0) >= 0;
  const cells: { k: string; l: string; v: string; c?: string }[] = [
    { k: "price", l: "Price", v: fmtPrice(price) },
    { k: "chg", l: "24H", v: chg == null ? "—" : `${up ? "▲" : "▼"} ${pct(Math.abs(chg))}%`, c: chg == null ? undefined : up ? HUD.up : HUD.down },
    { k: "vol", l: "24H Vol.", v: s ? fmtUsdShort(s.vol24hUsd) : "—" },
    { k: "liq", l: "Liquidity", v: fmtUsdShort(s?.liquidityUsd) },
    { k: "holders", l: "Holders", v: fmtCount(s?.holders) },
  ];
  return (
    <div data-testid="coin-stats" style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 6, height: COIN_STATS_H }}>
      {cells.map((c) => (
        <div key={c.k} data-testid={`coin-stat-${c.k}`} style={{ minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 3, padding: "0 4px",
          borderRadius: 10, background: "rgba(12,13,28,.92)", border: "1px solid rgba(255,255,255,.10)", boxSizing: "border-box" }}>
          <span style={{ font: `500 11px/1 ${HUD.ui}`, color: HUD.dim, whiteSpace: "nowrap" }}>{c.l}</span>
          <span style={{ font: `700 14px/1 ${HUD.ui}`, color: c.c ?? HUD.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%", fontVariantNumeric: "tabular-nums" }}>{c.v}</span>
        </div>
      ))}
    </div>
  );
}
