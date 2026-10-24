/**
 * Rapid tap (GAME): several real trades in flight (≤ 3), each press its own reservation, all SYNC (no await before aaSend).
 * Pure helpers ⇒ unit-tested in scripts/test-rapid-tap.mjs. The registry is SITE's (#144; shimmed: ./reservationsShim),
 * the gas reserve FLOW's (adapted: ./gasReserve).
 * AUDIT (timeouts): a sync send that times out (20 s) can still land ⇒ a timeout is UNKNOWN, never a failure. The press
 * keeps its reservation and the rocket keeps hovering until the outcome is known (receipt lookup or SITE's resolution);
 * a late landing resolves as a normal fill, a definite failure (revert / rejected / error) eases back.
 */
import { reserve, release, reservedTokens, type ReleaseReason, type ReservationEvent } from "./reservationsShim";
import { gasReservePerOp } from "./gasReserve";

/** PLACEHOLDER copy, for lee + BRAND to pick. */
export const COPY = {
  inFlight: "3 IN FLIGHT", slowDown: "Slow down", spendLimit: "Spend limit reached", allSelling: "Already selling it all",
  confirming: "Still confirming…", checkBalance: "Couldn't confirm yet. Check your balance in a moment.",
} as const;
/** relayOp.ts REJECTED_MSG (#138/#140): the definite-failure line. */
export const REJECTED = "That didn't go through. Try again.";

export type GameSide = "buy" | "sell";
const SIDE = { buy: "boost", sell: "dump" } as const;
/** $ → raw USDG (USDG is $1; decimals from config — 18 on today's testnet, 6 after the redeploy). Exact to the µ$. */
export const usdToRaw = (usd: number, usdgDecimals: number): bigint =>
  usd > 0 && Number.isFinite(usd) ? BigInt(Math.round(usd * 1e6)) * BigInt(10) ** BigInt(usdgDecimals) / BigInt(1e6) : BigInt(0);
/** raw USDG → $, for DISPLAY only (all reservation math stays in raw bigint). */
export const rawToUsd = (raw: bigint, usdgDecimals: number) => Number(raw) / 10 ** usdgDecimals;

/** One GAME press = one ledger entry (same id in SITE's registry and TradeParams.reservationId). */
export interface Press { id: string; side: GameSide; coin: string; amountInUsd?: number; tokenAmt?: bigint; gasReserve: bigint; unknown?: true }
let seq = 0;
export const nextPressId = () => `press-${Date.now().toString(36)}-${++seq}`;
const LEDGER = new Map<string, Press>();
const toRegistry = (p: Press) => reserve(p.id, { side: SIDE[p.side], coin: p.coin, usd: p.amountInUsd, tokenAmt: p.tokenAmt, gasReserve: p.gasReserve });
/** Reserve a press (sync). Buy: its $ + one op's gas. Sell: one op's gas now; its tokens once sized (reservePressTokens). */
export function reservePress(id: string, side: GameSide, coin: string, usd?: number): Press {
  const p: Press = { id, side, coin, ...(side === "buy" ? { amountInUsd: usd } : {}), gasReserve: gasReservePerOp() };   // raw USDG (FLOW)
  LEDGER.set(id, p); toRegistry(p); return p;
}
export function reservePressTokens(id: string, tokenAmt: bigint) { const p = LEDGER.get(id); if (!p) return; p.tokenAmt = tokenAmt; toRegistry(p); }
/** Outcome unknown (timeout): keep holding. Re-asserts the registry hold if SITE released it (its Timeout / 60 s TTL backstop). */
export function holdPress(id: string) { const p = LEDGER.get(id); if (!p) return; p.unknown = true; toRegistry(p); }
export function releasePress(id: string, reason: ReleaseReason) { LEDGER.delete(id); release(id, reason); }
export const pendingPresses = () => [...LEDGER.values()];
export const isHeld = (id: string) => LEDGER.has(id);

/** Raw USDG held by GAME's pending presses: Σ buy spend + Σ gas reserve (every pending op). */
export function pendingCashRaw(usdgDecimals: number): bigint {
  let t = BigInt(0); for (const p of LEDGER.values()) t += (p.side === "buy" ? usdToRaw(p.amountInUsd ?? 0, usdgDecimals) : BigInt(0)) + p.gasReserve; return t;
}
/**
 * Raw USDG spendable now = raw cash − Σ pending (spend + gas reserve) − this op's own gas reserve (≥ 0 not clamped: < 0 = short).
 * GAME's own ledger, in raw bigint (SITE's reservedCash() is a $ number for display; see the PR body on its 6-dec assumption).
 */
export function spendableRaw(cashRaw: bigint, usdgDecimals: number, withOwnGas = true): bigint {
  return cashRaw - pendingCashRaw(usdgDecimals) - (withOwnGas ? gasReservePerOp() : BigInt(0));
}
/** Can this BOOST go out on top of what is pending? (raw compare) */
export const canSpend = (cashRaw: bigint, usd: number, usdgDecimals: number) => spendableRaw(cashRaw, usdgDecimals) >= usdToRaw(usd, usdgDecimals);
/** DUMP sizing base: wallet balance − tokens already being sold by pending DUMPs (≥ 0). 50 % + 50 % ⇒ 75 % total. */
export function unreservedTokens(balance: bigint, coin: string): bigint { const r = balance - reservedTokens(coin); return r > BigInt(0) ? r : BigInt(0); }

