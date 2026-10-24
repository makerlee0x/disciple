/**
 * viem implementation of ProtocolClient against DISCIPLE FLOW PR #4 (flow/contracts-api).
 *  - No custody/vault: the Privy embedded wallet (lib/wallet.ts) signs every tx.
 *  - Approve once (max) per spender: curve pre-grad, DiscipleRouter post-grad, Launchpad for creator buys.
 *  - Previews come from on-chain views (quoteBuy/quoteSell) or router.quoteExactIn (eth_call) post-grad.
 *  - Quote decimals are read per token (USDG = 6, STRATEGY = 18); never assumed.
 */
import { routerUsdg, payUsdg, usdgRouteQuote, routerBuyWithUsdgCalls, routerSellToUsdgCalls, toCalls } from "./trade/usdgRouter";
import { COIN_DECIMALS, knownDecimals, readUsdgDecimals, usdgRawToUsd, usdToUsdgRaw } from "./usdg";
import { BALANCES, COIN, QUOTES, LAST_QUOTE, TRADER_QUOTES, REQUOTE, scaledQuote, marginalQuote, key as ckey } from "./trade/hotCache";
import { RESERVATIONS, autoReservationId, spendable } from "./trade/reservations";
import { chainWatchDeps, holdLate, lazyWatchDeps, pendingOpOf, startPendingOp, type OpLanding, type PendingSend } from "./trade/pendingOps";
import { startTradeTiming, type TradeTiming } from "./trade/timing";
import { asTrade } from "./aa/session";
import { READ_FLOOR, flooredTransport, receiptBlock } from "./trade/readFloor";
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, decodeErrorResult, decodeEventLog, encodeFunctionData, http, maxUint256, parseAbi, type Hex, type PublicClient,
} from "viem";
import { anonLauncherAbi, bondingCurveAbi, discipleRouterAbi, launchpadAbi, tokenAbi } from "./abi";
import { readCoinMcap } from "./mcap";
import { NO_PRICE_MSG, PENDING_MSG, PENDING_UNKNOWN_MSG, REJECTED_MSG, SLOW_DOWN_MSG, SPEND_LIMIT_MSG, logTradeError, plainText, type TradeErrorCode } from "./aa/relayOp";
import { ANON_ADDONS } from "./anon";
import { ACTIVE_CHAIN, deployment, hasRouter, isDeployed } from "./chains";
import { referrerWallet } from "./referral";
import { DEFAULT_LAUNCH_MODE, LAUNCH_MODE_NAME, LaunchMode, effectiveCreatorBuyCapBps, encodeLaunchCall, modesActive, modesErrorsAbi } from "./launchAbi";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
const referralRegistryAbi = parseAbi([
  "function referrerOf(address wallet) view returns (address)",
  "function pendingReferrer(address wallet) view returns (address)",
  "function tryAttribute(address wallet, address referrer) returns (bool)",
]);
import { CURVE, TIERS } from "./config";
import { applySlippage, creatorBuyMaxTokens, type CurveParams } from "./curveMath";
import type {
  Address, CurveState, LaunchCoinParams, LaunchCoinResult, ProtocolClient, TradeParams, TradeQuote, TradeResult,
} from "./protocol";
import { ZERO_ADDRESS } from "./protocol";
import { activeAddress, connectedAddress, execCalls, isSmartMode, type ExecResult } from "./wallet";
import { ensurePveLogin, PveError } from "./pve";
import { seedCreatorBuyPosition } from "./pnl";
import { AAError, type Call } from "./aa/core";
const erc20Events = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

const B = BigInt;
const DEFAULT_SLIPPAGE_BPS = 100; // 1%
const now = () => Math.floor(Date.now() / 1000);
const wadToNum = (v: bigint) => Number(v) / 1e18;
/** USD value of `raw` quote units given quotePriceUsd (USD WAD per 1e18 raw units). */
export const quoteRawToUsd = (raw: bigint, quotePriceUsd: bigint) => Number((raw * quotePriceUsd) / B(1e18)) / 1e18;

const fmtUnits = (v: bigint, dec = 18) => { const d = Number(v) / 10 ** dec; return d >= 1e-4 || d === 0 ? d.toPrecision(4) : d.toExponential(2); };

/** pending_unknown: the op the press sent (watched in the background until it lands or is dropped). */
// nonce = the op's EntryPoint v0.7 nonce (SITE mav2); relayNonce = FLOW #141's relayer EOA nonce of the handleOps tx
// reservationId: the press; absent when there is none (launch: no hold, no watcher)
export type PendingOpRef = { reservationId?: string; userOpHash?: string; txHash?: string; nonce?: bigint; relayNonce?: number };
export class ProtocolError extends Error {
  /** rate_limited: the relay's Retry-After in ms, when it sent one. */
  retryAfterMs?: number;
  /** pending_unknown: the op's ids / nonce and the press (reservation) id; its outcome arrives as a "resolved" event. */
  op?: PendingOpRef;
  /**
   * FLOW #141 (RelayUnclearInfo): set ONLY when mapping an unclear relay Timeout ({ unclear, reason, userOpHash?,
   * txHash?, relayNonce? }); console / support detail, never player copy. `declare`: no own field unless set (lib/aa/relayOp
   * unknownOpOf tells AA send errors by an own `extra`).
   */
  declare extra?: Record<string, unknown>;
  constructor(public code: string, msg: string, o?: { retryAfterMs?: number; op?: PendingOpRef; extra?: Record<string, unknown> }) {
    super(msg);
    if (o?.retryAfterMs !== undefined) this.retryAfterMs = o.retryAfterMs;
    if (o?.op) this.op = o.op;
    if (o?.extra) this.extra = o.extra;
  }
}
/**
 * Typed code GAME maps to its copy ('Slow down' / 'Spend limit reached' / 'Still confirming your last trade…');
 * undefined for every other failure. 'pending_unknown' is NOT a failure: the press is still held and resolves later.
 */
export function tradeErrorCode(e: unknown): TradeErrorCode | undefined {
  const c = (e as { code?: unknown })?.code;
  return c === "rate_limited" || c === "spend_limit" || c === "pending_unknown" ? c : undefined;
}

/** Map contract custom errors to friendly copy. */
const ozErrors = parseAbi([
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error Error(string)",
]);
/** MAv2 hook wrappers + DiscipleSessionPolicy errors (one-tap session key path). */
const sessionErrors = parseAbi([
  "error PreExecHookReverted(bytes24 moduleFunction, bytes revertReason)",
  "error PreUserOpValidationHookReverted(bytes24 moduleFunction, bytes revertReason)",
  "error PreRuntimeValidationHookReverted(bytes24 moduleFunction, bytes revertReason)",
  "error SpendCapExceeded(address quote, uint256 spent, uint256 cap)",
  "error MinOutTooLow(uint256 minOut, uint256 required)",
  "error QuoteFailed(address target)",
  "error SessionInactive()", "error SessionExpired()", "error NotAllowed(address target, bytes4 selector)",
  "error UsdgApproveNotExact(uint256 amount, uint256 required)", "error RecipientNotAccount()", "error SpenderNotAllowed(address spender)",
  // EntryPoint v0.7 handleOps simulation: the inner bytes of FailedOpWithRevert are the account's / policy's revert
  "error FailedOp(uint256 opIndex, string reason)", "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
  // Uniswap v4 (post-grad sells through the router): slippage / price-limit reverts
  "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)", "error V4TooMuchRequested(uint256 maxAmountInRequested, uint256 amountRequested)",
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
]);
function decodeRevert(data?: Hex): { errorName: string; args?: readonly unknown[] } | null {
  if (!data) return null;
  try {   // unwrap the account's hook wrapper to the policy's own error
    const w = decodeErrorResult({ abi: sessionErrors, data });
    if (/HookReverted$/.test(w.errorName)) return decodeRevert((w.args as readonly unknown[])[1] as Hex) ?? { errorName: w.errorName };
    if (w.errorName === "FailedOpWithRevert") return decodeRevert((w.args as readonly unknown[])[2] as Hex) ?? { errorName: "FailedOp", args: [(w.args as readonly unknown[])[1]] };
    if (w.errorName === "FailedOp") return { errorName: "FailedOp", args: [(w.args as readonly unknown[])[1]] };
    if (w.errorName === "WrappedError") return decodeRevert((w.args as readonly unknown[])[2] as Hex) ?? { errorName: w.errorName };
    return { errorName: w.errorName, args: w.args as readonly unknown[] | undefined };
  } catch { /* not a session error */ }
  for (const abi of [bondingCurveAbi, discipleRouterAbi, launchpadAbi, tokenAbi, ozErrors, modesErrorsAbi] as const) {
    try { const r = decodeErrorResult({ abi: abi as never, data }); return { errorName: r.errorName, args: r.args as readonly unknown[] | undefined }; } catch { /* next */ }
  }
  return null;
}

/** Revert names meaning "price moved past minOut" (curve, router, v4, session policy): retried once with a fresh quote. */
export const MINOUT_RETRY = /^(Slippage|MinOutTooLow|V4TooLittleReceived|V4TooMuchRequested)$/;

