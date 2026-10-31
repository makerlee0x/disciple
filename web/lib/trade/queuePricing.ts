/**
 * SITE (lee, Oct 26 10:50–10:52 CDT): trades are never refused for price movement / slippage — a player who wants
 * out (or in) at a bad price gets a plain warning first (> 10 % price impact, tradeGuards), never a block.
 *
 * What still bounds minOut, and why (no contract / wallet.ts / gasPolicy / paymaster change):
 *  - One-tap session: DiscipleSessionPolicy re-quotes at execution and REVERTS when minOut < liveQuote × (1 − max)
 *    (MinOutTooLow). So the widest minOut a session trade can carry is the session max (minus headroom, lib/aa/slippage
 *    sessionCapBps) — anything lower is itself a refusal. Flagged for FLOW / GAME in the PR.
 *  - Owner-signed (no session): no policy floor ⇒ minOut is a dust floor (the router rejects 0 as a zero quote).
 * Back-to-back trades by the SAME player are priced after the ones already in flight ahead of them (hotCache
 * marginalQuote + INFLIGHT), and an in-flight amount is only released once the public RPC has seen the block it landed
 * in (it lags ~0.7 s; releasing at the receipt made the next sell quote the pre-trade price and miss its minOut).
 * A trade that definitely reverted on-chain on its minimum payout (the op ran and failed ⇒ nothing was traded) is
 * re-quoted and sent ONCE more. Timeouts / unknown outcomes are never resent (pendingWatch settles them).
 */
import { applySlippage } from "../curveMath";
import { sessionWindowMinOut } from "../aa/slippage";

const B = BigInt;
/** Requested slippage for "never refuse": clampSlippage caps it to the session max − headroom when a session is on. */
export const NO_REFUSE_SLIPPAGE_BPS = 9_999;
/** minOut that never refuses on its own: quote × (1 − bps) (session cap ⇒ the policy's widest); ≥ 1 wei. */
export function noRefuseMinOut(quote: bigint, slippageBps: number | null | undefined): bigint {
  const bps = slippageBps == null ? NO_REFUSE_SLIPPAGE_BPS : Math.min(NO_REFUSE_SLIPPAGE_BPS, Math.max(0, slippageBps));
  const mo = applySlippage(quote, bps);
  return mo > B(0) ? mo : B(1);
}

/**
 * minOut for a derived (minAmountOut 0) trade from the expected live range [lo, hi] (hotCache quoteRange).
 *  - No one-tap session: lo × (1 − slippage) (the caller's "never refuse" 99.99 % ⇒ a dust floor), as before.
 *  - One-tap session (policy floor minOut ≥ live × (1 − max)): the centered window (aa/slippage sessionWindowMinOut),
 *    so a move in the player's favor passes too; a caller asking for a TIGHTER floor (lo × (1 − slippage) above it)
 *    keeps it. The window minOut is ≤ lo whenever the range fits the window (lo ≥ hi × (1 − max)); a wider range is
 *    priced for the likelier order (earlier shot first ⇒ lo).
 */
export function tradeMinOut(r: { lo: bigint; hi: bigint }, slippageBps: number | null | undefined, sessionMaxBps: number | null | undefined, defaultBps = 100): bigint {
  const own = applySlippage(r.lo, slippageBps ?? defaultBps);
  if (sessionMaxBps == null || !(sessionMaxBps > 0) || r.lo <= B(0)) return own;
  // range wider than the window (no minOut clears both landing orders): price for the likelier one — the earlier
  // shot lands first (sent first) ⇒ lo
  const wide = r.lo * B(10_000) < r.hi * B(10_000 - Math.min(5000, Math.round(sessionMaxBps)));
  const w = wide ? sessionWindowMinOut(r.lo, r.lo, sessionMaxBps) : sessionWindowMinOut(r.lo, r.hi, sessionMaxBps);
  return own > w ? own : w;
}

/** Fill-to-limit (lee, Oct 31): an over-room buy sends more than the room costs and the curve partial-fills to the
 *  wallet cap. A quote that doesn't know the cap (model-scaled from other sizes, TRENCH quoteBuy, own in-flight buys
 *  applied uncapped) can promise more coins than the cap lets through ⇒ minOut is priced on min(quote, room) — never
 *  above the room ceiling (TradeBridge passes room × (1 − 0.5 %)). No ceiling ⇒ the range unchanged. */
export function roomCappedRange(r: { lo: bigint; hi: bigint }, maxOut?: bigint | null): { lo: bigint; hi: bigint } {
  if (maxOut == null || maxOut <= B(0)) return r;
  return { lo: r.lo < maxOut ? r.lo : maxOut, hi: r.hi < maxOut ? r.hi : maxOut };
}
/** Token units (float, as TradeBridge tracks holdings) → wei, floored (6 decimals of precision, never rounds up). */
export function tokensToWei(tokens: number, decimals = 18): bigint {
  if (!(tokens > 0) || !Number.isFinite(tokens)) return B(0);
  const micro = B(Math.floor(tokens * 1e6));
  return decimals >= 6 ? micro * B(10) ** B(decimals - 6) : micro / B(10) ** B(6 - decimals);
}

/** Release an in-flight amount once the RPC's head is ≥ the block the trade landed in (≤ maxMs; unknown block ⇒ lagMs). */
export async function holdInflightUntilSeen(done: () => void, block: bigint | number | undefined | null, head: () => Promise<bigint>,
  o: { lagMs?: number; maxMs?: number; everyMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    if (block == null) { await sleep(o.lagMs ?? 1200); return; }
    const want = B(block), until = Date.now() + (o.maxMs ?? 3000);
    while (Date.now() < until) {
      try { if ((await head()) >= want) return; } catch { /* keep waiting */ }
      await sleep(o.everyMs ?? 150);
    }
  } finally { done(); }
}

/** Definite on-chain min-out revert (the op executed and reverted, or handleOps reverted): nothing traded ⇒ safe to resend. */
export const isDefiniteRevert = (e: unknown) => (e as { code?: unknown } | null)?.code === "Reverted";

/**
 * Build (fresh quote) → send; on a definite revert, drop the quotes, build again from a fresh quote and send ONCE more.
 * Never resends an op whose outcome is unknown (anything but a definite revert is thrown as is).
 */
export async function sendWithRequote<T>(build: () => Promise<unknown>, send: (calls: never) => Promise<T>, dropQuotes: () => void,
  o: { retryable?: (e: unknown) => boolean } = {}): Promise<T & { resent?: boolean }> {
  const retryable = o.retryable ?? isDefiniteRevert;
  try { return (await send((await build()) as never)) as T & { resent?: boolean }; }
  catch (e) {
    if (!retryable(e)) throw e;
    console.warn("[disciple] trade reverted on its minimum payout (price moved); re-quoting and sending once more", { code: (e as { code?: unknown }).code });
    dropQuotes();
    const r = await send((await build()) as never);
    return Object.assign(r as object, { resent: true }) as T & { resent?: boolean };
  }
}
