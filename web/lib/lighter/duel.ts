/**
 * Real Lighter orders for a Turbo match (Trading Duel first; Climb and Royale next). The match's own book stays the
 * scoreboard (same server price for both pilots); this mirrors each press onto the pilot's own Lighter account through
 * pre-signed orders (LighterTaps), sent over Lighter's WebSocket, so a press reaches Lighter in ~350 ms.
 *
 * Hidden while it's tested on Lighter testnet: `?lighter=1` turns it on for this browser, `?lighter=0` off. It only
 * runs for a signed-in pilot whose Lighter set-up is finished (/lighter), and never in the iPhone app.
 */
import { withBase } from "@/lib/base-path";
import { privyAccessToken } from "@/lib/aa/sessionState";
import { isNativeApp } from "@/lib/native";
import { LighterTaps, lighterClose, lighterStatus, type TapKind } from "./client";

const FLAG = "disciple.lighter";
/** reads / applies the ?lighter= switch */
export function lighterWanted(): boolean {
  if (typeof window === "undefined" || isNativeApp()) return false;
  try {
    const q = new URLSearchParams(location.search).get("lighter");
    if (q === "1") localStorage.setItem(FLAG, "1");
    if (q === "0") localStorage.removeItem(FLAG);
    return localStorage.getItem(FLAG) === "1";
  } catch { return false; }
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
  static async ready(f: ReturnType<typeof lighterFetcher>) {
    try { return (await lighterStatus(f)).step === "ready"; } catch { return false; }
  }
  private sized(fuel: number) { return this.sizesFor(fuel).map((u) => Math.max(1, Math.floor(u * 100) / 100)); }

  /** tells the server this match is on Lighter, so its buzzer closes what's open even if this tab is gone
   *  (duel: when the room settles; climb / royale: after `ms`). Royale arms again on each new coin. */
  arm(kind: "duel" | "climb" | "royale", id: string, opts: { ms?: number; markets?: string[] } = {}) {
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
  /** buzzer / leaving: close whatever is open on Lighter (pre-signed close, else the server's close) */
  async closeAll(): Promise<void> {
    await this.chain.catch(() => {});
    const t = this.taps.ticket ?? (await this.taps.refresh());
    if (t?.close) { const r = await this.press("close", 0, 0); if (!("error" in r)) return; }
    await lighterClose(this.f, this.taps.market).catch(() => {}); // "Nothing open." is fine
  }
}