/** Launch-buy cap copy; pct = the cap in % of supply when the caller knows it. */
export const CREATOR_BUY_MSG = (pct?: number) => `Your launch buy is over the max for this rocket${pct ? ` (${pct}% of supply)` : ""}. Try a smaller amount.`;
/** ProtocolError.extra for an unclear relay Timeout (FLOW #141 RelayUnclearInfo shape). */
const unclearExtra = (p: PendingSend) => ({ unclear: true as const, reason: p.reason, ...(p.userOpHash ? { userOpHash: p.userOpHash } : {}), ...(p.txHash ? { txHash: p.txHash } : {}), ...(p.relayNonce !== undefined ? { relayNonce: p.relayNonce } : {}) });
const pickIds = (x?: Record<string, unknown>) => ({ userOpHash: x?.userOpHash, txHash: x?.txHash });
/**
 * `rid` = the press (reservation) id on the trade path. Any AA / relay "Timeout" whose outcome is unknown (today's
 * plain mav2 timeout, or FLOW #141's `extra.unclear` on AAError / ProtocolError.extra) is code "pending_unknown", never
 * a definite failure, with the op ids that are known. With a press, sendTrade / trade() normally map it first and start
 * the watcher (hold kept); without one (launch) there is no hold or watcher, just the code + PENDING_MSG copy. Only a
 * definite relay answer (a pre-send revert payload, no unclear flag: nothing was sent) keeps a definite code.
 */
export function friendlyError(e: unknown, rid?: string): ProtocolError {
  let name: string | undefined, args: unknown[] | undefined;
  if (e instanceof ProtocolError && e.code === "pending_unknown") return e;   // already mapped (playerError re-maps)
  // duck-typed as well as instanceof: AAError can arrive from a second module instance (tests, split chunks)
  const isAA = e instanceof AAError || (e as { constructor?: { name?: string } })?.constructor?.name === "AAError";
  let relayRevert: Hex | undefined;
  if ((e as { code?: unknown })?.code === "Timeout" && (isAA || e instanceof ProtocolError || (!!e && typeof e === "object" && "extra" in e))) {
    const ex = (e as { extra?: Record<string, unknown> }).extra ?? {};
    // definite (same test as lib/aa/relayOp unknownOpOf): decoded below
    if (ex.unclear !== true && ex.revert !== undefined && ex.revert !== null) relayRevert = (typeof ex.revert === "string" ? ex.revert : "0x") as Hex;
    else {
      const p: PendingSend = pendingOpOf(e) ?? {};   // a ProtocolError("Timeout") with no extra: unknown, no ids
      const op: PendingOpRef = { ...(rid ? { reservationId: rid } : {}), userOpHash: p.userOpHash, txHash: p.txHash, nonce: p.nonce, ...(p.relayNonce !== undefined ? { relayNonce: p.relayNonce } : {}) };
      logTradeError(p.unclear ? `trade pending (unclear relay outcome: ${p.reason})` : "trade pending (outcome unknown)", {
        id: rid, reason: p.reason, message: ((e as Error)?.message ?? "").slice(0, 300), userOpHash: op.userOpHash, txHash: op.txHash, relayNonce: op.relayNonce, nonce: op.nonce?.toString() });
      return new ProtocolError("pending_unknown", rid ? PENDING_UNKNOWN_MSG : PENDING_MSG, { op, ...(p.unclear ? { extra: unclearExtra(p) } : {}) });
    }
  }
  if (relayRevert) {
    const d = relayRevert.length >= 10 ? decodeRevert(relayRevert) : null;
    if (d) { name = d.errorName; args = d.args as unknown[] | undefined; }
    else { logTradeError("trade pre-check failed (relay)", { selector: relayRevert.slice(0, 10), revertData: relayRevert }); return new ProtocolError("Estimate", REJECTED_MSG); }
  }
  // rapid-tap spec #10 / #9: typed codes + plain placeholder copy (detail already logged by lib/aa)
  if (isAA && (e as AAError).code === "RateLimited") return new ProtocolError("rate_limited", SLOW_DOWN_MSG, { retryAfterMs: (e as AAError).extra?.retryAfterMs as number | undefined });
  if (isAA && (e as AAError).code === "Policy" && (e as AAError).extra?.spendLimit) return new ProtocolError("spend_limit", SPEND_LIMIT_MSG);
  const est = isAA && (e as AAError).code === "Estimate" ? (e as AAError) : null;
  const rv = isAA && (e as AAError).code === "Reverted" ? (e as AAError) : null;
  if (est || rv) {
    const raw = (est ?? rv)!.extra?.revertData as Hex | undefined;
    const d = decodeRevert(raw);
    if (d) { name = d.errorName; args = d.args as unknown[] | undefined; }
    // Pre-send check failed with no friendly mapping (approved by lee 2026-10-24): players see the plain line; the raw
    // "simulation failed: …" text and the selector go to the console (AAError keeps message + extra for retry logic)
    else if (est) {
      logTradeError("trade pre-check failed", { message: est.message, ...(raw && raw.length >= 10 ? { selector: raw.slice(0, 10), revertData: raw } : {}) });
      return new ProtocolError("Estimate", REJECTED_MSG);
    }
    // Reverted: players see the plain line only; the unknown selector goes to the console (never hex in copy)
    else { if (raw && raw.length >= 10) logTradeError("trade reverted (unknown reason)", { selector: raw.slice(0, 10), revertData: raw, ...pickIds(rv!.extra) }); return new ProtocolError("Reverted", rv!.message); }
  }
  if (!name && e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    name = rev?.data?.errorName;
    args = rev?.data?.args as unknown[] | undefined;
  }
  {
    const M: Record<string, string> = {
      QuoteRejected: "That pair token can't be used. Pick another quote token.",   // token address → console (below)
      DefaultQuoteUnset: "Launches are paused: the default pair isn't configured yet.",
      PricerUnset: "Launches are paused: the quote price feed isn't configured yet.",
      NoPricePool: "That pair has no USD price pool registered, so it can't be used yet.",
      TaxTooHigh: `Creator tax must be ≤ ${CURVE.creatorTaxMaxPct}%.`,
      InvalidMetadata: "Name, call sign and image are required.",
      CreatorBuyTooLarge: CREATOR_BUY_MSG(),
      Slippage: "Price moved too much. Try again or raise slippage.",
      Expired: "The trade took too long and expired. Try again.",
      WalletCap: "Wallet cap reached: one wallet can hold at most 7% before orbit.",
      Graduated: "This rocket has graduated, so trading moved to its pool.",
      NotGraduated: "This rocket is still on the curve.",
      InsufficientLiquidity: "Not enough left on the curve for that size.",
      ZeroAmount: "Amount is too small.",
      ZeroRecipient: "Missing recipient wallet.",
      // v4 bonding modes (Constants.MODE_*: 0 TRENCH WARFARE, 1 PVE, 2 PVP)
      NotVerified: "PVE rocket: this wallet needs a verified login first (email, Google or X).",
      BuyTooLarge: "That buy is above this rocket's per-buy cap right now. Try a smaller shot.",
      SellTooLarge: "That sell is above this PVE rocket's per-sell cap (0.5% of supply). Sell in smaller chunks.",
      LaunchBlock: "PVE rocket just launched: buys open from the next block.",
      PriceImpactTooHigh: "Price impact too high for the router cap. Try a smaller shot.",
      LoginGateUnset: "PVE launches are paused: the login gate isn't configured.",
      BadMode: "Unknown game mode.",
      ERC20InsufficientBalance: "Not enough balance for that shot size — deposit more or pick a smaller ammo.",
      SpendCapExceeded: SPEND_LIMIT_MSG,   // code "spend_limit" (below); copy pending lee + BRAND
      MinOutTooLow: "Price moved past your one-tap max slippage. Try again or raise slippage.",
      QuoteFailed: NO_PRICE_MSG,   // approved by lee 2026-10-24; the target address goes to the console (below)
      SessionInactive: "One-tap session isn't active any more — retrying with your wallet.",
      SessionExpired: "One-tap session expired — retrying with your wallet.",
      ERC20InsufficientAllowance: "Approval too small for that shot size.",
      V4TooLittleReceived: "Price moved too much. Try again or raise slippage.",
      V4TooMuchRequested: "Price moved too much. Try again or raise slippage.",
      // raw reasons ("AA23 reverted", revert strings) → console only (below)
      FailedOp: REJECTED_MSG,
      Error: REJECTED_MSG,
    };
    const pre = "";   // the decoded reason is the message; no "simulation:" prefix (FLOW 2)
    if (name === "QuoteFailed") logTradeError("quote failed", { target: args?.[0] });
    if (name && (name === "QuoteRejected" || name === "FailedOp" || name === "Error" || !M[name])) logTradeError(M[name] ? `trade failed (${name})` : "trade failed (unmapped error)", { name, args: args?.map(String) });
    // unmapped contract error names never reach players
    if (name === "SpendCapExceeded") return new ProtocolError("spend_limit", SPEND_LIMIT_MSG);
    if (name) return new ProtocolError(name, pre + (M[name] || REJECTED_MSG));
  }
  const code = (e as { code?: string })?.code;
  const msg = (e as Error)?.message || String(e);
  // relay / RPC transport errors ("eth_sendUserOperation: …") and unplain timeouts: plain line, raw text to console
  if (isAA && code === "Bundler") { logTradeError("trade failed (send error)", { message: msg.slice(0, 300), rpcError: (e as AAError).extra?.rpcError }); return new ProtocolError("Bundler", REJECTED_MSG); }
  // a raw pre-send failure that arrived as a plain error (not an AAError "Estimate"): same plain line, detail to console
  if (/simulation failed|execution reverted in simulation/i.test(msg)) {
    logTradeError("trade pre-check failed", { message: msg.split("\n")[0].slice(0, 300), code });
    return new ProtocolError(typeof code === "string" ? code : "Estimate", REJECTED_MSG);
  }
  return new ProtocolError(typeof code === "string" ? code : "Unknown", plainText(msg, "trade error", { code }));
}