/** SITE's tradeErrorCode(e) (#144 protocol-viem), mirrored: thrown ProtocolError.code or TradeResult.errorCode. */
export type TradeErrorCode = "rate_limited" | "spend_limit";
export function tradeErrorCode(e: unknown): TradeErrorCode | undefined {
  const c = (e as { code?: unknown; errorCode?: unknown } | null)?.code ?? (e as { errorCode?: unknown } | null)?.errorCode;
  return c === "rate_limited" || c === "spend_limit" ? c : undefined;
}
/** Trade result / error → the player's error line. Typed codes first (SITE #144), else a string fallback. */
export function tradeErrorCopy(r: { ok?: boolean; code?: string; errorCode?: string; reason?: string; message?: string; retryAfterMs?: number }): string | undefined {
  if (r.ok) return r.reason;
  const c = tradeErrorCode(r);
  if (c === "rate_limited") return COPY.slowDown;
  if (c === "spend_limit") return COPY.spendLimit;
  const m = r.reason ?? r.message ?? "";
  if (/rate.?limit|too many (requests|trades)|\b429\b|-32005/i.test(m)) return COPY.slowDown;
  if (/SpendCapExceeded|one-tap budget|spend (cap|limit)/i.test(m)) return COPY.spendLimit;
  return r.reason ?? r.message;
}

/** A send whose outcome is UNKNOWN (sync send timed out / lost answer): may still land. Never a failure. */
export function isUnknownOutcome(e: unknown): boolean {
  const x = e as { code?: unknown; reason?: unknown; message?: unknown; cause?: unknown } | null;
  if (!x) return false;
  if (x.code === "Timeout") return true;
  const m = String(x.reason ?? x.message ?? "");
  if (/expired/i.test(m)) return false;   // "The trade took too long and expired" = definite (deadline revert)
  if (/still confirming|not confirmed|timed? ?out/i.test(m)) return true;
  return x.cause ? isUnknownOutcome(x.cause) : false;
}
/** Op ids carried by an error (AAError.extra / ProtocolError fields / cause chain), when the trade layer keeps them. */
export function opIds(e: unknown): { txHash?: string; userOpHash?: string } {
  for (let x = e as Record<string, unknown> | undefined, i = 0; x && i < 4; x = x.cause as Record<string, unknown> | undefined, i++) {
    const ex = (x.extra ?? {}) as Record<string, unknown>;
    const txHash = (x.txHash ?? ex.txHash) as string | undefined, userOpHash = (x.userOpHash ?? ex.userOpHash) as string | undefined;
    if (txHash || userOpHash) return { ...(txHash ? { txHash } : {}), ...(userOpHash ? { userOpHash } : {}) };
  }
  return {};
}

export type LateOutcome = { state: "landed"; txHash?: string } | { state: "failed"; reason: string } | { state: "unknown" };
/** Poll schedule (ms after the timeout) for the receipt lookup; then give up as unknown (balance polls catch up). */
export const LATE_POLL_MS = [1000, 2000, 3000, 5000, 8000, 13000, 21000, 30000, 40000];
/**
 * Resolve a timed-out press. Sources, first wins: (1) the receipt of txHash (success ⇒ landed, reverted ⇒ failed);
 * (2) SITE's registry release of this press id ("filled" ⇒ landed, "error" ⇒ failed; "timeout"/"cancel" are SITE's
 * backstops, NOT an outcome ⇒ re-hold). Never throws; ends "unknown" after the schedule. No await before any send.
 */
export function watchOutcome(o: {
  pressId: string; txHash?: string;
  lookup?: (h: string) => Promise<{ status: "success" | "reverted" } | null>;
  subscribe?: (cb: (e: ReservationEvent) => void) => () => void;
  sleep?: (ms: number) => Promise<void>; schedule?: number[];
}): Promise<LateOutcome> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  holdPress(o.pressId);
  return new Promise<LateOutcome>((resolve) => {
    let done = false; const fin = (x: LateOutcome) => { if (done) return; done = true; off?.(); resolve(x); };
    const off = o.subscribe?.((e) => {
      if (done || e.id !== o.pressId || e.type !== "release") return;
      if (e.reason === "filled") fin({ state: "landed", txHash: o.txHash });
      else if (e.reason === "error") fin({ state: "failed", reason: REJECTED });
      else holdPress(o.pressId);   // SITE's timeout / TTL: only a backstop — keep holding until the outcome is known
    });
    void (async () => {
      let t = 0;
      for (const at of o.schedule ?? LATE_POLL_MS) {
        await sleep(Math.max(0, at - t)); t = at; if (done) return;
        if (!o.txHash || !o.lookup) continue;
        const r = await o.lookup(o.txHash).catch(() => null); if (done) return;
        if (r?.status === "success") return fin({ state: "landed", txHash: o.txHash });
        if (r?.status === "reverted") return fin({ state: "failed", reason: REJECTED });
      }
      fin({ state: "unknown" });
    })();
  });
}
