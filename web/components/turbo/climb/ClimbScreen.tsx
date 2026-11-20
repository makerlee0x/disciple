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
import ClimbAdvanced from "@/components/turbo/climb/ClimbAdvanced";
import RunFills from "@/components/turbo/climb/RunFills";
import { getTurboAdapter } from "@/lib/turbo";
import { getGameRadio } from "@/lib/game/radio";
import { useTurboMusic } from "@/lib/game/turboMusic";
import { CLIMB_FEE, CLIMB_FEE_LABEL, CLIMB_MAX_GEAR, climbLevelsAt, CLIMB_RUN_MS, climbStakeCap, climbStakePresets, stakeFor, unlockAfter, unlockAfterTest, type StakeChoice } from "@/lib/climb/rules";
import { mountStakePicker, readStakeChoice, saveStakeChoice } from "@/lib/climb/stakePicker";
import { readClimbLevel, saveClimbLevel } from "@/lib/climb/progress";
import { DUEL_SKIES, EXTRA_SKIES, loadDuelEngine } from "@/components/turbo/duel/engineLoader";
import { PCTS, pctUsd } from "@/lib/duel/rules";
import { LighterMatch, cashNote, lighterCash, lighterFetcher, lighterWanted, type MatchAction } from "@/lib/lighter/duel";
import { turboRegion } from "@/lib/turbo/region";
import GeoBanner from "@/components/turbo/GeoBanner";
import { mountRealSwitch } from "@/lib/turbo/realSwitch";
import { mountTurboPill } from "@/lib/turbo/turboPill";
import { lighterStatus } from "@/lib/lighter/client";
import { onTurboCash } from "@/lib/turbo/turboCash";
import { LIGHTER_PRICE_HOST, streamLighterBook, streamLighterMids } from "@/lib/turbo/royalePrices";
import { onWallet } from "@/lib/walletState";

type Tick = { ts: number; p: number };
interface EngineApi { price(p: number, ts: number): void; error?(t: string): void; climbRefresh?(): void; climbFill?(entry: number, btc?: number): void; climbNote?(t: string): void; climbCash?(delta: number): void; destroy(): void }
/** the buzzer's longest clock (app/api/lighter arm): free mode has none, so its position closes then */
const LIGHTER_ARM_MAX = 270_000;

