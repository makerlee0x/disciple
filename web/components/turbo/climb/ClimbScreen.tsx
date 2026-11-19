"use client";
/**
 * /turbo/climb: Climb, the solo Turbo mode (maker 2026-11-17/18). The screens are the Trading Duel engine
 * (public/turbo/duel/engine.js) with host.climb set: no rival, levels, a goal line and a zoomed sky. This host feeds
 * live BTC, keeps the unlocked level (lib/climb/progress) and applies the unlock rule (lib/climb/rules).
 * Play money only until the Lighter / Nova adapter is live. No test out (maker 2026-11-18). With the hidden Lighter switch
 * (`?lighter=1`, lib/lighter/duel) each press is also a real order on the pilot's Lighter account, and the server's
 * buzzer closes it when the run's clock runs out.
 */
import { useEffect, useRef, useState } from "react";
import LobbySettings from "@/components/turbo/LobbySettings";
import { getTurboAdapter } from "@/lib/turbo";
import { getGameRadio } from "@/lib/game/radio";
import { useTurboMusic } from "@/lib/game/turboMusic";
import { CLIMB_FEE, CLIMB_FEE_LABEL, CLIMB_LEVELS, CLIMB_MAX_GEAR, climbLevelsFor, CLIMB_RUN_MS, unlockAfter, unlockAfterTest } from "@/lib/climb/rules";
import { readClimbLevel, saveClimbLevel } from "@/lib/climb/progress";
import { DUEL_SKIES, EXTRA_SKIES, loadDuelEngine } from "@/components/turbo/duel/engineLoader";
import { PCTS, pctUsd } from "@/lib/duel/rules";
import { LighterMatch, lighterFetcher, lighterWanted, type MatchAction } from "@/lib/lighter/duel";
import { lighterStatus } from "@/lib/lighter/client";
import { LIGHTER_PRICE_HOST, streamLighterMids } from "@/lib/turbo/royalePrices";
import { onWallet } from "@/lib/walletState";

type Tick = { ts: number; p: number };
interface EngineApi { price(p: number, ts: number): void; error?(t: string): void; climbRefresh?(): void; climbFill?(entry: number): void; destroy(): void }
/** the buzzer's longest clock (app/api/lighter arm): free mode has none, so its position closes then */
const LIGHTER_ARM_MAX = 270_000;

