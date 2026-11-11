import "server-only";
/**
 * Item a (#245 residual): relayer-loss circuit breaker for the self-bundler. Exact simulation runs before every
 * signature, but state can still move between simulation and inclusion, so an INCLUDED handleOps can revert (the relayer
 * pays the outer gas) or reimburse less than it cost. When that happens beyond a threshold within a window, self-mode
 * sends pause: requests are refused notSent (nothing leased, signed or sent). No automatic transport switch: the
 * deployment's configured mode (GAS_SPONSORSHIP_MODE=bso is the existing explicit fallback) stays the operator's choice.
 *
 * Happy path cost: ZERO round trips. The open flag lives in KV (shared) and is mirrored in-process; the request path
 * only reads the mirror and, at most every REFRESH_MS, kicks a background (never awaited) KV GET. Recording happens
 * after the receipt and only touches KV when the bundle reverted or lost ETH.
 */
import { kv as defaultKv, type Kv } from "./kv";

export const BREAKER_OPEN_KEY = "relay:breaker:open";
const REVERTS_KEY = "relay:breaker:reverts", LOSS_KEY = "relay:breaker:lossGwei";
export type BreakerConfig = { windowSec: number; pauseSec: number; revertTrip: number; lossTripGwei: number; refreshMs: number };
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
/** Defaults need no env: 2 included reverts, or 100,000 gwei (0.0001 ETH ≈ 12 trades' outer gas) net loss, within
 *  10 min ⇒ pause 15 min. RELAY_BREAKER_* only retunes the numbers (non-positive/invalid ⇒ default); there is no off switch. */
export function breakerConfig(env: Record<string, string | undefined> = process.env): BreakerConfig {
  return { windowSec: num(env.RELAY_BREAKER_WINDOW_SEC, 600), pauseSec: num(env.RELAY_BREAKER_PAUSE_SEC, 900),
    revertTrip: num(env.RELAY_BREAKER_REVERTS, 2), lossTripGwei: num(env.RELAY_BREAKER_LOSS_GWEI, 100_000), refreshMs: 2000 };
}

export class RelayBreaker {
  private openUntil = 0; private checkedAt = 0; private refreshing?: Promise<void>;
  constructor(private store: () => Kv = defaultKv, private cfg: BreakerConfig = breakerConfig(), private now: () => number = Date.now) {}
  /** Background mirror refresh (never awaited by a request). A store error keeps the last known state. */
  refresh(): Promise<void> {
    return (this.refreshing ??= this.store().get(BREAKER_OPEN_KEY).then((v) => {
      const until = Number(v); this.openUntil = v && Number.isFinite(until) ? Math.max(until, this.openUntil > this.now() ? this.openUntil : 0) : (this.openUntil > this.now() ? this.openUntil : 0);
      this.checkedAt = this.now();
    }, () => undefined).finally(() => { this.refreshing = undefined; }));
  }
  /** Sync, no I/O on the caller's path: throws notSent while open. */
  assertClosed() {
    if (this.now() - this.checkedAt >= this.cfg.refreshMs) void this.refresh();
    if (this.openUntil > this.now())
      throw Object.assign(new Error("relay paused: relayer loss circuit open; nothing sent, try again later"), { notSent: true, paused: true });
  }
  isOpen() { return this.openUntil > this.now(); }
  /** After an included bundle. `lossWei` = outer gas cost − EntryPoint reimbursement (≤ 0 ⇒ none). Only a revert or a
   *  loss touches KV (awaited by the caller on that path only). */
  async record(o: { reverted: boolean; lossWei: bigint }): Promise<boolean> {
    const loss = o.lossWei > 0n ? Number((o.lossWei + 999_999_999n) / 1_000_000_000n) : 0;
    if (!o.reverted && loss <= 0) return false;
    const st = this.store();
    const [reverts, lossGwei] = await Promise.all([
      o.reverted ? st.incrEx(REVERTS_KEY, this.cfg.windowSec) : Promise.resolve(0),
      loss > 0 ? st.incrByEx(LOSS_KEY, loss, this.cfg.windowSec) : Promise.resolve(0),
    ]);
    const trip = reverts >= this.cfg.revertTrip || lossGwei >= this.cfg.lossTripGwei;
    console.warn("[disciple] relay breaker loss recorded", { reverted: o.reverted, lossGwei: loss, windowReverts: reverts, windowLossGwei: lossGwei, trip });
    if (!trip) return false;
    const until = this.now() + this.cfg.pauseSec * 1000;
    this.openUntil = Math.max(this.openUntil, until);   // this instance stops at once
    await st.setNX(BREAKER_OPEN_KEY, String(until), this.cfg.pauseSec);
    console.error("[disciple] relay breaker OPEN: self-mode sends paused", { untilMs: until, windowReverts: reverts, windowLossGwei: lossGwei });
    return true;
  }
}
export const relayBreaker = new RelayBreaker();

type Log = { address: string; topics: readonly string[]; data: string };
const UO_EVENT = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
/** Relayer net for one handleOps receipt: Σ UserOperationEvent.actualGasCost (paid to the beneficiary = relayer) −
 *  gasUsed × effectiveGasPrice. undefined when the price isn't on the receipt (then only the revert counts). */
export function relayerNetWei(rc: { status: string; gasUsed: string; effectiveGasPrice?: string; logs?: readonly Log[] }, entryPoint: string): bigint | undefined {
  if (!rc.effectiveGasPrice) return undefined;
  const cost = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice);
  let reimb = 0n;
  for (const l of rc.logs ?? []) if (l.address.toLowerCase() === entryPoint.toLowerCase() && l.topics[0]?.toLowerCase() === UO_EVENT && l.data.length >= 2 + 64 * 4)
    reimb += BigInt(`0x${l.data.slice(2 + 64 * 2, 2 + 64 * 3)}`);   // data: nonce, success, actualGasCost, actualGasUsed
  return reimb - cost;
}
