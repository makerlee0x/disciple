/**
 * Real Lighter orders for a Turbo match (Trading Duel and Climb; Royale next). The match's own book stays the
 * scoreboard (same server price for both pilots); this mirrors each press onto the pilot's own Lighter account through
 * pre-signed orders (LighterTaps), sent over Lighter's WebSocket, so a press reaches Lighter in ~350 ms.
 *
 * Hidden while it's tested on Lighter testnet: `?lighter=1` turns it on for this browser, `?lighter=0` off. It only
 * runs for a signed-in pilot whose Lighter set-up is finished (/lighter), and never from a blocked country (lib/turbo/region).
 */
import { withBase } from "@/lib/base-path";
import { privyAccessToken } from "@/lib/aa/sessionState";
import { turboBlockedCached, turboRegion } from "@/lib/turbo/region";
import { cashNeed } from "@/lib/duel/rules";
import { LighterTaps, lighterFlatten, lighterSetUp, lighterStatus, type TapKind } from "./client";

export const NO_TURBO_CASH = "Add Turbo cash to play with real money.";
export const SETUP_FAILED = "Turbo set-up didn't finish. Try again.";
export const NOT_REACHED = "Can't reach Turbo right now. Try again in a moment.";

const FLAG = "disciple.lighter";
/** reads / applies the ?lighter= switch */
export function lighterWanted(): boolean {
  // the iPhone app too, outside blocked countries (maker 2026-11-19); the lobby switch (lib/turbo/realSwitch) sets it
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(location.search).get("lighter");
    if (q === "1") localStorage.setItem(FLAG, "1");
    if (q === "0") localStorage.removeItem(FLAG);
    if (localStorage.getItem(FLAG) !== "1") return false;
  } catch { return false; }
  // Lighter refuses US connections: real-money Turbo is off there (lib/turbo/region). The first call in a tab asks
  // /api/geo; Climb waits for that answer before it starts, the other modes use the last one and the server's own check
  void turboRegion();
  return !turboBlockedCached();
}

/** the lobby's Simulator / Real money switch (lib/turbo/realSwitch): same setting as ?lighter=1 / ?lighter=0 */
export function setLighterWanted(on: boolean) {
  try { if (on) localStorage.setItem(FLAG, "1"); else localStorage.removeItem(FLAG); } catch { /* private mode */ }
}

let tok: { t: string; at: number } | null = null;
async function token() {
  if (tok && Date.now() - tok.at < 30_000) return tok.t;
  const t = await privyAccessToken(); if (t) tok = { t, at: Date.now() }; return t;
}
export function lighterFetcher(wallet: string) {
  return async (input: string, init?: RequestInit) => {
    const t = await token();
    if (!t) throw new Error("Sign in first.");
    return fetch(withBase(input), { ...init, cache: "no-store", headers: { ...((init?.headers as Record<string, string>) ?? {}), authorization: `Bearer ${t}`, "x-wallet": wallet } });
  };
}

/** cross margin: Turbo cash backs the position, so it must cover the stake plus room for our NUKE to close first
 *  (lib/duel/rules cashNeed: $24 for a $20 duel at 50x). */
export async function lighterCash(f: ReturnType<typeof lighterFetcher>, stake: number, gear: number): Promise<{ ok: boolean; need: number }> {
  const need = cashNeed(stake, gear);
  try { return { ok: Number((await lighterStatus(f)).collateral ?? 0) + 1e-9 >= need, need }; } catch { return { ok: false, need }; }
}
export const cashNote = (need: number) => `You need $${need.toFixed(2)} in Turbo cash for this match.`;

export type MatchAction = "boost" | "dump" | "close";
/**
 * One pilot's Lighter side of a match. `sizesFor(fuel)` turns the fuel left into the $ of each size button, in button
 * order (the match passes the index of the button pressed). Presses run one after another.
 */
export class LighterMatch {
  readonly taps: LighterTaps;
  private chain: Promise<unknown> = Promise.resolve();
  private live = false;
  lastMs: number | null = null;