/**
 * App-wide public client. Its state reads are pinned to our last receipt's block for ~3 s after our own trade
 * (lib/trade/readFloor): the public RPC can lag the sequencer by ~0.7 s, and a "latest" read in that gap would return
 * pre-trade quotes / balances. Outside that window it is a plain http() client.
 */
export function publicClient(): PublicClient {
  return createPublicClient({ chain: ACTIVE_CHAIN, transport: flooredTransport(http()) }) as PublicClient;
}

/* ---------------- reads ---------------- */

/**
 * Live market for a coin — THE mcap (lib/mcap.ts readCoinMcap: curve.marketCapQuote() × the launch quote price, the coin's
 * own supply), pre- and post-grad, so the header, cards, HUD self-heal, quotes and portfolio match the chart/fills.
 * Returns null when the read fails (callers fall back to the curve).
 */
export async function readMarket(pc: PublicClient, token: Address): Promise<{ priceWad: bigint; mcapUsd: number; priceUsd: number; graduated: boolean } | null> {
  try {
    const m = await readCoinMcap(pc, token, await curveOf(pc, token));
    return { priceWad: m.priceWad, mcapUsd: m.mcapUsd, priceUsd: m.priceUsd, graduated: m.graduated };
  } catch { return null; }
}

const paramsCache = new Map<string, CurveParams>();
export async function curveParams(pc: PublicClient, curve: Address): Promise<CurveParams> {
  const hit = paramsCache.get(curve);
  if (hit) return hit;
  const [totalSupply, sCurve, x0, y0] = await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "curveParams" });
  const p = { totalSupply, sCurve, x0, y0 };
  paramsCache.set(curve, p);
  return p;
}

const decCache = new Map<string, number>();
/** ERC-20 decimals, cached. USDG mainnet = 6, STRATEGY = 18, testnet mUSDG = 18. */
export async function decimalsOf(pc: PublicClient, erc20: Address): Promise<number> {
  const known = knownDecimals(erc20); if (known !== undefined) return known;   // USDG / STRATEGY from config, no RPC
  const k = erc20.toLowerCase();
  const hit = decCache.get(k);
  if (hit !== undefined) return hit;
  const d = Number(await pc.readContract({ address: erc20, abi: tokenAbi, functionName: "decimals" }));
  decCache.set(k, d);
  return d;
}

const curveCache = new Map<string, Address>();
export async function curveOf(pc: PublicClient, token: Address): Promise<Address> {
  return COIN.get(ckey("curve", token), () => curveOfLive(pc, token)) as Promise<Address>;
}
async function curveOfLive(pc: PublicClient, token: Address): Promise<Address> {
  const hit = curveCache.get(token.toLowerCase());
  if (hit) return hit;
  const c = await pc.readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "curveOf", args: [token] });
  if (c === ZERO_ADDRESS) throw new ProtocolError("NotLaunched", "Not a DISCIPLE rocket.");
  curveCache.set(token.toLowerCase(), c);
  return c;
}

function nextTierOf(mcap: number) {
  const t = TIERS.find((x) => x.lo > mcap);
  return t ? { name: t.name, mcapUsd: t.lo } : null;
}

export async function readCurveState(pc: PublicClient, token: Address): Promise<CurveState> {
  const curve = await curveOf(pc, token);
  const c = { address: curve, abi: bondingCurveAbi } as const;
  const [quote, graduated, quoteReserve, tokensSold, mcapWad, taxBps, p, progress, snipe] = await Promise.all([
    pc.readContract({ ...c, functionName: "quote" }),
    pc.readContract({ ...c, functionName: "graduated" }),
    pc.readContract({ ...c, functionName: "quoteReserve" }),
    pc.readContract({ ...c, functionName: "tokensSold" }),
    pc.readContract({ ...c, functionName: "marketCapUsd" }),
    pc.readContract({ ...c, functionName: "creatorTaxBps" }),
    curveParams(pc, curve),
    pc.readContract({ ...c, functionName: "progressBps" }),
    pc.readContract({ ...c, functionName: "currentSnipeFeeBps" }),
  ]);
  const quoteDecimals = await decimalsOf(pc, quote);
  const live = await readMarket(pc, token);   // THE mcap (lib/mcap.ts); marketCapUsd only if that read fails
  const mcapUsd = live ? live.mcapUsd : wadToNum(mcapWad);
  const soldPct = (Number(tokensSold) / Number(p.totalSupply)) * 100;
  const progressBps = Number(progress);
  return {
    token, quote, mcapUsd,
    // $ per token = mcap / supply. NOT spotPriceWad × quotePriceUsd: spotPriceWad (quote raw × 1e18 / token raw) is
    // floored on-chain to a single-digit integer at 6-dec USDG (FLOW #115); marketCapUsd is full precision.
    priceUsd: mcapUsd / (Number(p.totalSupply) / 1e18),
    soldPct,
    curveProgressPct: graduated ? 100 : progressBps / 100,
    progressBps: graduated ? 10000 : progressBps,
    snipeFeeBps: Number(snipe),
    quoteDecimals,
    nextTier: nextTierOf(mcapUsd),
    graduated, reserveQuote: quoteReserve, reserveToken: p.sCurve - tokensSold, tokensSold,
    creatorTaxBps: Number(taxBps),
    startMcap: CURVE.startMcap, graduationMcap: CURVE.graduationMcap,
  };
}

/** Curve, graduated, quote token + decimals — cached (graduated=false re-read after 5 s; graduation is one-way). */
export type CoinFacts = { curve: Address; graduated: boolean; quote: Address; quoteDecimals: number; /** Constants.MODE_*: 0 TRENCH, 1 PVE, 2 PVP (v4; pre-v4 curves ⇒ 0) */ mode: number };
export const MODE = { TRENCH: 0, PVE: 1, PVP: 2 } as const;
export async function coinFacts(pc: PublicClient, token: Address): Promise<CoinFacts> {
  const kk = ckey("facts", token);
  const cached = COIN.fresh(kk) as (CoinFacts & { at: number }) | undefined;
  if (cached && (cached.graduated || Date.now() - cached.at < 5000)) return cached;
  const curve = await curveOf(pc, token);
  const c = { address: curve, abi: bondingCurveAbi } as const;
  const [graduated, quote, mode] = await Promise.all([
    pc.readContract({ ...c, functionName: "graduated" }), pc.readContract({ ...c, functionName: "quote" }),
    (COIN.get(ckey("mode", curve), () => pc.readContract({ ...c, functionName: "mode" }).then(Number).catch(() => 0)) as Promise<number>),
  ]);
  const v = { curve, graduated, quote, quoteDecimals: await decimalsOf(pc, quote), mode, at: Date.now() };
  COIN.set(kk, v); return v;
}

/** Trader the curve evaluates mode rules for (PVE login/caps/profit tax, PVP caps): the connected account by default. */
const quoteTrader = (t?: Address | null) => t ?? connectedAddress() ?? null;
/** Decoded custom-error name of a revert. Duck-typed down the cause chain (an instanceof check misses when viem is
 * loaded twice, e.g. CJS + ESM copies in a bundle/test runner). */
const revertName = (e: unknown): string | undefined => {
  for (let x = e as { data?: { errorName?: unknown }; cause?: unknown } | undefined, i = 0; x && i < 10; x = x.cause as typeof x, i++) {
    const n = x.data?.errorName; if (typeof n === "string") return n;
  }
  return undefined;
};

/**
 * Curve quotes. TRENCH: quoteBuy/quoteSell (no per-trader rules). PVE/PVP: quoteBuyFor/quoteSellFor(trader) — they
 * enforce the mode caps exactly like the trade and (PVE sells) DEDUCT THE PROFIT TAX, so minOut from quoteSell would
 * be too high and the sell would revert with Slippage. A not-yet-verified PVE buyer (attest lands in the same batch)
 * falls back to the plain quote.
 */
async function curveBuyQuote(pc: PublicClient, curve: Address, mode: number, quoteIn: bigint, trader?: Address | null) {
  const c = { address: curve, abi: bondingCurveAbi } as const;
  const who = mode === MODE.TRENCH ? null : quoteTrader(trader);
  if (who) {
    try { return await pc.readContract({ ...c, functionName: "quoteBuyFor", args: [who, quoteIn] }); }
    catch (e) { if (revertName(e) !== "NotVerified") throw e; }
  }
  return pc.readContract({ ...c, functionName: "quoteBuy", args: [quoteIn] });
}
async function curveSellQuote(pc: PublicClient, curve: Address, mode: number, tokensIn: bigint, trader?: Address | null) {
  const c = { address: curve, abi: bondingCurveAbi } as const;
  const who = mode === MODE.PVE ? quoteTrader(trader) : null;
  return who ? pc.readContract({ ...c, functionName: "quoteSellFor", args: [who, tokensIn] }) : pc.readContract({ ...c, functionName: "quoteSell", args: [tokensIn] });
}

