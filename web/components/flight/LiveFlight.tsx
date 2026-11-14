"use client";
/**
 * Your flight on the lock screen and in the Dynamic Island (iPhone app, maker 2026-11-14 option 5).
 * On a live coin, the moment you have a bag (PnlHud disciple:position) this starts a Live Activity with the coin, what went in,
 * the bag's value and P&L, the altitude and the zone (lib/liveFlight). While the app is open it updates every few seconds;
 * Apple's push token for it goes to the server (POST /api/live-activity), which keeps it fresh once the app is closed.
 * Selling the whole bag ends it with a final LANDED card (realized P&L, disciple:banked) that stays a few minutes.
 * Free play, replays, the browser and Android: nothing.
 */
import { useEffect } from "react";
import { liveFlightNumbers } from "@/lib/liveFlight";
import { isNativeApp, liveFlightEnd, liveFlightStart, liveFlightSupported, liveFlightUpdate, nativeDebugBuild, onLiveFlightToken } from "@/lib/native";
import { onWallet } from "@/lib/walletState";
import { privyAccessToken } from "@/lib/aa/sessionState";

const UPDATE_MS = 4000;

/** Xcode debug builds only: /flight/sim?liveDemo=1 shows a sample Live Activity, so the lock screen / Dynamic Island can be checked
 *  in the Simulator without a real position. Never in TestFlight / App Store builds (nativeDebugBuild). */
function useLiveDemo() {
  useEffect(() => {
    let flag = false; try { flag = sessionStorage.getItem("disciple.liveDemo") === "1"; } catch { /* ignore */ }
    if (!isNativeApp() || !nativeDebugBuild() || (new URLSearchParams(location.search).get("liveDemo") !== "1" && !flag)) return;
    let mcap = 14_200, t = 0;
    const base = { coin: "0x000000000000000000000000000000000000d15c", ticker: "MOON", investedUsd: 25, entryMcap: 9_800, url: "/flight/sim" };
    void liveFlightStart({ ...base, ...liveFlightNumbers({ mcap, valueUsd: 25 * mcap / 9_800, investedUsd: 25 }) });
    const id = window.setInterval(() => { t++; mcap *= 1 + 0.04 * Math.sin(t / 3) + 0.01; liveFlightUpdate({ coin: base.coin, ...liveFlightNumbers({ mcap, valueUsd: 25 * mcap / 9_800, investedUsd: 25 }) }); }, 2000);
    return () => window.clearInterval(id);
  }, []);
}

export default function LiveFlight({ coin }: { coin: string | null }) {
  useLiveDemo();
  useEffect(() => {
    if (!coin || !isNativeApp()) return;
    const c = coin.toLowerCase();
    let alive = true, ok = false, running = false, starting = false, token: string | null = null, wallet: string | null = null;
    let mcap = 0, ticker = "", size = 0, value = 0, basis = 0, bankedAt0: number | null = null, banked = 0, lastPush = 0;
    const offWallet = onWallet((a) => { wallet = a ? a.toLowerCase() : null; });
    const register = () => {
      if (!token || !wallet || !(mcap > 0) || !(basis > 0)) return;
      const t = token, w = wallet;
      void privyAccessToken().then((at) => {
        if (!at) return;
        return fetch("/api/live-activity", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${at}` },
          body: JSON.stringify({ token: t, env: nativeDebugBuild() ? "sandbox" : "production", coin: c, ticker, investedUsd: basis, share: value / mcap, wallet: w }) });
      }).catch(() => {});
    };
    const drop = () => { if (token) void fetch("/api/live-activity", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }).catch(() => {}); token = null; };
    const offToken = onLiveFlightToken((d) => { if (d.coin === c) { token = d.token; register(); } });
    const numbers = (closed = false) => liveFlightNumbers({ mcap, valueUsd: closed ? basis + (banked - (bankedAt0 ?? 0)) : value, investedUsd: basis, closed });

    const sync = (force = false) => {
      if (!ok || !alive) return;
      const holding = size > 0 && value > 0.01 && basis > 0;
      if (holding && !running && !starting && mcap > 0) {
        starting = true; bankedAt0 = banked;
        void liveFlightStart({ coin: c, ticker, investedUsd: basis, entryMcap: mcap, url: `/coin/${c}`, ...numbers() }).then((id) => { starting = false; running = !!id; lastPush = Date.now(); });
        return;
      }
      if (running && !holding) { running = false; liveFlightEnd({ coin: c, ...numbers(true) }); drop(); return; }
      if (running && (force || Date.now() - lastPush >= UPDATE_MS)) {
        lastPush = Date.now(); liveFlightUpdate({ coin: c, ...numbers() });
        if (force) register();   // the bag changed: the server's share / invested must follow
      }
    };
    const onPos = (e: Event) => {
      const d = (e as CustomEvent<{ size?: number; valueUsd?: number; costBasis?: number }>).detail || {};
      const was = size; size = +(d.size ?? 0) || 0; value = +(d.valueUsd ?? 0) || 0; basis = +(d.costBasis ?? 0) || 0;
      sync(was !== size);
    };
    const onMark = (e: Event) => { const m = (e as CustomEvent<{ mcap?: number }>).detail?.mcap; if (m && m > 0) { if (mcap > 0 && size > 0) value *= m / mcap; mcap = m; sync(); } };
    const onRules = (e: Event) => { const t = (e as CustomEvent<{ ticker?: string }>).detail?.ticker; if (t) ticker = t.replace(/^\$/, ""); };
    const onBank = (e: Event) => { banked = (e as CustomEvent<{ realized?: number }>).detail?.realized ?? banked; };
    void liveFlightSupported().then((s) => {
      ok = s;
      if (!s || !alive) return;
      addEventListener("disciple:position", onPos); addEventListener("disciple:mark", onMark);
      addEventListener("disciple:coinrules", onRules); addEventListener("disciple:banked", onBank);
    });
    return () => {
      alive = false; offWallet(); offToken();
      removeEventListener("disciple:position", onPos); removeEventListener("disciple:mark", onMark);
      removeEventListener("disciple:coinrules", onRules); removeEventListener("disciple:banked", onBank);
      // leaving the flight with a bag keeps the activity: the server keeps it fresh until you sell or it times out
    };
  }, [coin]);
  return null;
}
