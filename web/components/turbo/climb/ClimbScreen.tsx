"use client";
/**
 * /turbo/climb: Climb, the solo Turbo mode (maker 2026-11-17/18). The screens are the Trading Duel engine
 * (public/turbo/duel/engine.js) with host.climb set: no rival, levels, a goal line and a zoomed sky. This host feeds
 * live BTC, keeps the unlocked level (lib/climb/progress) and applies the unlock rule (lib/climb/rules).
 * Play money only until the Lighter / Nova adapter is live, so test out stays locked.
 */
import { useEffect, useRef } from "react";
import { getTurboAdapter } from "@/lib/turbo";
import { getGameRadio } from "@/lib/game/radio";
import { useTurboMusic } from "@/lib/game/turboMusic";
import { CLIMB_FEE, CLIMB_FEE_LABEL, CLIMB_LEVELS, CLIMB_MAX_GEAR, CLIMB_RUN_MS, unlockAfter, unlockAfterTest } from "@/lib/climb/rules";
import { readClimbLevel, saveClimbLevel } from "@/lib/climb/progress";
import { DUEL_SKIES, EXTRA_SKIES, loadDuelEngine } from "@/components/turbo/duel/engineLoader";

type Tick = { ts: number; p: number };
interface EngineApi { price(p: number, ts: number): void; destroy(): void }

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
    const host = {
      assets: { ...Object.fromEntries(["rocket", ...DUEL_SKIES].map((k) => [k, `/turbo/duel/${k}.webp`])), ...EXTRA_SKIES, art: "/art/modes/live.webp" },
      history: () => hist.filter((h) => h.ts > Date.now() - 60_000),
      signIn: () => {},
      mute: (m: boolean) => { try { const r = getGameRadio(); if (m) r.pause(); else r.clearPause(); } catch { /* no radio */ } },
      climb: {
        levels: CLIMB_LEVELS, maxGear: CLIMB_MAX_GEAR, runMs: CLIMB_RUN_MS, fee: CLIMB_FEE, feeLabel: CLIMB_FEE_LABEL,
        real: false, back: "/",
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
    return () => { dead = true; stopPrice(); api?.destroy(); };
  }, []);
  return <div ref={ref} />;
}
