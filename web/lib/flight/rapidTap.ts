/**
 * Rapid tap (GAME): several real trades in flight (≤ 3), each press its own reservation, all SYNC (no await before aaSend).
 * Pure helpers ⇒ unit-tested in scripts/test-rapid-tap.mjs. The registry is SITE's (#144 af12a357; shimmed:
 * ./reservationsShim): GAME reserves its press there (same id as TradeParams.reservationId) and reads spendable cash and
 * unreserved tokens from it — no GAME-side ledger. The gas reserve is FLOW's (#145; adapted: ./gasReserve), wired in as
 * SITE's gas reserve source (raw USDG base units).
 * AUDIT (timeouts): a receipt / relay timeout is SITE's typed 'pending_unknown' (ProtocolError.code / TradeResult.errorCode),
 * NEVER a failure: SITE keeps the hold (release() refuses it) and its background watcher (≤ 2 min, never resends) ends it
 * with a "resolved" event (outcome filled | error, txHash, amountOut) and then its "release". GAME keeps hovering until then.
 */
import { deployment } from "@/lib/chains";
import { usdToUsdgRaw, usdgDecimals, usdgRawToUsd } from "@/lib/usdg";
import { RESERVATIONS, release, reserve, reservedTokens, setGasReserveSource, subscribe, type ReleaseReason, type ReservationEvent } from "./reservationsShim";
import { gasReservePerOp } from "./gasReserve";

// FLOW's per-op gas reserve (raw USDG base units) is SITE's gas reserve source: every BOOST the trade layer reserves
// (ours by press id, or an auto id) holds one op's gas. TODO(#144/#145): keep this line when both shims become re-exports.
setGasReserveSource(() => gasReservePerOp());

/** PLACEHOLDER copy, for lee + BRAND to pick. `confirming` = SITE's PENDING_UNKNOWN_MSG (lib/aa/relayOp, #144). */
export const COPY = {
  inFlight: "3 IN FLIGHT", slowDown: "Slow down", spendLimit: "Spend limit reached", allSelling: "Already selling it all",
  confirming: "Still confirming your last trade…",
} as const;
/** relayOp.ts REJECTED_MSG (#138/#140): the definite-failure line. */
export const REJECTED = "That didn't go through. Try again.";

export type GameSide = "buy" | "sell";
const SIDE = { buy: "boost", sell: "dump" } as const;
/** $ → raw USDG (lib/usdg; decimals = the active USDG's, never hard-coded). */
export const usdToRaw = (usd: number): bigint => usdToUsdgRaw(usd, usdgDecimals());
/** raw USDG → $, for DISPLAY only (all reservation math stays in raw bigint). */
export const rawToUsd = (raw: bigint): number => usdgRawToUsd(raw, usdgDecimals());

let seq = 0;
export const nextPressId = () => `press-${Date.now().toString(36)}-${++seq}`;
/**
 * Reserve a press in SITE's registry (sync). Buy: its $ + one op's gas. Sell: one op's gas (USDG-paid gas comes out of
 * cash on a DUMP too) now; its tokens once sized (reservePressTokens). Idempotent per id; the trade layer merges into it.
 */
export function reservePress(id: string, side: GameSide, coin: string, usd?: number) {
  return reserve(id, { side: SIDE[side], coin, ...(side === "buy" && usd !== undefined ? { usd } : {}), gasReserve: gasReservePerOp() });
}
export function reservePressTokens(id: string, coin: string, tokenAmt: bigint) { return reserve(id, { side: "dump", coin, tokenAmt }); }
/** Release a press. SITE refuses (false) while it is pending_unknown: only its watcher ends that hold. */
export function releasePress(id: string, reason: ReleaseReason): boolean { return release(id, reason); }

