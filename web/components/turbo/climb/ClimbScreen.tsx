"use client";
/**
 * /turbo/climb: Climb, the solo Turbo mode (maker 2026-11-17/18). The screens are the Trading Duel engine
 * (public/turbo/duel/engine.js) with host.climb set: no rival, levels, a goal line and a zoomed sky. This host feeds
 * live BTC, keeps the unlocked level (lib/climb/progress) and applies the unlock rule (lib/climb/rules).
 * Play money only until the Lighter / Nova adapter is live, so test out stays locked. With the hidden Lighter switch
 * (`?lighter=1`, lib/lighter/duel) each press is also a real order on the pilot's Lighter account, and the server's
 * buzzer closes it when the run's clock runs out.
 */
import { useEffect, useRef } from "react";
import { getTurboAdapter } from "@/lib/turbo";
import { getGameRadio } from "@/lib/game/radio";
import { useTurboMusic } from "@/lib/game/turboMusic";
import { CLIMB_FEE, CLIMB_FEE_LABEL, CLIMB_LEVELS, CLIMB_MAX_GEAR, CLIMB_RUN_MS, unlockAfter, unlockAfterTest } from "@/lib/climb/rules";
import { readClimbLevel, saveClimbLevel } from "@/lib/climb/progress";
import { DUEL_SKIES, EXTRA_SKIES, loadDuelEngine } from "@/components/turbo/duel/engineLoader";
import { PCTS, pctUsd } from "@/lib/duel/rules";
import { LighterMatch, lighterFetcher, lighterWanted, type MatchAction } from "@/lib/lighter/duel";
import { onWallet } from "@/lib/walletState";

type Tick = { ts: number; p: number };
interface EngineApi { price(p: number, ts: number): void; error?(t: string): void; destroy(): void }
/** the buzzer's longest clock (app/api/lighter arm): free mode has none, so its position closes then */
const LIGHTER_ARM_MAX = 270_000;

export default function ClimbScreen() {
  const ref = useRef<HTMLDivElement>(null);
  useTurboMusic();
  useEffect(() => {
    let dead = false, api: EngineApi | null = null;
    const hist: Tick[] = [];
    const stopPrice = getTurboAdapter().subscribePrice("BTC", (t) => {
      const ts = t.ts || Date.now(); hist.push({ ts, p: t.price });
      while (hist.length && hist[0].ts < ts - 90_000) hist.shift();
      api?.price(t.price, ts);
    });
    // Lighter: Lighter's BTC leverage is set once at 50x (CLIMB_MAX_GEAR), so a lower gear sends a smaller margin for
    // the same size of bet: $ × gear / 50
    let wallet: string | null = null, gear = CLIMB_MAX_GEAR, lxP: Promise<LighterMatch | null> = Promise.resolve(null);
    const offWallet = onWallet((a) => { wallet = a; });
    const sizesFor = (fuel: number) => PCTS.map((p) => (p === 0 ? fuel / (1 + gear * CLIMB_FEE) : pctUsd(p, fuel)) * gear / CLIMB_MAX_GEAR);
    const lighter = !lighterWanted() ? undefined : {
      begin: (run: { fuel: number; gear: number }) => {
        gear = run.gear;
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
      press: (action: MatchAction, i: number, fuelAfter: number) => lxP.then((lx) => (lx ? lx.press(action, i, fuelAfter) : null)),
      fuel: (fuel: number) => { void lxP.then((lx) => lx?.fuel(fuel)); },
      end: () => {
        const p = lxP; lxP = Promise.resolve(null);
        void p.then(async (lx) => { if (!lx) return; await lx.closeAll().catch(() => {}); lx.stop(); });
      },
    };
    const host = {
      assets: { ...Object.fromEntries(["rocket", ...DUEL_SKIES].map((k) => [k, `/turbo/duel/${k}.webp`])), ...EXTRA_SKIES, art: "/art/modes/live.webp" },
      history: () => hist.filter((h) => h.ts > Date.now() - 60_000),
      signIn: () => {},
      mute: (m: boolean) => { try { const r = getGameRadio(); if (m) r.pause(); else r.clearPause(); } catch { /* no radio */ } },
      climb: {
        levels: CLIMB_LEVELS, maxGear: CLIMB_MAX_GEAR, runMs: CLIMB_RUN_MS, fee: CLIMB_FEE, feeLabel: CLIMB_FEE_LABEL,
        real: false, back: "/", lighter,
        state: () => ({ unlocked: readClimbLevel() }),
        finish: ({ level, pnl, test }: { level: number; pnl: number; test?: boolean }) => {
          const u = readClimbLevel(), to = test ? unlockAfterTest(u, level, pnl) : unlockAfter(u, level, pnl);
          if (to > u) saveClimbLevel(to);
          return { unlocked: Math.max(u, to) };
        },
        // test out is real money only (maker 2026-11-17); play money can't skip levels this way
        testOut: () => ({ error: "Test out opens with real money." }),
      },
    };
    const w = window as unknown as { DuelEngine?: { mount(root: HTMLElement, host: unknown): EngineApi } };
    loadDuelEngine().then(() => {
      if (dead || !ref.current || !w.DuelEngine) return;
      api = w.DuelEngine.mount(ref.current, host);
    }).catch(() => { if (ref.current) ref.current.textContent = "Couldn't load Climb. Refresh to try again."; });
    return () => { dead = true; stopPrice(); offWallet(); api?.destroy(); };
  }, []);
  return <div ref={ref} />;
}