/** amountOut for (token, side, amountIn): the background-warmed value if ≤ maxAge ms old, else a live quote. */
export async function quoteOut(pc: PublicClient, token: Address, side: "buy" | "sell", amountIn: bigint, maxAge = 1500): Promise<bigint> {
  const k = ckey(token, side, amountIn), lk = ckey(token, side);
  const read = async () => ({ amountOut: await readAmountOut(pc, token, side, amountIn) });
  REQUOTE.remember(k, read, { lk, amountIn });
  const exact = QUOTES.fresh(k, maxAge); if (exact) return exact.amountOut;
  const sc = scaledQuote(LAST_QUOTE.get(lk), amountIn, maxAge); if (sc !== undefined) return sc; // e.g. sell % after balance shrank
  return (await QUOTES.get(k, read, maxAge)).amountOut;
}
/**
 * PVE/PVP pre-grad quote for one trader (latency plan #5): was a live eth_call on every tap. Exact (trader, side,
 * amount) key, ≤ maxAge (1.5 s) old, never down-scaled; warmed by warmQuote for the connected trader, re-read right
 * after our own trade. The contract still enforces minOut (= quote − slippage) on-chain.
 */
export async function traderQuote(pc: PublicClient, token: Address, side: "buy" | "sell", amountIn: bigint, trader?: Address | null, maxAge = 1500): Promise<bigint> {
  const who = quoteTrader(trader);
  const k = ckey("pvq", token, side, who ?? "-", amountIn);
  const read = async () => ({ amountOut: await readAmountOut(pc, token, side, amountIn, who) });
  REQUOTE.remember(k, read, undefined, TRADER_QUOTES);
  return (await TRADER_QUOTES.get(k, read, maxAge)).amountOut;
}
/** amountOut only — ONE eth_call (router quoteExactIn post-grad, curve quoteBuy/quoteSell pre-grad); readQuote also
 * reads the lens for the mcap preview, which a trade doesn't need. */
export async function readAmountOut(pc: PublicClient, token: Address, side: "buy" | "sell", amountIn: bigint, trader?: Address | null): Promise<bigint> {
  const { curve, graduated, mode } = await coinFacts(pc, token);
  if (graduated) {
    const { result } = await pc.simulateContract({ address: deployment().router, abi: discipleRouterAbi, functionName: "quoteExactIn", args: [token, side === "buy", amountIn] });
    return result[0];
  }
  return side === "buy" ? (await curveBuyQuote(pc, curve, mode, amountIn, trader)).tokensOut : (await curveSellQuote(pc, curve, mode, amountIn, trader)).quoteOut;
}
/**
 * After a trade lands, quotes on its route describe the pre-trade state. Latency plan #5: re-read the few quotes taps
 * actually use (presets, the last custom amounts, the trader quote) right away instead of wiping them all and making
 * the next tap pay a live read. Nothing from before the trade is served after it (lib/trade/hotCache Requoter).
 */
function requoteRoute(token: Address, logs?: ExecResult["logs"]) {
  // our receipt's block first: the re-reads below (and any balance read in the next ~3 s) are pinned to it, so a public
  // node that hasn't caught up retries briefly instead of answering with the pre-trade state
  READ_FLOOR.raise(receiptBlock(logs));
  const pre = [ckey(token), ckey("usdg", token), ckey("pvq", token)];
  REQUOTE.requote((k) => pre.some((p) => k.startsWith(p)), ["buy", "sell"].flatMap((sd) => [ckey(token, sd), ckey("usdg", token, sd)]));
}
/** amountIn for a $ shot: USDG mode buys spend USDG 1:1 ($1 = 1 USDG, config usdgDecimals); otherwise quote/coin via usdToAmountIn. */
/**
 * USDG router (#65) for this coin? Flag on — or the coin is USDG-quoted (then always, once the router supports it, so
 * no USDG approve ever goes to a curve: policy 1.3.0 rejects those). null ⇒ native quote path (today's deployment).
 */
export async function usdgRouteFor(pc: PublicClient, token: Address): Promise<Address | null> {
  if (!hasRouter()) return null;
  const ru = await routerUsdg(pc, deployment().router); if (!ru) return null;
  if (payUsdg()) return ru;
  const { quote } = await coinFacts(pc, token);
  return quote.toLowerCase() === ru.toLowerCase() ? ru : null;
}
export async function shotAmountIn(pc: PublicClient, token: Address, side: "buy" | "sell", usd: number): Promise<bigint> {
  if (side === "buy" && (await usdgRouteFor(pc, token))) return usdToUsdgRaw(usd);
  return usdToAmountIn(pc, token, side, usd);
}
/** Warm the quote a tap will need (USDG route: the router's end-to-end quoteUsdgRoute; else the native quote). */
export async function warmRoute(pc: PublicClient, token: Address, side: "buy" | "sell", amountIn: bigint) {
  if (amountIn <= B(0)) return;
  const r = deployment().router;
  if (await usdgRouteFor(pc, token)) { await usdgRouteQuote(pc, r, token, side === "buy", amountIn, 0, connectedAddress()); return; }
  return warmQuote(pc, token, side, amountIn);
}
export async function warmQuote(pc: PublicClient, token: Address, side: "buy" | "sell", amountIn: bigint) {
  if (amountIn <= B(0)) return;
  const k = ckey(token, side, amountIn), lk = ckey(token, side);
  REQUOTE.remember(k, async () => ({ amountOut: await readAmountOut(pc, token, side, amountIn) }), { lk, amountIn });
  const who = connectedAddress();
  const amountOut = await readAmountOut(pc, token, side, amountIn);   // trader = connected account (quoteTrader)
  QUOTES.set(k, { amountOut }); LAST_QUOTE.set(lk, { amountIn, amountOut, at: Date.now() });
  // PVE/PVP pre-grad: the same read IS the connected trader's quote ⇒ also serves traderQuote (no second read on tap)
  const { graduated, mode } = await coinFacts(pc, token);
  if (!graduated && mode !== MODE.TRENCH && who && who === connectedAddress()) {
    const tk = ckey("pvq", token, side, who, amountIn);
    TRADER_QUOTES.set(tk, { amountOut });
    REQUOTE.remember(tk, async () => ({ amountOut: await readAmountOut(pc, token, side, amountIn, who) }), undefined, TRADER_QUOTES);
  }
}

/** Exact preview for the current block. Curve views pre-grad, router eth_call post-grad. */
export async function readQuote(pc: PublicClient, token: Address, side: "buy" | "sell", amountIn: bigint): Promise<TradeQuote> {
  const { curve, graduated, quoteDecimals, mode } = await coinFacts(pc, token);
  const base = { side, amountIn, quoteDecimals, snipeFee: B(0), graduates: false, mode } as const;

  if (graduated) {
    if (!hasRouter()) throw new ProtocolError("NoRouter", "This rocket reached orbit; the router isn't configured on this network yet.");
    // Not a view (v4 has no view swaps): eth_call via simulateContract. Includes the hook's 1%.
    const { result: [amountOut, impactBps, mcapAfterUsd] } = await pc.simulateContract({
      address: deployment().router, abi: discipleRouterAbi, functionName: "quoteExactIn", args: [token, side === "buy", amountIn],
    });
    const bps = Number(impactBps) * (side === "buy" ? 1 : -1); // impactBps is unsigned; sign from side
    // v4 router: mcapAfterUsd = hook.mcapUsdFromSqrt at the live quote price; prefer the live lens × impact when available.
    const live = await readMarket(pc, token);
    const mcapAfter = live ? live.mcapUsd * (1 + bps / 10000) : wadToNum(mcapAfterUsd);
    return { ...base, amountOut, fee: B(0), impactBps: bps, impactPct: bps / 100, mcapAfterUsd: mcapAfter, venue: "router" };
  }

  if (side === "buy") {
    const q = await curveBuyQuote(pc, curve, mode, amountIn);
    const bps = Number(q.impactBps);
    return { ...base, amountOut: q.tokensOut, fee: q.fee, snipeFee: q.snipeFee, impactBps: bps, impactPct: bps / 100,
             mcapAfterUsd: wadToNum(q.mcapAfterUsd), graduates: q.graduates, venue: "curve" };
  }
  const q = await curveSellQuote(pc, curve, mode, amountIn);
  const bps = -Number(q.impactBps);
  return { ...base, amountOut: q.quoteOut, fee: q.fee, impactBps: bps, impactPct: bps / 100,
           mcapAfterUsd: wadToNum(q.mcapAfterUsd), profitTax: q.profitTax, venue: "curve" };
}

