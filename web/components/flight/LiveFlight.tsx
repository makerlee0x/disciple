"use client";
/**
 * iPhone app only: your flight on the lock screen and in the Dynamic Island (maker 2026-11-14). Once you hold a bag on a live
 * coin it starts a Live Activity (lib/native nativeFlight) with the ticker, zone, market cap, bag and PnL, and keeps it current
 * while the flight is open. Its push token goes to /api/live-activity so the server carries on updating it once a minute
 * after you leave the app (lib/server/liveActivity). Selling everything shows the final card ("Cashed out") and ends it.
 * Leaving the flight screen leaves it running: that's the point.
 */
import { useEffect } from "react";
import { nativeDebugBuild, nativeFlight } from "@/lib/native";
import { liveStateOf, type LiveState } from "@/lib/liveFlight";
import { privyAccessToken } from "@/lib/aa/sessionState";
import { onWallet } from "@/lib/walletState";

const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
type PnlView = { valueUsd?: number; uPnl?: number; pnlPct?: number } | null;

export default function LiveFlight({ coin, ticker }: { coin: string | null; ticker: string }) {
  useEffect(() => {
    const f = nativeFlight();
    if (!f || !isAddr(coin)) return;
    let wallet: string | null = null, started = false, starting = false, lastSent = "", lastAt = 0, mcap = 0, banked = 0;
    let pnl: PnlView = (window as unknown as { __pnlView?: PnlView }).__pnlView ?? null;
    const offWallet = onWallet((a) => { wallet = a ? a.toLowerCase() : null; });
    const path = `${location.pathname}${location.search}`;
    const state = (): LiveState => {
      const bag = pnl?.valueUsd ?? 0;
      return liveStateOf({ mcap, bagUsd: bag, pnlUsd: (pnl?.uPnl ?? 0) + banked, pnlPct: pnl?.pnlPct ?? 0, closed: started && bag <= 0.01 });
    };
    const register = async (token: string) => {
      const at = await privyAccessToken();
      if (!at || !wallet) return;
      await fetch("/api/live-activity", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${at}` },
        body: JSON.stringify({ wallet, coin, ticker, token, env: nativeDebugBuild() ? "sandbox" : "production" }) }).catch(() => {});
    };
    const sub = f.addListener("pushToken", (d) => { void register(d.token); });
    const sync = () => {
      const bag = pnl?.valueUsd ?? 0, st = state(), key = JSON.stringify(st), now = Date.now();
      if (!started) {
        if (bag > 0.01 && !starting && wallet) {
          starting = true;
          void f.start({ ticker: ticker ? `$${ticker}` : "", path, state: st })
            .then((r) => { started = !!r.id; lastSent = key; lastAt = now; })
            .catch(() => {})
            .finally(() => { starting = false; });
        }
        return;
      }
      if (st.closed) { void f.end({ state: st }).catch(() => {}); started = false; lastSent = ""; return; }
      if (key !== lastSent && now - lastAt > 3000) { lastSent = key; lastAt = now; void f.update({ state: st }).catch(() => {}); }
    };
    const ev: [string, (d: unknown) => void][] = [
      ["disciple:mark", (d) => { const m = (d as { mcap?: number } | null)?.mcap; if (m && m > 0) mcap = m; }],
      ["disciple:pnlview", (d) => { pnl = (d as PnlView) ?? null; sync(); }],
      ["disciple:banked", (d) => { banked = (d as { realized?: number } | null)?.realized ?? 0; sync(); }],
    ];
    const hs = ev.map(([n, h]) => { const l = (e: Event) => h((e as CustomEvent).detail); addEventListener(n, l); return [n, l] as const; });
    const iv = setInterval(sync, 4000);
    return () => {
      clearInterval(iv);
      for (const [n, l] of hs) removeEventListener(n, l);
      offWallet();
      void sub.then((x) => x.remove()).catch(() => {});
    };
  }, [coin, ticker]);
  return null;
}