  constructor(private f: ReturnType<typeof lighterFetcher>, market: string, private sizesFor: (fuel: number) => number[], fuel: number) {
    this.taps = new LighterTaps(f, market, this.sized(fuel));
    this.taps.wantSocket = true;
  }
  /** set-up finished on Lighter? (step "ready") */
  /** Ready to trade. A funded account whose set-up stopped part way (maker 2026-11-20: $5.95 landed, then "Lighter isn't
   *  set up for this wallet") finishes it here with the same silent signatures, instead of sending the player elsewhere. */
  static async ready(f: ReturnType<typeof lighterFetcher>) {
    try {
      const { step } = await lighterStatus(f);
      if (step === "ready") return true;
      if (step === "deposit") return false;
      const { aaSignMessage } = await import("@/lib/aa/session");
      const sign = async (m: string) => { const x = await aaSignMessage(m); if (!x) throw new Error("Your wallet didn't sign."); return x.sig; };
      return (await lighterSetUp(f, sign)) === "ready";
    } catch { return false; }
  }
  /** the player line when ready() is false: no Turbo cash yet, or set-up still didn't finish */
  static async notReadyWhy(f: ReturnType<typeof lighterFetcher>): Promise<string> {
    const st = await lighterStatus(f).catch(() => null);
    return !st ? NOT_REACHED : st.step === "deposit" ? NO_TURBO_CASH : SETUP_FAILED;
  }
  private sized(fuel: number) { return this.sizesFor(fuel).map((u) => Math.max(0, Math.floor(u * 100) / 100)); }

  /** tells the server this match is on Lighter, so its buzzer closes what's open even if this tab is gone
   *  (duel: when the room settles; climb / royale: after `ms`). Royale arms again on each new coin. */
  arm(kind: "duel" | "climb" | "royale", id: string, opts: { ms?: number; markets?: string[]; climb?: { level: number; stake: number } } = {}) {
    return this.f("/api/lighter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "arm", kind, id, ...opts }) })
      .then((r) => r.ok).catch(() => false);
  }
  /** signs ahead and keeps the connection to Lighter open (call from the lobby / ready check) */
  start() { if (this.live) return; this.live = true; this.taps.start(); }
  stop() { this.live = false; this.taps.stop(); }
  /** the server's book moved the fuel left (a trade, a NUKE): re-sign when the sizes changed by more than a cent or two */
  fuel(fuel: number) {
    const z = this.sized(fuel), cur = this.taps.sizes;
    if (z.length !== cur.length || z.some((v, i) => Math.abs(v - cur[i]) > Math.max(0.02, v * 0.01))) this.taps.set(this.taps.market, z);
  }
  /** a press: `i` = size button, `fuelAfter` = the fuel the match expects to have left after it */
  press(action: MatchAction, i: number, fuelAfter: number): Promise<{ ms: number } | { error: string }> {
    const kind: TapKind = action === "boost" ? "long" : action === "dump" ? "short" : "close";
    const run = async () => {
      try {
        const r = await this.taps.tap(kind, "ws", i, this.sized(fuelAfter));
        this.lastMs = r.ms; return { ms: r.ms };
      } catch (e) { return { error: `Lighter: ${(e as Error).message}` }; }
    };
    const p = this.chain.then(run, run);
    this.chain = p;
    return p;
  }
  /** NUKE / buzzer / leaving: close everything open on Lighter, fully. The pre-signed close goes first (fastest), then
   *  the server reads the real position and closes whatever is left until Lighter shows nothing open. */
  async closeAll(): Promise<{ flat: boolean }> {
    await this.chain.catch(() => {});
    const t = this.taps.ticket ?? (await this.taps.refresh().catch(() => null));
    if (t?.close) await this.press("close", 0, 0);
    const done = this.chain.then(() => lighterFlatten(this.f, this.taps.market)).then((r) => ({ flat: r.flat }), () => ({ flat: false }));
    this.chain = done;
    return done;
  }
}