/** Launchpad.quoteCreatorBuy: preview the optional same-tx creator buy. quote = 0 ⇒ default quote. */
export async function readCreatorBuyQuote(pc: PublicClient, quote: Address, quoteIn: bigint, creatorTaxBps: number) {
  const [tokensOut, fee, snipeFee, quotePriceUsd, exceedsCap] = await pc.readContract({
    address: deployment().launchpad, abi: launchpadAbi, functionName: "quoteCreatorBuy", args: [quote, quoteIn, B(creatorTaxBps)],
  });
  return { tokensOut, fee, snipeFee, quotePriceUsd, exceedsCap };
}

/** On-chain creator-buy supply cap in bps (v3 default 77 = 0.77%). Prefer this over any hardcoded UI limit. */
export async function readCreatorBuyMaxBps(pc: PublicClient) {
  return Number(await pc.readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "creatorBuyMaxBps" }));
}

/**
 * Convert a $ shot into the raw amount to spend: quote raw for buys, token raw (18 dec) for sells,
 * using the curve's launch-fixed quotePriceUsd (USD WAD per 1e18 quote raw ⇒ decimal-agnostic).
 */
export async function usdToAmountIn(pc: PublicClient, token: Address, side: "buy" | "sell", usd: number): Promise<bigint> {
  const curve = await curveOf(pc, token);
  const c = { address: curve, abi: bondingCurveAbi } as const;
  const qp = await COIN.get(ckey("qp", curve), () => pc.readContract({ ...c, functionName: "quotePriceUsd" })) as bigint;   // launch-fixed
  const usdMicro = B(Math.max(1, Math.round(usd * 1e6)));
  if (side === "buy") return (usdMicro * B(1e18) * B(1e18)) / (qp * B(1e6));
  const [mcapWad, p] = await Promise.all([pc.readContract({ ...c, functionName: "mcapNow" }), curveParams(pc, curve)]);
  const live = await readMarket(pc, token);
  if (live?.graduated && live.mcapUsd > 0) return (usdMicro * p.totalSupply) / B(Math.round(live.mcapUsd * 1e6)); // tokens = usd / mcap × supply
  return mcapWad > B(0) ? (usdMicro * B(1e12) * p.totalSupply) / mcapWad : B(0);
}

/**
 * Fill epochs per balance key: bumped whenever a fill is booked from receipt logs. A balanceOf read that started before
 * the fill and lands after it describes the pre-fill balance, so it is NOT cached (it would undo the booked fill and
 * let the next tap spend money that's gone). Reservations themselves never live in BALANCES (lib/trade/reservations).
 */
const BAL_EPOCH = new Map<string, number>();
const balEpoch = (k: string) => BAL_EPOCH.get(k) ?? 0;
export async function tokenBalance(pc: PublicClient, erc20: Address, owner: Address) {
  const k = ckey(erc20, owner), e0 = balEpoch(k);
  const b = await pc.readContract({ address: erc20, abi: tokenAbi, functionName: "balanceOf", args: [owner] });
  if (balEpoch(k) === e0) { BALANCES.set(k, b); return b; }
  return BALANCES.fresh(k, 60_000) ?? b;
}
/**
 * Apply a known delta (e.g. coin received, from the receipt logs) to the cached balance. Reading balanceOf right after
 * a sync receipt can hit an RPC node one block behind (0 after a first buy ⇒ "NO TOKENS IN WALLET" on the next sell).
 */
export function bumpBalance(erc20: Address, owner: Address, delta: bigint) {
  const k = ckey(erc20, owner), cur = BALANCES.fresh(k, 60_000);
  BAL_EPOCH.set(k, balEpoch(k) + 1);
  if (cur !== undefined) BALANCES.set(k, cur + delta > B(0) ? cur + delta : B(0)); else if (delta > B(0)) BALANCES.set(k, delta);
}
/** Balance hint ≤ maxAge ms old (polled / refreshed after trades), else a live read. */
export async function balanceHint(pc: PublicClient, erc20: Address, owner: Address, maxAge = 5000) {
  const k = ckey(erc20, owner), e0 = balEpoch(k);
  const v = await BALANCES.get(k, () => pc.readContract({ address: erc20, abi: tokenAbi, functionName: "balanceOf", args: [owner] }), maxAge, () => balEpoch(k) === e0);
  return balEpoch(k) === e0 ? v : BALANCES.fresh(k, 60_000) ?? v;   // a fill was booked meanwhile ⇒ the booked value
}
/** Live balanceOf for the pre-send check (hint was short); cached unless a fill was booked while it was in flight. */
async function liveBalance(pc: PublicClient, erc20: Address, owner: Address) { return tokenBalance(pc, erc20, owner); }

/* ---------------- client ---------------- */

