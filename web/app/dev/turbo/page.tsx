"use client";
/** /dev/turbo: the Turbo page with sample numbers, for mockup screenshots (next dev only). ?view=public | new */
import { useEffect, useState } from "react";
import TurboView, { type TurboData } from "@/components/turbo/page/TurboView";
import { TURBO_PAGE_MODES } from "@/components/turbo/page/modes";
import { pnlOf, tradingOf, type TurboFill, type TurboMatch, type TurboProfile } from "@/lib/turbo/profile";

const M = 60_000, H = 60 * M, D = 24 * H;
const OPPS = ["SolSniper", "kaori.eth", "rektangle", "Moon Maxi", "basedgod", "0xWhale", "chartguy", "perpetual pete"];

function sample(now: number): TurboProfile {
  const res: TurboMatch["result"][] = ["win", "win", "loss", "win", "loss", "win", "draw", "win", "loss", "win"];
  const matches: TurboMatch[] = res.map((r, i) => {
    const me = r === "win" ? [3.42, 1.18, 6.9, 0.52, 2.27, 11.4][i % 6] : r === "loss" ? [-2.1, -0.84, -4.6][i % 3] : 0.4;
    const them = r === "win" ? me - [2.8, 1.9, 4.1][i % 3] : r === "loss" ? me + [3.3, 1.2, 0.7][i % 3] : 0.4;
    const mode: TurboMatch["mode"] = i % 4 === 3 ? "friend" : i % 3 === 0 ? "ranked" : "casual";
    return {
      id: `m${i}`, at: now - (i * 3.3 + 0.2) * H, mode, tier: ["NORMIE", "DEGEN", "WHALE"][i % 3], lenMs: i === 2 ? 90_000 : 60_000,
      result: r, me: Math.round(me * 100) / 100, them: Math.round(them * 100) / 100,
      delta: mode === "ranked" ? (r === "win" ? 30 : r === "loss" ? -15 : 10) : 0, real: mode === "ranked" || i % 2 === 0,
      opp: { wallet: `0x${String(i).repeat(40)}`.slice(0, 42), name: OPPS[i % OPPS.length], pfp: "" },
    };
  });
  const mk = ["BTC", "ETH", "HYPE", "SOL"];
  const fills: TurboFill[] = Array.from({ length: 14 }, (_, i) => {
    const m = mk[i % 4], px = { BTC: 91240.5, ETH: 3122.4, HYPE: 31.82, SOL: 182.37 }[m]!;
    const usd = [60, 120, 250, 40][i % 4];
    const close = i % 2 === 1;
    return { at: now - (i * 2.1 + 0.1) * H - (i > 9 ? 6 * D : 0), market: m, side: (i % 3 === 0 ? "buy" : "sell") as TurboFill["side"], size: usd / px, price: px, usd, fee: usd * 0.0000055, pnl: close ? [2.41, -1.12, 5.08, 0.77, -0.35][(i >> 1) % 5] : null, liq: i === 13 };
  });
  return {
    wallet: "0xme", fillsMissing: false, matches, fills,
    duel: { w: 38, l: 17, games: 56, streak: 4, rank: 41, league: "gold", sp: 1640 },
    climb: { level: 12, rank: 7 },
    pnl: { ...pnlOf(fills, now), all: 184.62 },
    trading: { ...tradingOf(fills)!, fills: 412, volume: 48_210 },
  };
}

export default function Page() {
  const [view, setView] = useState<string>("own");
  useEffect(() => { setView(new URLSearchParams(window.location.search).get("view") ?? "own"); }, []);
  const now = Date.now();
  const fresh: TurboProfile = { wallet: "0xme", duel: null, climb: null, pnl: null, trading: null, matches: [], fills: [], fillsMissing: false };
  const d: TurboData = {
    own: view !== "public", name: view === "new" ? "New Pilot" : "Moon Maxi", handle: view === "new" ? "@newpilot" : "@maker", pfp: "",
    balance: view === "new" ? 0 : 5.95, p: view === "new" ? fresh : sample(now), modes: TURBO_PAGE_MODES,
    pilotHref: (n) => `/u/${encodeURIComponent(n)}/turbo`,
  };
  return <TurboView d={d} onAdd={d.own ? () => {} : undefined} onWithdraw={d.own && view !== "new" ? () => {} : undefined} />;
}