export default function ClimbScreen() {
  const ref = useRef<HTMLDivElement>(null);
  const [gear, setGear] = useState(false);
  useTurboMusic();
  useEffect(() => {
    let dead = false, api: EngineApi | null = null;
    const hist: Tick[] = [];
    // levels scale with the pilot's Turbo balance (lib/climb/rules climbLevelsFor). The engine holds this array, so it
    // is updated in place and the levels screen redrawn when the balance moves.
    const levels = [...CLIMB_LEVELS];
    const setBalance = (usd: number) => { levels.splice(0, levels.length, ...climbLevelsFor(usd)); api?.climbRefresh?.(); };
    const ad = getTurboAdapter();
    // on Lighter (maker 2026-11-18: "this should be real fills now") the balance is the pilot's Lighter cash, the chart
    // is that exchange's BTC price, entries are Lighter's fills and the result is the cash Lighter says it moved
    const onLighter = lighterWanted();
    let realCash: number | null = null;
    if (!onLighter) void ad.getFuel().then((f) => { if (!dead) setBalance(f.usd); }).catch(() => {});
    const offFuel = onLighter ? () => {} : ad.onFuel((f) => setBalance(f.usd));
    const tick = (price: number, at: number) => {
      const ts = at || Date.now(); hist.push({ ts, p: price });
      while (hist.length && hist[0].ts < ts - 90_000) hist.shift();
      api?.price(price, ts);
    };
    // On Lighter the chart is Lighter's own BTC from the first frame (public stream, no account needed), swapped for the
    // pilot's exchange once the account is read. Until then, or whenever Lighter goes quiet for 3 s, the play-money feed
    // (Hyperliquid) fills in, so the countdown never waits on Lighter (maker 2026-11-18: Climb "froze on 3").
    let lastLx = 0;
    const lxTick = (p: number) => { lastLx = Date.now(); tick(p, lastLx); };
    let stopPrice = onLighter
      ? streamLighterMids((m) => { if (m.BTC) lxTick(m.BTC); })
      : ad.subscribePrice("BTC", (t) => tick(t.price, t.ts));
    const stopBackup = onLighter ? ad.subscribePrice("BTC", (t) => { if (Date.now() - lastLx > 3_000) tick(t.price, Date.now()); }) : () => {};
    let lf: ReturnType<typeof lighterFetcher> | null = null;
    /** the Lighter account now: cash, and the BTC position's real entry */
    const readLighter = async () => {
      if (!lf) return null;
      const s = await lighterStatus(lf);
      const cash = Number(s.collateral);
      const p = s.positions?.find((x) => x.symbol === "BTC");
      const open = p && Number(p.position) !== 0 ? Number(p.avg_entry_price) : null;
      return { s, cash: Number.isFinite(cash) ? cash : null, entry: open && open > 0 ? open : null };
    };
    // Lighter: Lighter's BTC leverage is set once at 50x (CLIMB_MAX_GEAR), so a lower gear sends a smaller margin for
    // the same size of bet: $ × gear / 50
    let wallet: string | null = null, gear = CLIMB_MAX_GEAR, lxP: Promise<LighterMatch | null> = Promise.resolve(null);
    const offWallet = onWallet((a) => {
      wallet = a;
      if (!onLighter || !a) return;
      lf = lighterFetcher(a);
      void readLighter().then((r) => {
        if (dead || !r || r.s.step !== "ready") return;
        host.climb.real = true;
        if (r.cash != null) { realCash = r.cash; setBalance(r.cash); }
        const h = r.s.url ? new URL(r.s.url).host : undefined;
        // Lighter's smallest BTC order as a position in $ (its min size at the mark, or its min $, whichever is bigger)
        if (r.s.url) void fetch(`${r.s.url}/api/v1/orderBookDetails?filter=perp`).then((x) => x.json()).then((j: { order_book_details?: { symbol?: string; min_base_amount?: string; min_quote_amount?: string; mark_price?: string; last_trade_price?: number }[] }) => {
          const d = j.order_book_details?.find((o) => o.symbol === "BTC");
          const px = Number(d?.mark_price ?? d?.last_trade_price);
          const min = Math.max(Number(d?.min_base_amount) * px || 0, Number(d?.min_quote_amount) || 0);
          if (!dead && min > 0 && lighter) { lighter.minUsd = min; api?.climbRefresh?.(); }
        }).catch(() => {});
        if (h && h !== LIGHTER_PRICE_HOST) { stopPrice(); stopPrice = streamLighterMids((m) => { if (m.BTC) lxTick(m.BTC); }, h); }
      }).catch(() => {});
    });
    let startCash: number | null = null, ended: Promise<void> = Promise.resolve();
    const sizesFor = (fuel: number) => PCTS.map((p) => (p === 0 ? fuel / (1 + gear * CLIMB_FEE) : pctUsd(p, fuel)) * gear / CLIMB_MAX_GEAR);
    const lighter = !lighterWanted() ? undefined : {
      /** Lighter's smallest BTC order, a position in $ (read once the account is ready); the engine rounds bets up to it */
      minUsd: 0,
      begin: (run: { fuel: number; gear: number }) => {
        gear = run.gear; startCash = realCash;
        lxP = (async () => {
          if (!wallet) { api?.error?.("Sign in to fly on Lighter."); return null; }
          const f = lighterFetcher(wallet);
          if (!(await LighterMatch.ready(f))) { api?.error?.("Lighter isn't set up for this wallet. Finish set-up on /lighter."); return null; }
          const lx = new LighterMatch(f, "BTC", sizesFor, run.fuel); lx.start(); return lx;
        })().catch(() => null);
      },
      arm: (endAt: number) => {
        const id = `climb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        void lxP.then((lx) => lx?.arm("climb", id, { ms: Math.max(5_000, Math.min(LIGHTER_ARM_MAX, endAt - Date.now())), markets: ["BTC"] }));
      },
      press: (action: MatchAction, i: number, fuelAfter: number) => lxP.then(async (lx) => {
        if (!lx) return null;
        const r = await lx.press(action, i, fuelAfter);
        // the fill lands a moment after Lighter takes the order: read the real entry back for the chart and the PnL
        if (!("error" in r) && action !== "close") setTimeout(() => { void readLighter().then((x) => { if (x?.entry) api?.climbFill?.(x.entry); }).catch(() => {}); }, 700);
        return r;
      }),
      fuel: (fuel: number) => { void lxP.then((lx) => lx?.fuel(fuel)); },
      end: () => {
        const p = lxP; lxP = Promise.resolve(null);
        ended = p.then(async (lx) => { if (!lx) return; await lx.closeAll().catch(() => {}); lx.stop(); });
        return ended;
      },
      /** the run's real result: Lighter cash once the BTC position is gone, minus the cash before the run */
      result: async (): Promise<number | null> => {
        await ended;
        if (startCash == null) return null;
        for (let i = 0; i < 8; i++) {
          const r = await readLighter().catch(() => null);
          if (r && r.cash != null && r.entry == null) { realCash = r.cash; setBalance(r.cash); return Math.round((r.cash - startCash) * 100) / 100; }
          await new Promise((ok) => setTimeout(ok, 600));
        }
        return null;
      },
    };
    const host = {
      assets: { ...Object.fromEntries(["rocket", ...DUEL_SKIES].map((k) => [k, `/turbo/duel/${k}.webp`])), ...EXTRA_SKIES, art: "/art/modes/live.webp" },
      history: () => hist.filter((h) => h.ts > Date.now() - 60_000),
      signIn: () => {},
      mute: (m: boolean) => { try { const r = getGameRadio(); if (m) r.pause(); else r.clearPause(); } catch { /* no radio */ } },
      settings: () => setGear(true),   // the lobby gear (components/turbo/LobbySettings)
      climb: {
        levels, maxGear: CLIMB_MAX_GEAR, runMs: CLIMB_RUN_MS, fee: CLIMB_FEE, feeLabel: CLIMB_FEE_LABEL,
        real: false, back: "/", lighter,
        state: () => ({ unlocked: readClimbLevel() }),
        finish: ({ level, pnl, test }: { level: number; pnl: number; test?: boolean }) => {
          const u = readClimbLevel(), to = test ? unlockAfterTest(u, level, pnl, levels) : unlockAfter(u, level, pnl, levels);
          if (to > u) saveClimbLevel(to);
          return { unlocked: Math.max(u, to) };
        },
      },
    };
    const w = window as unknown as { DuelEngine?: { mount(root: HTMLElement, host: unknown): EngineApi } };
    loadDuelEngine().then(() => {
      if (dead || !ref.current || !w.DuelEngine) return;
      api = w.DuelEngine.mount(ref.current, host);
    }).catch(() => { if (ref.current) ref.current.textContent = "Couldn't load Climb. Refresh to try again."; });
    return () => { dead = true; stopPrice(); stopBackup(); offWallet(); offFuel(); api?.destroy(); };
  }, []);
  return <><div ref={ref} /><LobbySettings mode="climb" open={gear} onClose={() => setGear(false)} /></>;
}