const usdg = () => deployment().usdg;
/** Raw USDG held by every pending trade (SITE: Σ BOOST $ / exact spend + Σ gas caps), optionally except one press. */
export const pendingCashRaw = (exceptId?: string): bigint => RESERVATIONS.reservedRaw(usdg(), { usdg: usdg(), exceptId });
/** Raw USDG spendable now = raw cash − everything pending − (a new press) its own gas reserve. < 0 = short. */
export function spendableRaw(cashRaw: bigint, withOwnGas = true): bigint {
  return cashRaw - pendingCashRaw() - (withOwnGas ? gasReservePerOp() : BigInt(0));
}
/** Can this BOOST go out on top of what is pending? (raw compare, before its own reservation) */
export const canSpend = (cashRaw: bigint, usd: number) => spendableRaw(cashRaw) >= usdToRaw(usd);
/** DUMP sizing base: wallet balance − tokens already being sold by pending DUMPs (≥ 0). 50 % + 50 % ⇒ 75 % total. */
export function unreservedTokens(balance: bigint, coin: string): bigint { const r = balance - reservedTokens(coin); return r > BigInt(0) ? r : BigInt(0); }

/** SITE's tradeErrorCode(e) (#144 protocol-viem), mirrored: thrown ProtocolError.code or TradeResult.errorCode. */
export type TradeErrorCode = "rate_limited" | "spend_limit" | "pending_unknown";
export function tradeErrorCode(e: unknown): TradeErrorCode | undefined {
  const c = (e as { code?: unknown; errorCode?: unknown } | null)?.code ?? (e as { errorCode?: unknown } | null)?.errorCode;
  return c === "rate_limited" || c === "spend_limit" || c === "pending_unknown" ? c : undefined;
}
/** SITE 'pending_unknown': sent, still confirming — NOT a failure (hold kept; resolves via the registry). */
export const isPendingUnknown = (e: unknown) => tradeErrorCode(e) === "pending_unknown";
/** Trade result / error → the player's line. Typed codes first (SITE #144), else a string fallback for 429 / spend cap. */
export function tradeErrorCopy(r: { ok?: boolean; code?: string; errorCode?: string; reason?: string; message?: string; retryAfterMs?: number }): string | undefined {
  if (r.ok) return r.reason;
  const c = tradeErrorCode(r);
  if (c === "rate_limited") return COPY.slowDown;
  if (c === "spend_limit") return COPY.spendLimit;
  if (c === "pending_unknown") return COPY.confirming;
  const m = r.reason ?? r.message ?? "";
  if (/rate.?limit|too many (requests|trades)|\b429\b|-32005/i.test(m)) return COPY.slowDown;
  if (/SpendCapExceeded|one-tap budget|spend (cap|limit)/i.test(m)) return COPY.spendLimit;
  return r.reason ?? r.message;
}

/**
 * How a pending_unknown press ended (SITE's watcher):
 *  - filled: "resolved" outcome filled (txHash / amountOut when the watcher found the log), then "release" filled.
 *    No amountOut (and maybe no txHash) = it executed but the log wasn't found after the nonce moved ⇒ book from a
 *    balance re-read (pinned to the receipt block when a txHash is known).
 *  - error: dropped / reverted / its nonce used by another op ⇒ definite failure.
 *  - gone: the hold ended some other way (logout clear, or already gone when we looked) ⇒ calm, re-read balances.
 */
export type Resolution = { outcome: "filled"; txHash?: string; amountOut?: bigint } | { outcome: "error" } | { outcome: "gone" };
export function awaitResolution(pressId: string, o: { subscribe?: (cb: (e: ReservationEvent) => void) => () => void; held?: (id: string) => boolean } = {}): Promise<Resolution> {
  const sub = o.subscribe ?? subscribe, held = o.held ?? ((id: string) => RESERVATIONS.has(id));
  return new Promise<Resolution>((resolve) => {
    let done = false, seen: Resolution | undefined;
    const fin = (x: Resolution) => { if (done) return; done = true; off(); resolve(x); };
    const off = sub((e) => {
      if (done || e.id !== pressId) return;
      if (e.type === "resolved") seen = e.outcome === "filled" ? { outcome: "filled", ...(e.txHash ? { txHash: e.txHash } : {}), ...(e.amountOut !== undefined ? { amountOut: e.amountOut } : {}) } : { outcome: "error" };
      else if (e.type === "release") fin(seen ?? (e.reason === "filled" ? { outcome: "filled" } : e.reason === "error" ? { outcome: "error" } : { outcome: "gone" }));
    });
    if (!held(pressId)) fin({ outcome: "gone" });
  });
}