export default function ClimbScreen() {
  const ref = useRef<HTMLDivElement>(null);
  const [gear, setGear] = useState(false);
  // bumped by the Simulator / Real money switch: the run is set up again in place, no page reload
  const [run, setRun] = useState(0);
  // the engine's lobby once mounted, and whether this run is on Real money (the Advanced record, ClimbAdvanced)
  const [eng, setEng] = useState<{ root: HTMLElement; real: boolean } | null>(null);
  // when the current real-money run began: the result card lists Lighter fills from then on (RunFills)
  const [runAt, setRunAt] = useState<number | null>(null);
  useTurboMusic();
  useEffect(() => {
    // real-money Turbo is off where Lighter refuses (lib/turbo/region), so the country is known before the run is set up
    let gone = false, off = () => {};
    void turboRegion().then(() => { if (!gone) off = boot(); });
    return () => { gone = true; off(); };
  }, [run]);
  function boot() {
    let dead = false, api: EngineApi | null = null;
    const hist: Tick[] = [];
    // on Lighter (maker 2026-11-18: "this should be real fills now") the balance is the pilot's Lighter cash, the chart
    // is that exchange's BTC price, entries are Lighter's fills and the result is the cash Lighter says it moved
    const onLighter = lighterWanted();
    // every level flies the stake picked under the Simulator / Real money switch (lib/climb/stakePicker), inside the
    // margin cap for the pilot's Turbo balance (lib/climb/rules climbStakeCap). The engine holds this array, so it is
    // updated in place and the levels screen redrawn when the balance or the stake moves.
    const stakeMode = onLighter ? "real" : "sim";
    let bal = 0, choice: StakeChoice = readStakeChoice(stakeMode), picker: { paint(): void; off(): void } | null = null;
    const levels = climbLevelsAt(stakeFor(choice, bal, onLighter));
    const relevel = () => { levels.splice(0, levels.length, ...climbLevelsAt(stakeFor(choice, bal, onLighter))); api?.climbRefresh?.(); picker?.paint(); };
    const setBalance = (usd: number) => { bal = usd; relevel(); };
    const ad = getTurboAdapter();
    let realCash: number | null = null;
    if (!onLighter) void ad.getFuel().then((f) => { if (!dead) setBalance(f.usd); }).catch(() => {});
    const offFuel = onLighter ? () => {} : ad.onFuel((f) => setBalance(f.usd));
    const tick = (price: number, at: number) => {
      const ts = at || Date.now(); hist.push({ ts, p: price });
      while (hist.length && hist[0].ts < ts - 90_000) hist.shift();
      api?.price(price, ts);
    };
    // On Lighter the chart is Lighter's own BTC from the first frame (public stream, no account needed), swapped for the
    // pilot's exchange once the account is read; before, it waited on that read and Climb "froze on 3" (maker
    // 2026-11-18). Only Lighter's price under real orders, so the chart, the fills and the PnL are one venue (maker
    // 2026-11-19: "the chart and price need to match"); a quiet Lighter holds its last price.
    let lastLx = 0, lastP = 0;
    const lxTick = (p: number) => {
      if (!lastLx) console.info("[climb] Lighter BTC price live");
      lastLx = Date.now(); lastP = p; tick(p, lastLx);
    };
    // the live order book's mid drives the chart; market_stats' mark price only fills a gap when the book is quiet
    let lastBook = 0;
    const lxStreams = (h?: string) => {
      const a = streamLighterBook("BTC", (m) => { lastBook = Date.now(); lxTick(m); }, h);
      const b = streamLighterMids((m) => { if (m.BTC && Date.now() - lastBook > 3_000) lxTick(m.BTC); }, h);
      return () => { a(); b(); };
    };
    let stopPrice = onLighter ? lxStreams() : ad.subscribePrice("BTC", (t) => tick(t.price, t.ts));
    const hold = onLighter ? setInterval(() => { if (lastP > 0 && Date.now() - lastLx > 2_000) tick(lastP, Date.now()); }, 1_000) : null;
    const noLx = onLighter ? setTimeout(() => { if (!lastLx) console.warn("[climb] no Lighter BTC price after 8 s"); }, 8_000) : null;
    const stopBackup = () => { if (hold) clearInterval(hold); if (noLx) clearTimeout(noLx); };
    let lf: ReturnType<typeof lighterFetcher> | null = null;
    /** the Lighter account now: cash, and the BTC position's real entry */
    const readLighter = async () => {
      if (!lf) return null;
      const s = await lighterStatus(lf);
      const cash = Number(s.collateral);
      const p = s.positions?.find((x) => x.symbol === "BTC");
      const open = p && Number(p.position) !== 0 ? Number(p.avg_entry_price) : null;
      return { s, cash: Number.isFinite(cash) ? cash : null, entry: open && open > 0 ? open : null, btc: open ? Math.abs(Number(p?.position)) : 0 };
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
        if (h && h !== LIGHTER_PRICE_HOST) { stopPrice(); stopPrice = lxStreams(h); }
      }).catch(() => {});
    });
    // Turbo cash moves while the page is open (a deposit from the Turbo pill, a withdraw, another tab): re-read Lighter so
    // the levels match the balance. maker 2026-11-20: the page read $0 before a $5.95 deposit landed, so Level 1 asked
    // for $12 and the run's "result" counted the deposit as profit.
    const reread = () => { if (!lf || dead) return; void readLighter().then((r) => { if (!dead && r && r.s.step === "ready" && r.cash != null) { host.climb.real = true; realCash = r.cash; setBalance(r.cash); } }).catch(() => {}); };
    let lastSeen = -1;
    // until Lighter's own read is in (or while set-up isn't finished), the stake cap follows the Turbo cash the pill shows
    const offTurbo = onLighter ? onTurboCash((t) => { if (Math.abs(t.usd - lastSeen) > 0.005) { lastSeen = t.usd; if (realCash == null) setBalance(t.usd); reread(); } }) : () => {};
    const onFocus = () => reread();
    if (onLighter) addEventListener("focus", onFocus);
    // startCash: Lighter cash read fresh as this run began. realRun: this run really placed orders on Lighter, the only
    // case where Lighter's cash delta is the run's result (a run that fell back to play money never reads it)
    let startCash: number | null = null, realRun = false, ended: Promise<void> = Promise.resolve();
    let curRun: { level: number; fuel: number; free?: boolean } | null = null;
    const sizesFor = (fuel: number) => PCTS.map((p) => (p === 0 ? fuel / (1 + gear * CLIMB_FEE) : pctUsd(p, fuel)) * gear / CLIMB_MAX_GEAR);
    const lighter = !lighterWanted() ? undefined : {
      /** Lighter's smallest BTC order, a position in $ (read once the account is ready); the engine rounds bets up to it */
      minUsd: 0,
      /** before the countdown: reads Lighter fresh, and resolves to null when the run's real orders are set, or to the
       *  reason they aren't. A real-money run (host.climb.real) doesn't start without them (the engine goes back to the
       *  levels with the reason); it never quietly flies on play money. */
      begin: (run: { level: number; fuel: number; gear: number; free?: boolean }): Promise<string | null> => {
        gear = run.gear; startCash = null; realRun = false; curRun = run;
        let why: string | null = null;
        lxP = (async () => {
          if (!wallet) { why = "Sign in to fly on Lighter."; return null; }
          const f = lighterFetcher(wallet);
          lf = f;
          const ok = await LighterMatch.ready(f);
          const r = await readLighter().catch(() => null);
          if (!ok || !r || r.s.step !== "ready" || r.cash == null) { why = await LighterMatch.notReadyWhy(f); return null; }
          if (r.entry != null) { why = "You still have a BTC position open on Lighter. Close it first."; return null; }
          host.climb.real = true;
          const moved = realCash == null || Math.abs(r.cash - realCash) > 0.005;
          realCash = r.cash;
          if (moved) {
            setBalance(r.cash);
            const now = run.free ? null : levels.find((l) => l.n === run.level);
            if (now && Math.abs(now.fuel - run.fuel) > 0.005) { why = "Your Turbo cash changed, so your levels did too."; return null; }
          }
          const cash = await lighterCash(f, run.fuel, run.gear);
          if (!cash.ok) { why = cashNote(cash.need); return null; }
          startCash = r.cash; realRun = true; setRunAt(Date.now());
          const lx = new LighterMatch(f, "BTC", sizesFor, run.fuel); lx.start(); return lx;
        })().catch(() => { why = "Can't reach Lighter right now. Try again in a moment."; return null; });
        return lxP.then(() => why);
      },
      arm: (endAt: number) => {
        const id = `climb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        // a level run carries its level and stake, so the server can score it from Lighter's fills for the Climb board
        const r = curRun, climb = r && !r.free ? { level: r.level, stake: r.fuel } : undefined;
        void lxP.then((lx) => lx?.arm("climb", id, { ms: Math.max(5_000, Math.min(LIGHTER_ARM_MAX, endAt - Date.now())), markets: ["BTC"], climb }));
      },
      press: (action: MatchAction, i: number, fuelAfter: number) => lxP.then(async (lx) => {
        if (!lx) return null;
        const r = await lx.press(action, i, fuelAfter);
        // the fill lands a moment after Lighter takes the order: read the real entry and size back for the chart and the PnL
        // (Lighter rounds a small bet up to its smallest order, so the real position can be bigger than the bet)
        if (!("error" in r) && action !== "close") setTimeout(() => { void readLighter().then((x) => { if (x?.entry) api?.climbFill?.(x.entry, x.btc); }).catch(() => {}); }, 700);
        // a cash out: once Lighter shows the position gone, the cash it moved since the run began is the real result so far
        if (!("error" in r) && action === "close") void (async () => {
          for (let k = 0; k < 8 && !dead; k++) {
            await new Promise((ok) => setTimeout(ok, k ? 500 : 700));
            const x = await readLighter().catch(() => null);
            if (x && x.cash != null && x.entry == null && startCash != null) { api?.climbCash?.(x.cash - startCash); return; }
          }
        })();
        return r;
      }),
      fuel: (fuel: number) => { void lxP.then((lx) => lx?.fuel(fuel)); },
      /** a NUKE is a liquidation: close the real position fully (closeAll waits for any press still going out) */
      nuke: () => { void lxP.then((lx) => lx?.closeAll()).catch(() => {}); },
      end: () => {
        const p = lxP; lxP = Promise.resolve(null);
        ended = p.then(async (lx) => { if (!lx) return; await lx.closeAll().catch(() => {}); lx.stop(); });
        return ended;
      },
      /** the run's real result: Lighter cash once the BTC position is gone, minus the cash before the run */
      result: async (): Promise<number | null> => {
        await ended;
        if (!realRun || startCash == null) return null;
        for (let i = 0; i < 8; i++) {
          const r = await readLighter().catch(() => null);
          if (r && r.cash != null && r.entry == null) { realCash = r.cash; setBalance(r.cash); return Math.round((r.cash - startCash) * 1e6) / 1e6; }
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
        // the switch's mode drives the screen (maker 2026-11-20: REAL MONEY on, but a run flew on play money under the
        // SIMULATOR pill because Lighter's set-up wasn't finished). On Real money a run never falls back to play money:
        // without real orders it goes back to the levels with the reason (lighter.begin).
        real: onLighter, back: "/", lighter,
        // Simulator and Real money each keep their own ladder (lib/climb/progress); on Real money only a run that really
        // placed orders on Lighter can unlock a level (a run that fell back to play money unlocks nothing)
        state: () => ({ unlocked: readClimbLevel(stakeMode) }),
        finish: ({ level, pnl, test }: { level: number; pnl: number; test?: boolean }) => {
          const u = readClimbLevel(stakeMode);
          if (onLighter && !realRun) return { unlocked: u };
          const to = test ? unlockAfterTest(u, level, pnl, levels) : unlockAfter(u, level, pnl, levels);
          if (to > u) saveClimbLevel(to, stakeMode);
          return { unlocked: Math.max(u, to) };
        },
      },
    };
    const w = window as unknown as { DuelEngine?: { mount(root: HTMLElement, host: unknown): EngineApi } };
    let offSwitch = () => {};
    let offPill = () => {};   // Turbo cash pill in the lobby header (lib/turbo/turboPill)
    loadDuelEngine().then(() => {
      if (dead || !ref.current || !w.DuelEngine) return;
      api = w.DuelEngine.mount(ref.current, host);
      offSwitch = mountRealSwitch(ref.current, () => setRun((n) => n + 1));
      offPill = mountTurboPill(ref.current);
      picker = mountStakePicker(ref.current,
        () => ({ choice, presets: climbStakePresets(bal, onLighter), cap: climbStakeCap(bal, onLighter), stake: stakeFor(choice, bal, onLighter) }),
        (c) => { choice = c; saveStakeChoice(stakeMode, c); relevel(); });
      setEng({ root: ref.current, real: onLighter });
    }).catch(() => { if (ref.current) ref.current.textContent = "Couldn't load Climb. Refresh to try again."; });
    return () => { dead = true; setEng(null); offSwitch(); offPill(); picker?.off(); offTurbo(); removeEventListener("focus", onFocus); stopPrice(); stopBackup(); offWallet(); offFuel(); api?.destroy(); };
  }
  return <><GeoBanner /><div ref={ref} /><ClimbAdvanced root={eng?.root ?? null} real={!!eng?.real} /><RunFills root={eng?.root ?? null} since={runAt} /><LobbySettings mode="climb" open={gear} onClose={() => setGear(false)} /></>;
}