export function createViemProtocol(): ProtocolClient {
  const pc = publicClient();

  /** Approval call if needed. Smart account: exact amount, batched into the same userOp. EOA: max once. */
  async function approveCall(owner: Address, erc20: Address, spender: Address, amt: bigint): Promise<Call[]> {
    const cur = await pc.readContract({ address: erc20, abi: tokenAbi, functionName: "allowance", args: [owner, spender] });
    if (cur >= amt) return [];
    return [{ to: erc20, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [spender, isSmartMode() ? amt : maxUint256] }) }];
  }
  /** Sum ERC-20 Transfer(to=recipient) of `asset` in the receipt logs. */
  function received(logs: ExecResult["logs"], asset: Address, recipient: Address) {
    let out = B(0);
    for (const l of logs) {
      if (l.address.toLowerCase() !== asset.toLowerCase()) continue;
      try { const ev = decodeEventLog({ abi: erc20Events, data: l.data, topics: l.topics as [Hex, ...Hex[]] }); if (ev.eventName === "Transfer" && ev.args.to.toLowerCase() === recipient.toLowerCase()) out += ev.args.value; } catch { /* not a transfer */ }
    }
    return out;
  }

  /** Sum ERC-20 Transfer(from=owner) of `asset` in the receipt logs. */
  function sent(logs: ExecResult["logs"], asset: Address, owner: Address) {
    let out = B(0);
    for (const l of logs) {
      if (l.address.toLowerCase() !== asset.toLowerCase()) continue;
      try { const ev = decodeEventLog({ abi: erc20Events, data: l.data, topics: l.topics as [Hex, ...Hex[]] }); if (ev.eventName === "Transfer" && ev.args.from.toLowerCase() === owner.toLowerCase()) out += ev.args.value; } catch { /* not a transfer */ }
    }
    return out;
  }
  /**
   * Book a fill from its receipt logs (no balanceOf right after the receipt: the public RPC can lag ~0.7 s).
   *  - spend asset: what the logs say actually left the account is subtracted (delta-based, so concurrent fills and
   *    polls compose; in-flight spend is held in lib/trade/reservations, never pre-subtracted here);
   *  - sell proceeds (quote / USDG) are added to the cached quote balance. Buys' coin side is booked by TradeBridge
   *    (bumpBalance(r.amountOut)) and lib/wallet noteReceipt (GAME #138) — not here, to avoid double counting.
   */
  function bookFill(logs: ExecResult["logs"], spend: Address, me: Address, amountIn: bigint, proceeds: Address | undefined, recipient: Address, out: bigint) {
    // rapid-tap: nothing is decremented before the send any more (pending spend lives in lib/trade/reservations), so the
    // receipt's own Transfer(from=me) is booked here (amountIn when the logs carry none: the op succeeded)
    const s = sent(logs, spend, me);
    bumpBalance(spend, me, -(s > B(0) ? s : amountIn));
    if (proceeds && out > B(0)) bumpBalance(proceeds, recipient, out);
  }

  /**
   * Referrer (from /r/<name>, lib/referral) → chain. Neither BondingCurve.buy nor DiscipleRouter.buyExactIn takes a
   * referrer arg: FeeRouter pays the trader's ReferralRegistry.referrerOf(trader). So on a buy we prepend
   * ReferralRegistry.tryAttribute(me, ref) once, only when nothing is pending/attributed (it reverts otherwise).
   * Opt-in via NEXT_PUBLIC_REFERRAL_ATTRIBUTE=1 until contracts confirm who may call tryAttribute.
   */
  async function referralCall(me: Address): Promise<{ to: Address; data: Hex }[]> {
    const reg = deployment().referralRegistry;
    const ref = referrerWallet(me);
    if (process.env.NEXT_PUBLIC_REFERRAL_ATTRIBUTE !== "1" || !ref || reg === ZERO_ADDR) return [];
    try {
      const [cur, pending] = await Promise.all([
        pc.readContract({ address: reg, abi: referralRegistryAbi, functionName: "referrerOf", args: [me] }),
        pc.readContract({ address: reg, abi: referralRegistryAbi, functionName: "pendingReferrer", args: [me] }),
      ]);
      if (cur !== ZERO_ADDR || pending !== ZERO_ADDR) return [];
      return [{ to: reg, data: encodeFunctionData({ abi: referralRegistryAbi, functionName: "tryAttribute", args: [me, ref] }) }];
    } catch { return []; }
  }

  const refDone = new Set<string>();
  /** referralCall, but once it resolved to "nothing to attribute" for this wallet it stays [] (no 2 reads per buy). */
  async function referralCallCached(me: Address) {
    if (refDone.has(me.toLowerCase())) return [];
    const r = await referralCall(me); if (!r.length) refDone.add(me.toLowerCase()); return r;
  }

  /**
   * FLOW 2: a min-out / slippage revert on a quote WE derived (minAmountOut 0) means the warm quote went stale between
   * quote and execution (busy curve, our own previous shot). Drop the cached quotes, re-quote and retry ONCE. A caller-
   * pinned minAmountOut is never retried (that is the user's explicit limit).
   */
  async function trade(side: "buy" | "sell", t: TradeParams): Promise<TradeResult> {
    const tt = startTradeTiming(side);   // console-only latency marks: `[disciple] trade timing`
    // rapid-tap: one reservation per press (GAME's press id, else ours), kept across the minOut retry, released on fill
    // (tradeOnce, right after the fill is booked) or here on error / timeout. release() is idempotent.
    const rid = t.reservationId || autoReservationId();
    // AUDIT: a press whose op is still unknown is never rebuilt or re-sent (same id ⇒ same press). Other presses go
    // through the normal reservation math (the unknown hold stays counted; each op has its own nonce key).
    if (RESERVATIONS.isUnknown(rid)) {
      const u = RESERVATIONS.get(rid)?.unknown;
      console.warn("[disciple] trade not re-sent: this press is still confirming", { id: rid, userOpHash: u?.userOpHash, nonce: u?.nonce?.toString() });
      tt.done("pending", { code: "pending_unknown", resend: false });
      throw new ProtocolError("pending_unknown", PENDING_UNKNOWN_MSG, { op: { reservationId: rid, userOpHash: u?.userOpHash, txHash: u?.txHash, nonce: u?.nonce } });
    }
    try {
      let r: TradeResult;
      try { r = await tradeOnce(side, t, rid, tt); }
      catch (e) {
        if (!(e instanceof ProtocolError) || t.minAmountOut > B(0) || !MINOUT_RETRY.test(e.code)) throw e;
        tt.note({ minOutRetry: true });
        requoteRoute(t.token);   // fresh quotes (the retry joins the re-read; nothing landed ⇒ no floor to raise)
        r = await tradeOnce(side, t, rid, tt);
      }
      tt.done("fill");
      RESERVATIONS.release(rid, "filled");
      return r;
    } catch (e0) {
      // any timeout still unmapped here (e.g. a #141 ProtocolError("Timeout") that skipped sendTrade) is unknown, never a
      // 'timeout' release: friendlyError maps it to pending_unknown (a definite relay revert keeps its definite code)
      const e = (e0 as { code?: unknown })?.code === "Timeout" ? friendlyError(e0, rid) : e0;
      // pending_unknown: the hold stays (the watcher releases it 'filled' / 'error'); not a failure
      if ((e as { code?: unknown })?.code === "pending_unknown") {
        const settle = (e0 as { extra?: { settleSession?: (landed: boolean) => void } }).extra?.settleSession;
        const dropBal = () => { BALANCES.dropWhere(() => true); };   // no receipt-log booking here: re-read balances
        // not marked by sendTrade ⇒ mark + watch now (never resends; 'resolved' event as usual)
        void holdLate(RESERVATIONS, rid, (e as ProtocolError).op,
          lazyWatchDeps(activeAddress().then((me) => chainWatchDeps(pc, me), () => null)),
          { book: () => { dropBal(); return undefined; }, landedUnbooked: dropBal, settle });
        tt.done("pending", { code: "pending_unknown" }); throw e;
      }
      // a definite error (incl. a revert with no unclear flag) releases the press as 'error'
      RESERVATIONS.release(rid, "error");
      tt.done("error", { code: (e as { code?: unknown }).code }); throw e;
    }
  }
  /**
   * Hold this trade's raw spend under `rid` BEFORE quoting (spec #6: an overlapping tap's quote sees it) and return what
   * the other pending trades hold on the same route (marginal-quote base) and of the same asset (cash / holdings check).
   * Synchronous: nothing awaits between the reservation and the quote call that reads it.
   */
  function holdSpend(rid: string, side: "buy" | "sell", token: Address, asset: Address, amountIn: bigint, route: string) {
    const usdg = deployment().usdg;
    const r = RESERVATIONS.reserve(rid, { side: side === "buy" ? "boost" : "dump", coin: token, spend: { asset, raw: amountIn, route } });
    const spendsUsdg = asset.toLowerCase() === usdg.toLowerCase();
    const ownGas = spendsUsdg ? r.gasReserve ?? B(0) : B(0);
    return {
      routePending: RESERVATIONS.routePending(route, rid),
      others: () => RESERVATIONS.reservedRaw(asset, { exceptId: rid, usdg }),
      need: amountIn + ownGas,
      /** gas cap held from CASH when the spend isn't USDG (a DUMP of a coin): checked by dumpGasCheck, not against tokens */
      cashGas: spendsUsdg ? B(0) : r.gasReserve ?? B(0),
    };
  }
  /**
   * A DUMP's gas cap is held from cash (USDG), not from tokens: refuse before sending only when that cash is held by
   * other trades in flight (same rule + copy as the BOOST cash check). Resolves to the refusal (never rejects), so it
   * can start alongside the hot-path reads and be awaited at the pre-send check.
   */
  function dumpGasCheck(rid: string, cashGas: bigint, me: Address): Promise<ProtocolError | null> {
    if (cashGas <= B(0)) return Promise.resolve(null);
    const usdg = deployment().usdg;
    const others = () => RESERVATIONS.reservedRaw(usdg, { exceptId: rid, usdg });
    return (async () => {
      if (spendable(await balanceHint(pc, usdg, me), others()) >= cashGas) return null;
      const live = await liveBalance(pc, usdg, me);
      if (live >= cashGas && spendable(live, others()) < cashGas) {
        console.warn("[disciple] trade refused: cash for the dump's gas is held by trades in flight", { have: String(live), held: String(others()), gas: String(cashGas), inFlight: RESERVATIONS.count() });
        return new ProtocolError("InsufficientBalance", heldMsg(true));
      }
      return null;   // short of cash outright: unchanged (the paymaster / relay answers as before)
    })().catch(() => null);
  }
  /** Copy for a spend that only fails because other pending trades hold the money (plain words, no ids). */
  function heldMsg(isCash: boolean, amountUsd?: number) {
    const n = Math.max(0, RESERVATIONS.count() - 1);
    return isCash
      ? `Not enough cash${amountUsd !== undefined ? ` for $${amountUsd.toFixed(2)}` : ""} while ${n === 1 ? "your other trade finishes" : "your other trades finish"}. Try again in a moment.`
      : `Not enough tokens while ${n === 1 ? "your other trade finishes" : "your other trades finish"}. Try again in a moment.`;
  }
  /**
   * Send the trade's op (press id → pressId) and book it. AUDIT: a receipt / relay timeout ⇒ ProtocolError
   * "pending_unknown" (not a failure): the reservation stays held and the op is watched in the background
   * (lib/trade/pendingOps); when it lands its fill is booked from the receipt logs exactly like a normal fill.
   */
  async function sendTrade(rid: string, calls: Call[], me: Address, token: Address, tt: TradeTiming | undefined, book: (logs: ExecResult["logs"]) => bigint): Promise<{ txHash: string; amountOut: bigint }> {
    let logs: ExecResult["logs"] | undefined;
    try {
      let r: ExecResult;
      try { r = await asTrade(tt, () => execCalls(calls), { pressId: rid }); }
      catch (e) {
        // plain timeout (today's mav2) or FLOW #141's unclear relay timeout (receipt-timeout / stream-lost / network):
        // hold kept, watcher started (2 min cap, never resends). A definite revert (no unclear flag) ⇒ null ⇒ rethrown.
        const settle = (e as { extra?: { settleSession?: (landed: boolean) => void } }).extra?.settleSession;
        const pending = startPendingOp(RESERVATIONS, rid, e, (sender) => chainWatchDeps(pc, (sender as Address | undefined) ?? me), {
          book: (l: OpLanding) => book(l.logs as ExecResult["logs"]),
          landedUnbooked: () => { BALANCES.dropWhere((k) => k.endsWith(`|${me.toLowerCase()}`)); },
          settle, after: (l) => requoteRoute(token, l?.logs as ExecResult["logs"] | undefined),
        });
        if (!pending) throw e;
        throw new ProtocolError("pending_unknown", PENDING_UNKNOWN_MSG, { op: pending.op, ...(pending.unclear ? { extra: unclearExtra(pending.unclear) } : {}) });
      }
      logs = r.logs;
      const amountOut = book(r.logs);
      RESERVATIONS.release(rid, "filled");   // same tick as the booked fill: never counted twice, never dropped early
      return { txHash: r.txHash, amountOut };
    } finally { requoteRoute(token, logs); }
  }
  async function tradeOnce(side: "buy" | "sell", t: TradeParams, rid: string, tt?: TradeTiming): Promise<TradeResult> {
    if (!isDeployed()) throw new ProtocolError("NotDeployed", "Contracts not deployed on this chain yet.");
    try {
      // Hot path: coin facts cached, quote/balance/referral/allowance in PARALLEL (warm tap ⇒ all cache hits, 0 RPCs).
      // USDG decimals read from the chain once (cached; reservations / cash checks convert with them), never assumed
      const [{ curve, graduated, quote: quoteAsset, mode }, me] = await Promise.all([coinFacts(pc, t.token), activeAddress(), readUsdgDecimals(pc).catch(() => undefined)]);
      const recipient = t.recipient || me;
      const deadline = B(t.deadline || now() + 120);
      // v4 PVE: the curve checks LoginGate.verifiedUntil(trader) on buys (trader = token recipient; router: msg.sender).
      // USDG router (#65) when the flag is on — and ALWAYS for USDG-quoted coins once the router supports it, so we
      // never emit a USDG approve to a curve (policy 1.3.0 rejects those)
      const usdg = await usdgRouteFor(pc, t.token);
      if (usdg) return await tradeViaUsdg(side, t, { usdg, me, recipient, deadline, pve: !graduated && mode === MODE.PVE }, rid, tt);
      const pveCalls = side === "buy" && !graduated && mode === MODE.PVE ? await ensurePveLogin(pc, recipient) : [];
      const spendAsset = side === "buy" ? quoteAsset : t.token;
      const outAsset = side === "buy" ? t.token : quoteAsset;
      const smart = isSmartMode();
      const route = ckey("coin", t.token, side);
      const held = holdSpend(rid, side, t.token, spendAsset, t.amountIn, route);
      const gasCheck = dumpGasCheck(rid, held.cashGas, me);
      const [qOut, have, refCalls, approve] = await Promise.all([
        t.minAmountOut > B(0) ? Promise.resolve(B(0))
          // PVE/PVP curve: trader-specific quote (mode caps; PVE sells net of the profit tax), exact-key cache ≤ 1.5 s
          : !graduated && mode !== MODE.TRENCH ? marginalQuote(route, t.amountIn, (a, age) => traderQuote(pc, t.token, side, a, side === "buy" ? recipient : me, age), held.routePending)
          : marginalQuote(route, t.amountIn, (a, age) => quoteOut(pc, t.token, side, a, age), held.routePending),
        balanceHint(pc, spendAsset, me),
        side === "buy" ? referralCallCached(me) : Promise.resolve([]),
        smart ? Promise.resolve(null) : approveCall(me, spendAsset, graduated ? deployment().router : curve, t.amountIn),
      ]);
      const minOut = t.minAmountOut > B(0) ? t.minAmountOut : applySlippage(qOut, t.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
      let target: Address, data: Hex;
      if (graduated) {
        if (!hasRouter()) throw new ProtocolError("NoRouter", "This rocket reached orbit; the router isn't configured on this network yet.");
        target = deployment().router;
        data = encodeFunctionData({ abi: discipleRouterAbi, functionName: side === "buy" ? "buyExactIn" : "sellExactIn", args: [t.token, t.amountIn, minOut, recipient, deadline] });
      } else {
        target = curve;
        data = encodeFunctionData({ abi: bondingCurveAbi, functionName: side, args: [t.amountIn, minOut, deadline, recipient] });
      }
      // Preflight: an underfunded spend otherwise surfaces only as an opaque estimate failure / on-chain revert.
      // rapid-tap: what other pending trades hold of this asset is not spendable (no extra read: `have` is the hint).
      if (spendable(have, held.others()) < held.need) {
        const live = await liveBalance(pc, spendAsset, me);   // hint may be stale-low (only off the hot path: already short)
        if (live >= held.need && spendable(live, held.others()) < held.need) {
          console.warn("[disciple] trade refused: balance held by trades in flight", { have: String(live), held: String(held.others()), need: String(held.need), inFlight: RESERVATIONS.count() });
          throw new ProtocolError("InsufficientBalance", heldMsg(side === "buy"));
        }
        if (live < held.need) {
          const [sym, dec] = await Promise.all([
            pc.readContract({ address: spendAsset, abi: tokenAbi, functionName: "symbol" }).catch(() => "token"),
            decimalsOf(pc, spendAsset).catch(() => null),
          ]);
          throw new ProtocolError("InsufficientBalance", dec == null ? `not enough ${sym} for that shot size`
            : `not enough ${sym}: need ${fmtUnits(t.amountIn, dec)} have ${fmtUnits(live, dec)}`);
        }
      }
      { const g = await gasCheck; if (g) throw g; }
      // Smart account: exact approve batched into the same op, always (no allowance read on the hot path).
      const approveCalls = smart ? [{ to: spendAsset, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [target, t.amountIn] }) }] : (approve ?? []);
      const calls = [...pveCalls, ...refCalls, ...approveCalls, { to: target, data }];
      // no optimistic balance write: the displayed balance stays real; the pending spend is held in RESERVATIONS
      const r = await sendTrade(rid, calls, me, t.token, tt, (logs) => {
        const out = received(logs, outAsset, recipient);
        bookFill(logs, spendAsset, me, t.amountIn, side === "sell" ? outAsset : undefined, recipient, out);
        return out || minOut;
      });
      return { ok: true, txHash: r.txHash, amountOut: r.amountOut };
    } catch (e) {
      if (e instanceof ProtocolError) throw e;
      if (e instanceof PveError) throw new ProtocolError(e.code, e.message);
      throw friendlyError(e, rid);
    }
  }

  /**
   * Pay-in-USDG through DiscipleRouter (lib/trade/usdgRouter, #65): ONE userOp = [exact approve, buyWithUsdg|sellToUsdg].
   * t.amountIn is USDG on buys, coin on sells; minOut is end-to-end from quoteUsdgRoute − slippage (the caller clamps
   * slippage to the session max − 0.5% headroom). Pre- and post-grad alike (the router picks curve or v4 pool).
   * Recipient is pinned to the account on-chain, so t.recipient is ignored on this path.
   */
  async function tradeViaUsdg(side: "buy" | "sell", t: TradeParams, c: { usdg: Address; me: Address; recipient: Address; deadline: bigint; pve?: boolean }, rid: string, tt?: TradeTiming): Promise<TradeResult> {
    const router = deployment().router, isBuy = side === "buy";
    // Router path: the curve trades for msg.sender (the account) ⇒ PVE login is checked for `me`.
    const pveCalls = isBuy && c.pve ? await ensurePveLogin(pc, c.me) : [];
    // quoteUsdgRouteFor(me) reverts NotVerified until the attest is on-chain ⇒ this path needs the server relay.
    if (pveCalls.length) throw new ProtocolError("PveRelayUnavailable", "Couldn't record your PVE login right now — try again in a moment.");
    const spend = isBuy ? c.usdg : t.token, outAsset = isBuy ? t.token : c.usdg;
    const route = ckey("usdgroute", t.token, side);
    const held = holdSpend(rid, side, t.token, spend, t.amountIn, route);
    const gasCheck = dumpGasCheck(rid, held.cashGas, c.me);
    const [q, have] = await Promise.all([
      t.minAmountOut > B(0) ? Promise.resolve(B(0)) : marginalQuote(route, t.amountIn, (a, age) => usdgRouteQuote(pc, router, t.token, isBuy, a, age, c.me), held.routePending),
      balanceHint(pc, spend, c.me),
    ]);
    if (spendable(have, held.others()) < held.need) {
      const live = await liveBalance(pc, spend, c.me);   // hint may be stale-low (only when already short)
      if (live >= held.need && spendable(live, held.others()) < held.need) {
        console.warn("[disciple] trade refused: balance held by trades in flight", { have: String(live), held: String(held.others()), need: String(held.need), inFlight: RESERVATIONS.count() });
        throw new ProtocolError("InsufficientBalance", heldMsg(isBuy, isBuy ? usdgRawToUsd(t.amountIn) : undefined));
      }
      if (live < held.need) throw new ProtocolError("InsufficientBalance", isBuy
        ? `Not enough cash for $${usdgRawToUsd(t.amountIn).toFixed(2)}: you have $${usdgRawToUsd(live).toFixed(2)}. Pick a smaller amount or deposit more.`
        : `not enough tokens: need ${fmtUnits(t.amountIn, COIN_DECIMALS)} have ${fmtUnits(live, COIN_DECIMALS)}`);
    }
    const minOut = t.minAmountOut > B(0) ? t.minAmountOut : applySlippage(q, t.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
    if (minOut <= B(0)) throw new ProtocolError("ZeroQuote", "Route quote is zero — amount too small.");
    { const g = await gasCheck; if (g) throw g; }
    const calls: Call[] = isBuy
      ? [...pveCalls, ...(await referralCallCached(c.me)), ...toCalls(routerBuyWithUsdgCalls({ router, usdg: c.usdg, token: t.token, usdgIn: t.amountIn, minTokensOut: minOut, deadline: c.deadline }))]
      : toCalls(routerSellToUsdgCalls({ router, token: t.token, tokensIn: t.amountIn, minUsdgOut: minOut, deadline: c.deadline }));
    // no optimistic balance write (displayed balances stay real); the pending spend is held in RESERVATIONS
    const r = await sendTrade(rid, calls, c.me, t.token, tt, (logs) => {
      const out = received(logs, outAsset, c.me);
      bookFill(logs, spend, c.me, t.amountIn, isBuy ? undefined : outAsset, c.me, out);
      return out || minOut;
    });
    return { ok: true, txHash: r.txHash, amountOut: r.amountOut };
  }

  return {
    async launchCoin(lp: LaunchCoinParams): Promise<LaunchCoinResult> {
      if (!isDeployed()) throw new ProtocolError("NotDeployed", "Contracts not deployed on this chain yet.");
      const launchpad = deployment().launchpad;
      const creatorBuy = lp.creatorBuyQuoteIn ?? B(0);
      // Private launches go through AnonLauncher v2 (Launchpad.launch ⇒ TRENCH mode; it pulls the fee + First BOOST).
      const anonL = lp.private ? ANON_ADDONS[ACTIVE_CHAIN.id]?.anonLauncher : undefined;
      if (lp.private && !anonL) throw new ProtocolError("NotDeployed", "Private launches aren't available on this chain.");
      const mode = lp.private ? LaunchMode.TRENCH_WARFARE : lp.mode ?? DEFAULT_LAUNCH_MODE;
      const params = {
        name: lp.name, ticker: lp.ticker, imageURI: lp.imageUri,
        description: lp.description || "", socialsURI: lp.socials ? JSON.stringify(lp.socials) : "",
        quote: lp.quoteToken, // address(0) → Launchpad.defaultQuote (STRATEGY); priced on-chain by QuotePricer
        creatorTaxBps: B(Math.round(lp.creatorTaxPct * 100)),
        creatorBuyQuoteIn: creatorBuy,
        creatorBuyMinTokensOut: B(0), // filled from Launchpad.quoteCreatorBuy below
        deadline: B(now() + 300),
      };
      try {
        const me = await activeAddress();
        const calls: Call[] = [];
        if (creatorBuy > B(0)) {
          const [cq, launchpadCapBps] = await Promise.all([
            readCreatorBuyQuote(pc, lp.quoteToken, creatorBuy, Number(params.creatorTaxBps)), readCreatorBuyMaxBps(pc),
          ]);
          // Mode caps stack on top of creatorBuyMaxBps (PVE 0.25% per buy in its launch window); quoteCreatorBuy can't see them.
          const eff = effectiveCreatorBuyCapBps(launchpadCapBps, mode);
          if (cq.exceedsCap) {
            const pct = Math.min(launchpadCapBps, eff.bps, 700) / 100;   // 700 bps = the 7% wallet cap
            logTradeError("launch buy over cap", { launchpadCapBps, effectiveBps: eff.bps, by: eff.by });
            throw new ProtocolError("CreatorBuyTooLarge", CREATOR_BUY_MSG(pct > 0 ? pct : undefined));
          }
          if (eff.by === "mode" && cq.tokensOut > creatorBuyMaxTokens(eff.bps)) {
            throw new ProtocolError("BuyTooLarge", `${LAUNCH_MODE_NAME[mode]} launches allow at most ${eff.bps / 100}% of supply per buy. Lower the First BOOST.`);
          }
          // v4 PVE: the First BOOST is a curve buy by the creator ⇒ it needs a live GLOBAL LoginGate attestation.
          // ensurePveLogin (#99) gets one from /api/pve/attest (relayed on-chain) or prepends LoginGate.attest; it throws
          // a friendly PveError when the Privy login isn't verified.
          if (modesActive() && mode === LaunchMode.PVE) calls.unshift(...(await ensurePveLogin(pc, me)));
          params.creatorBuyMinTokensOut = applySlippage(cq.tokensOut, lp.slippageBps ?? DEFAULT_SLIPPAGE_BPS); // quote − 1%
          const q = lp.quoteToken !== ZERO_ADDRESS ? lp.quoteToken
            : await pc.readContract({ address: launchpad, abi: launchpadAbi, functionName: "defaultQuote" });
          // First BOOST: Launchpad pulls exactly creatorBuyQuoteIn (fees come out of it); check balance up front.
          const have = await pc.readContract({ address: q, abi: tokenAbi, functionName: "balanceOf", args: [me] });
          if (have < creatorBuy) throw new ProtocolError("InsufficientBalance", `Not enough balance for the First BOOST: need ${fmtUnits(creatorBuy, await decimalsOf(pc, q))}, have ${fmtUnits(have, await decimalsOf(pc, q))}.`);
          // Exact approve of creatorBuyQuoteIn (Launchpad pulls exactly that): no slack, never unlimited, and a leftover
          // larger allowance is set back down to the exact amount. Skipped only when it already equals creatorBuyQuoteIn.
          if (!anonL) {
            const cur = await pc.readContract({ address: q, abi: tokenAbi, functionName: "allowance", args: [me, launchpad] });
            if (cur !== creatorBuy) calls.push({ to: q, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [launchpad, creatorBuy] }) });
          }
        }
        if (anonL && lp.private) {
          // AnonLauncher pulls launchFee (feeToken = USDG) + creatorBuyQuoteIn (quote) from this account: exact approvals
          // (summed when the pair IS the fee token), then launchAnon(params, stealthOwner, buyRecipient = me, eph, viewTag).
          const [feeToken, fee] = await Promise.all([
            pc.readContract({ address: anonL, abi: anonLauncherAbi, functionName: "feeToken" }) as Promise<Address>,
            pc.readContract({ address: anonL, abi: anonLauncherAbi, functionName: "launchFee" }) as Promise<bigint>,
          ]);
          const q = lp.quoteToken !== ZERO_ADDRESS ? lp.quoteToken : await pc.readContract({ address: launchpad, abi: launchpadAbi, functionName: "defaultQuote" });
          const need = new Map<string, bigint>();
          if (fee > B(0)) need.set(feeToken.toLowerCase(), fee);
          if (creatorBuy > B(0)) need.set(q.toLowerCase(), (need.get(q.toLowerCase()) ?? B(0)) + creatorBuy);
          for (const [tok, amt] of Array.from(need.entries())) {
            const have = await pc.readContract({ address: tok as Address, abi: tokenAbi, functionName: "balanceOf", args: [me] });
            if (have < amt) throw new ProtocolError("InsufficientBalance", `Not enough ${tok.toLowerCase() === feeToken.toLowerCase() ? "USDG" : "balance"} for this private launch: need ${fmtUnits(amt, await decimalsOf(pc, tok as Address))}, have ${fmtUnits(have, await decimalsOf(pc, tok as Address))}.`);
            calls.push({ to: tok as Address, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [anonL, amt] }) });
          }
          const { stealthOwner, ephemeralPubKey, viewTag } = lp.private;
          calls.push({ to: anonL, data: encodeFunctionData({ abi: anonLauncherAbi, functionName: "launchAnon", args: [params, stealthOwner, me, ephemeralPubKey, viewTag] }) });
        } else {
          // launchCoin on the pre-modes ABI; launchWithMode(params, mode) for every launch on the modes (v4) ABI (lib/launchAbi.ts).
          calls.push({ to: launchpad, data: encodeLaunchCall(params, mode) });
        }
        const r = await execCalls(calls);
        let launched: LaunchCoinResult | null = null, qp = B(0), supply = 0;
        for (const l of r.logs) {
          if (l.address.toLowerCase() !== launchpad.toLowerCase()) continue;
          try {
            const ev = decodeEventLog({ abi: launchpadAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as { eventName: string; args: Record<string, unknown> };
            if (ev.eventName === "Launched") launched = { token: ev.args.token as Address, curve: ev.args.curve as Address, txHash: r.txHash };
            else if (ev.eventName === "QuotePriced") qp = ev.args.quotePriceUsd as bigint;
            else if (ev.eventName === "LaunchTierContext") supply = Number(ev.args.totalSupply as bigint) / 1e18;
          } catch { /* other event */ }
        }
        if (!launched) { logTradeError("launch had no Launched event", { txHash: r.txHash }); throw new ProtocolError("NoLaunchEvent", REJECTED_MSG); }
        // First BOOST: the curve's Trade event in the SAME tx (emitted before Launched). trader = msg.sender = the signed-in
        // smart account (the only signer allowed now, lib/wallet) ⇒ tokens land in the account the HUD/balances read.
        for (const l of r.logs) {
          if (l.address.toLowerCase() !== launched.curve.toLowerCase()) continue;
          try {
            const ev = decodeEventLog({ abi: bondingCurveAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as { eventName: string; args: Record<string, unknown> };
            if (ev.eventName !== "Trade" || !ev.args.isBuy) continue;
            const quoteIn = ev.args.quoteAmt as bigint, tokens = ev.args.tokenAmt as bigint;
            // private launch: the curve's trader is the AnonLauncher; it forwards the tokens to buyRecipient = this account
            const recipient = anonL ? me : (ev.args.trader as Address);
            launched.creatorBuy = { recipient, tokens, quoteIn, usd: quoteRawToUsd(quoteIn, qp) };
            seedCreatorBuyPosition(`disciple.pnl.${launched.token}`, Number(tokens) / 1e18, launched.creatorBuy.usd, supply || undefined);
            bumpBalance(launched.token, recipient, tokens);
          } catch { /* other event */ }
        }
        return launched;
      } catch (e) {
        if (e instanceof PveError) throw new ProtocolError(e.code, e.message);
        throw e instanceof ProtocolError ? e : friendlyError(e);
      }
    },
    buy: (t) => trade("buy", t),
    sell: (t) => trade("sell", t),
    quote: (token, side, amountIn) => readQuote(pc, token, side, amountIn),
    getCurveState: (token) => readCurveState(pc, token),
    async impactPct(token, side, usd) {
      return (await readQuote(pc, token, side, await usdToAmountIn(pc, token, side, usd))).impactPct;
    },
  };
}
