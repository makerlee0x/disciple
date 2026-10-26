/**
 * viem implementation of ProtocolClient against DISCIPLE FLOW PR #4 (flow/contracts-api).
 *  - No custody/vault: the Privy embedded wallet (lib/wallet.ts) signs every tx.
 *  - Approve once (max) per spender: curve pre-grad, DiscipleRouter post-grad, Launchpad for creator buys.
 *  - Previews come from on-chain views (quoteBuy/quoteSell) or router.quoteExactIn (eth_call) post-grad.
 *  - Quote decimals are read per token (USDG = 6, STRATEGY = 18); never assumed.
 */
import { routerUsdg, payUsdg, usdgRouteQuote, routerBuyWithUsdgCalls, routerSellToUsdgCalls, toCalls } from "./trade/usdgRouter";
import { COIN_DECIMALS, knownDecimals, usdgRawToUsd, usdToUsdgRaw } from "./usdg";
import { BALANCES, COIN, QUOTES, LAST_QUOTE, scaledQuote, addInflight, marginalQuote, key as ckey } from "./trade/hotCache";
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, decodeErrorResult, decodeEventLog, encodeFunctionData, http, maxUint256, parseAbi, type Hex, type PublicClient,
} from "viem";
import { anonLauncherAbi, bondingCurveAbi, discipleRouterAbi, launchpadAbi, tokenAbi } from "./abi";
import { readCoinMcap } from "./mcap";
import { fillBook, readAtOrAfter } from "./fillBook";
import { NETWORK_MSG, NO_PRICE_MSG, PENDING_MSG, REJECTED_MSG, isTransportError, logTradeError, plainText } from "./aa/relayOp";
import { lookupOp, pendingIds, watchPending } from "./trade/pendingWatch";
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
import type { RelayTimeoutExtra } from "./aa/relayTypes";
import { markGradBuy, newPressId, tagPress } from "./aa/fastPath";
import { holdInflightUntilSeen } from "./trade/queuePricing";
import { GradHint } from "./trade/gradHint";
import { readGradNeed, usdgBuyGraduates, type GradNeed } from "./trade/gradNeed";
export { readRouterMaxImpactBps, readGradNeed, type GradNeed } from "./trade/gradNeed";
const erc20Events = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

const B = BigInt;
const DEFAULT_SLIPPAGE_BPS = 100; // 1%
const now = () => Math.floor(Date.now() / 1000);
const wadToNum = (v: bigint) => Number(v) / 1e18;
/** USD value of `raw` quote units given quotePriceUsd (USD WAD per 1e18 raw units). */
export const quoteRawToUsd = (raw: bigint, quotePriceUsd: bigint) => Number((raw * quotePriceUsd) / B(1e18)) / 1e18;

const fmtUnits = (v: bigint, dec = 18) => { const d = Number(v) / 10 ** dec; return d >= 1e-4 || d === 0 ? d.toPrecision(4) : d.toExponential(2); };

export class ProtocolError extends Error {
  /**
   * Set ONLY for code "Timeout" on an UNCLEAR relay outcome (outcome UNKNOWN, the op may still land): RelayTimeoutExtra
   * { unclear: true, reason, userOpHash, sender, txHash?, relayNonce? (relayer EOA), nonce? (the op's EntryPoint nonce),
   * pressId? (#145 GAME reservation id) }.
   * Absent otherwise — not even an own `undefined` key (`declare`), so `"extra" in e` stays false for a plain Timeout.
   */
  declare extra?: RelayTimeoutExtra;
  /** Set (true) only on a "Reverted" error that ran out of gas (no revert reason, gas used ≈ the op's limit). */
  declare outOfGas?: true;
  constructor(public code: string, msg: string, o?: { extra?: RelayTimeoutExtra; outOfGas?: boolean }) {
    super(msg);
    if (o?.extra) this.extra = o.extra;
    if (o?.outOfGas) this.outOfGas = true;
  }
  /** Stable classification for UI copy (GAME); messages are unchanged. Getter ⇒ no own key on the error. */
  get kind(): TradeErrorKind { return tradeErrorKindOf(this.code, this.outOfGas === true); }
}

/**
 * Stable trade-failure classes (GAME owns the copy):
 *  - PRICE_IMPACT: DiscipleRouter PriceImpactTooHigh (the trade moves a hop past router.maxImpactBps — see
 *    readRouterMaxImpactBps in lib/trade/gradNeed).
 *  - MIN_OUT: the price moved past minOut — session policy MinOutTooLow (also when wrapped in PreExecHookReverted /
 *    FailedOpWithRevert), curve/router Slippage, v4 V4TooLittleReceived / V4TooMuchRequested (= MINOUT_RETRY).
 *  - OUT_OF_GAS: the op reverted with NO reason and used ≈ all its gas (isOutOfGas).
 *  - OTHER: everything else.
 */
export type TradeErrorKind = "PRICE_IMPACT" | "MIN_OUT" | "OUT_OF_GAS" | "OTHER";
export function tradeErrorKindOf(code: string, outOfGas = false): TradeErrorKind {
  if (outOfGas) return "OUT_OF_GAS";
  if (code === "PriceImpactTooHigh") return "PRICE_IMPACT";
  if (MINOUT_RETRY.test(code)) return "MIN_OUT";
  return "OTHER";
}
/** OOG percentage: actualGasUsed (verification + execution + EntryPoint's 10% unused-gas penalty) ≥ 95% of callGasLimit. */
export const OOG_USED_PCT = 95;
/** AAError("Reverted").extra of an out-of-gas op: no revert reason and actualGasUsed ≥ OOG_USED_PCT% of callGasLimit. */
export function isOutOfGas(extra?: Record<string, unknown> | null): boolean {
  if (!extra) return false;
  const rd = extra.revertData;
  if (typeof rd === "string" && rd !== "0x" && rd.length > 2) return false;
  try {
    const used = extra.actualGasUsed == null ? null : BigInt(extra.actualGasUsed as bigint);
    const lim = extra.callGasLimit == null ? null : BigInt(extra.callGasLimit as bigint);
    return used != null && lim != null && lim > B(0) && used * B(100) >= lim * B(OOG_USED_PCT);
  } catch { return false; }
}
/** Classify ANY trade error (ProtocolError from the trade API, or a raw AAError / viem error) without logging. */
export function tradeErrorKind(e: unknown): TradeErrorKind {
  if (e instanceof ProtocolError) return e.kind;
  const isAA = e instanceof AAError || (e as { constructor?: { name?: string } })?.constructor?.name === "AAError";
  if (isAA) {
    const a = e as AAError;
    const d = decodeRevert(a.extra?.revertData as Hex | undefined);
    if (d) return tradeErrorKindOf(d.errorName);
    return tradeErrorKindOf(a.code, a.code === "Reverted" && isOutOfGas(a.extra));
  }
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev?.data?.errorName) return tradeErrorKindOf(rev.data.errorName);
    const raw = (rev as { raw?: Hex } | null)?.raw;
    const d = decodeRevert(raw);
    if (d) return tradeErrorKindOf(d.errorName);
  }
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" ? tradeErrorKindOf(code) : "OTHER";
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
const pickIds = (x?: Record<string, unknown>) => ({ userOpHash: x?.userOpHash, txHash: x?.txHash });
const SENT = new WeakSet<object>();
/** The error is from an op that was sent (on-chain revert or unknown outcome); never auto-resend it. */
export const wasSent = (e: unknown) => typeof e === "object" && e !== null && SENT.has(e);
export const markSent = <T extends object>(e: T): T => { SENT.add(e); return e; };
const REVERTED = new WeakSet<object>();
/** The op EXECUTED on-chain and reverted (AAError "Reverted"): definitely nothing traded — unlike "Timeout" (may still land). */
export const wasReverted = (e: unknown) => typeof e === "object" && e !== null && REVERTED.has(e);
/** Block of a landed op's logs (bigint | hex | number), for releasing its in-flight amount once the RPC has seen it. */
const logsBlock = (logs: unknown): bigint | undefined => {
  for (const l of (Array.isArray(logs) ? logs : []) as { blockNumber?: unknown }[]) {
    const b = l?.blockNumber; try { if (b != null && b !== "") return BigInt(b as string | number | bigint); } catch { /* next */ }
  }
  return undefined;
};
/**
 * A trade's pre-send read (quote / balance / coin facts / policy check) failed on the network: viem "HTTP request failed."
 * / "took too long" / fetch errors were shown raw to players (lee, Oct 26). Nothing was sent (the AA layer turns any
 * post-send failure into "Timeout"). Plain line; raw text + url to the console. null = not a transport error.
 */
export function tradeNetworkError(e: unknown): ProtocolError | null {
  const isAA = e instanceof AAError || (e as { constructor?: { name?: string } })?.constructor?.name === "AAError";
  if (isAA || e instanceof ProtocolError || !isTransportError(e)) return null;
  logTradeError("trade failed before sending (network)", { name: (e as Error)?.name, message: String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300), url: (e as { url?: string })?.url });
  return new ProtocolError("Network", NETWORK_MSG);
}
export function friendlyError(e: unknown): ProtocolError {
  let name: string | undefined, args: unknown[] | undefined;
  // duck-typed as well as instanceof: AAError can arrive from a second module instance (tests, split chunks)
  const isAA = e instanceof AAError || (e as { constructor?: { name?: string } })?.constructor?.name === "AAError";
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
    else { if (raw && raw.length >= 10) logTradeError("trade reverted (unknown reason)", { selector: raw.slice(0, 10), revertData: raw, ...pickIds(rv!.extra) }); return new ProtocolError("Reverted", rv!.message, { outOfGas: isOutOfGas(rv!.extra) }); }
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
      SpendCapExceeded: "One-tap budget for this session is used up — this trade will be signed by your wallet instead. Try again.",
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
    if (name) return new ProtocolError(name, pre + (M[name] || REJECTED_MSG));
  }
  const code = (e as { code?: string })?.code;
  const msg = (e as Error)?.message || String(e);
  // #141: unclear relay outcome (receipt timeout / lost stream / network) only: keep userOpHash / txHash / relayNonce /
  // sender / nonce so the UI can watch the op. Any other Timeout (or code) gets NO extra. Player copy stays main's plain line.
  const ex = isAA && code === "Timeout" ? (e as AAError).extra : undefined;
  const extra = ex?.unclear === true ? (ex as RelayTimeoutExtra) : undefined;
  // relay / RPC transport errors ("eth_sendUserOperation: …") and unplain timeouts: plain line, raw text to console
  if (isAA && code === "Bundler") { logTradeError("trade failed (send error)", { message: msg.slice(0, 300), rpcError: (e as AAError).extra?.rpcError }); return new ProtocolError("Bundler", REJECTED_MSG); }
  if (isAA && code === "Timeout") {
    if (msg !== PENDING_MSG) logTradeError("trade pending", { message: msg.slice(0, 300), ...pickIds((e as AAError).extra) });
    if (extra) logTradeError(`trade pending (unclear relay outcome: ${extra.reason})`, { reason: extra.reason, userOpHash: extra.userOpHash, txHash: extra.txHash, relayNonce: extra.relayNonce, nonce: extra.nonce });
    return new ProtocolError("Timeout", PENDING_MSG, extra ? { extra } : undefined);
  }
  // a raw pre-send failure that arrived as a plain error (not an AAError "Estimate"): same plain line, detail to console
  if (/simulation failed|execution reverted in simulation/i.test(msg)) {
    logTradeError("trade pre-check failed", { message: msg.split("\n")[0].slice(0, 300), code });
    return new ProtocolError(typeof code === "string" ? code : "Estimate", REJECTED_MSG);
  }
  return new ProtocolError(typeof code === "string" ? code : "Unknown", plainText(msg, "trade error", { code }));
}

export function publicClient(): PublicClient {
  return createPublicClient({ chain: ACTIVE_CHAIN, transport: http() }) as PublicClient;
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
  const [[totalSupply, sCurve, x0, y0], tail] = await Promise.all([
    pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "curveParams" }),
    // steep curve #1 tail; pre-steep (pure CPAMM) curves don't have it → 0 = the old math exactly
    pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "curveTail" }).catch(() => BigInt(0)),
  ]);
  const p = { totalSupply, sCurve, x0, y0, tail };
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
  const q = await curveBuyQuoteRaw(pc, curve, mode, quoteIn, trader);
  GRAD.record(curve, quoteIn, q.graduates);   // every curve buy quote also answers "does this amount graduate?"
  return q;
}
async function curveBuyQuoteRaw(pc: PublicClient, curve: Address, mode: number, quoteIn: bigint, trader?: Address | null) {
  const c = { address: curve, abi: bondingCurveAbi } as const;
  const who = mode === MODE.TRENCH ? null : quoteTrader(trader);
  if (who) {
    try { return await pc.readContract({ ...c, functionName: "quoteBuyFor", args: [who, quoteIn] }); }
    catch (e) { if (revertName(e) !== "NotVerified") throw e; }
  }
  return pc.readContract({ ...c, functionName: "quoteBuy", args: [quoteIn] });
}
/** Graduating-buy hints (quote ≥ remaining to graduation), fed by every curve buy quote (lib/trade/gradHint). */
const GRAD = new GradHint();
/**
 * Pre-grad buy of `quoteIn` that may graduate the curve? Warm taps answer from GRAD (no RPC); else one quoteBuy.
 * true ⇒ the op is flagged (markGradBuy) so mav2 estimates its gas fresh (Migration + 16 floor bands ≈ 2.76M).
 * Unreadable ⇒ false (normal path, as before).
 */
async function buyMayGraduate(pc: PublicClient, curve: Address, mode: number, quoteIn: bigint, trader?: Address | null): Promise<boolean> {
  const k = GRAD.known(curve, quoteIn); if (k !== undefined) return k;
  try { return (await curveBuyQuote(pc, curve, mode, quoteIn, trader)).graduates; } catch { return false; }
}
async function curveSellQuote(pc: PublicClient, curve: Address, mode: number, tokensIn: bigint, trader?: Address | null) {
  const c = { address: curve, abi: bondingCurveAbi } as const;
  const who = mode === MODE.PVE ? quoteTrader(trader) : null;
  return who ? pc.readContract({ ...c, functionName: "quoteSellFor", args: [who, tokensIn] }) : pc.readContract({ ...c, functionName: "quoteSell", args: [tokensIn] });
}

/**
 * GAME: exact amount needed to graduate `token`'s curve right now — remaining tokens, quote input and USDG input
 * (through the active router; usdgIn null when the router can't route it). Read from the curve, cached 1.5 s.
 */
export async function readGradNeedForToken(pc: PublicClient, token: Address): Promise<GradNeed> {
  const curve = await curveOf(pc, token);
  const router = hasRouter() ? deployment().router : undefined;
  const usdg = router ? await routerUsdg(pc, router) : null;
  return readGradNeed(pc, curve, { router, usdg: usdg ?? undefined });
}

/**
 * amountOut for (token, side, amountIn): the background-warmed value if ≤ maxAge ms old, else a live quote.
 * exact = true (trade minOut): skip the linear down-scale of a bigger warmed quote (see usdgRouteQuote).
 */
export async function quoteOut(pc: PublicClient, token: Address, side: "buy" | "sell", amountIn: bigint, maxAge = 1500, exact = false): Promise<bigint> {
  const k = ckey(token, side, amountIn), lk = ckey(token, side);
  const hit = QUOTES.fresh(k, maxAge); if (hit) return hit.amountOut;
  if (!exact) { const sc = scaledQuote(LAST_QUOTE.get(lk), amountIn, maxAge); if (sc !== undefined) return sc; } // e.g. sell % after balance shrank
  return (await QUOTES.get(k, async () => ({ amountOut: await readAmountOut(pc, token, side, amountIn) }), maxAge)).amountOut;
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
/** Background refresh of a preset quote (TradeBridge calls this ~1 s). */
/** After a trade lands, quotes on its route are stale: drop them (the 1 s warm loop re-fills them). */
function dropRouteQuotes(token: Address) {
  for (const sd of ["buy", "sell"]) { LAST_QUOTE.delete(ckey(token, sd)); LAST_QUOTE.delete(ckey("usdg", token, sd)); }
  QUOTES.dropWhere((k) => k.startsWith(ckey(token)) || k.startsWith(ckey("usdg", token)));
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
  const amountOut = await readAmountOut(pc, token, side, amountIn);
  QUOTES.set(ckey(token, side, amountIn), { amountOut }); LAST_QUOTE.set(ckey(token, side), { amountIn, amountOut, at: Date.now() });
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
 * balanceOf, written to the hot cache. Within ~20 s of our own fill (lib/fillBook floor = the relay receipt's block) the
 * read is pinned AT or after that block (a lagging public-RPC node errors on it ⇒ brief retry), so it can't write the
 * pre-fill balance over the one bumpBalance booked from the receipt logs (SITE #137). Retries exhausted ⇒ `latest`.
 */
export async function tokenBalance(pc: PublicClient, erc20: Address, owner: Address) {
  const at = (blockNumber?: bigint) => pc.readContract({ address: erc20, abi: tokenAbi, functionName: "balanceOf", args: [owner], ...(blockNumber !== undefined ? { blockNumber } : {}) });
  const f = fillBook.floor(owner);
  const b = f === undefined ? await at() : await readAtOrAfter(pc, f, at).then((r) => r.value, () => at());
  BALANCES.set(ckey(erc20, owner), b); return b;
}
/**
 * Apply a known delta (e.g. coin received, from the receipt logs) to the cached balance. Reading balanceOf right after
 * a sync receipt can hit an RPC node one block behind (0 after a first buy ⇒ "NO TOKENS IN WALLET" on the next sell).
 */
export function bumpBalance(erc20: Address, owner: Address, delta: bigint) {
  const k = ckey(erc20, owner), cur = BALANCES.fresh(k, 60_000);
  if (cur !== undefined) BALANCES.set(k, cur + delta > B(0) ? cur + delta : B(0)); else if (delta > B(0)) BALANCES.set(k, delta);
}
/** Balance hint ≤ maxAge ms old (polled / refreshed after trades), else a live read. */
export async function balanceHint(pc: PublicClient, erc20: Address, owner: Address, maxAge = 5000) {
  return BALANCES.get(ckey(erc20, owner), () => {
    const at = (blockNumber?: bigint) => pc.readContract({ address: erc20, abi: tokenAbi, functionName: "balanceOf", args: [owner], ...(blockNumber !== undefined ? { blockNumber } : {}) });
    const f = fillBook.floor(owner);   // same receipt-block pin as tokenBalance
    return f === undefined ? at() : readAtOrAfter(pc, f, at).then((r) => r.value, () => at());
  }, maxAge);
}

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
  /**
   * Back-to-back trades: a landed op keeps counting as in flight until the public RPC's head has its block (the RPC lags
   * ~0.7–1.3 s) — else the next press is quoted at the pre-trade price and its minOut can't clear (lee: 5 × 10% sells).
   * Failed / no block ⇒ released now.
   */
  const releaseInflight = (done: () => void, landed: bigint | undefined) => {
    if (landed === undefined) { done(); return; }
    void holdInflightUntilSeen(done, landed, () => pc.getBlockNumber({ cacheTime: 0 }));
  };
  /**
   * Rebuilt (re-quoted) minOut. Was boundRebuiltMinOut (never below the first quote's minOut ⇒ a rebuild after the
   * price moved became a refusal). lee, Oct 26 10:50/10:51: buys and sells always go through at the fresh price; a big
   * move is shown as a price-impact warning before the tap, never a block. AUDIT / Needs GAME review.
   */
  const freshMinOut = (first: bigint, fresh: bigint): bigint => {
    if (fresh < first) console.warn("[disciple] re-quote is below the first quote; sending at the fresh price", { first: String(first), fresh: String(fresh) });
    return fresh;
  };
  async function trade(side: "buy" | "sell", t: TradeParams): Promise<TradeResult> {
    try { return await tradeOnce(side, t); }
    catch (e) {
      // A min-out failure on a quote WE derived is retried ONCE with a fresh quote: pre-send, or (lee, Oct 26 10:50:
      // "we can't stop them from selling") an op that definitely EXECUTED and reverted on-chain (nothing traded).
      // An op that may still land (Timeout) is NEVER resent: lee's Oct 26 test got an extra sell from that resend.
      // AUDIT: the definite-revert resend is new (was: never resend anything sent).
      if (!(e instanceof ProtocolError) || t.minAmountOut > B(0) || !MINOUT_RETRY.test(e.code) || (wasSent(e) && !wasReverted(e))) throw e;
      if (wasReverted(e)) console.warn("[disciple] trade reverted on price movement; resending once at a fresh quote", e.code);
      dropRouteQuotes(t.token);
      return tradeOnce(side, t);
    }
  }
  async function tradeOnce(side: "buy" | "sell", t: TradeParams): Promise<TradeResult> {
    if (!isDeployed()) throw new ProtocolError("NotDeployed", "Contracts not deployed on this chain yet.");
    try {
      // Hot path: coin facts cached, quote/balance/referral/allowance in PARALLEL (warm tap ⇒ all cache hits, 0 RPCs).
      const [{ curve, graduated, quote: quoteAsset, mode }, me] = await Promise.all([coinFacts(pc, t.token), activeAddress()]);
      const recipient = t.recipient || me;
      const deadline = B(t.deadline || now() + 120);
      // v4 PVE: the curve checks LoginGate.verifiedUntil(trader) on buys (trader = token recipient; router: msg.sender).
      // USDG router (#65) when the flag is on — and ALWAYS for USDG-quoted coins once the router supports it, so we
      // never emit a USDG approve to a curve (policy 1.3.0 rejects those)
      const usdg = await usdgRouteFor(pc, t.token);
      // graduation check for ANY quote: USDG-quoted ⇒ usdgIn is the curve's quoteIn; else converted on-chain (gradNeed)
      const gradCurve = usdg && side === "buy" && !graduated ? { curve, mode, quote: quoteAsset } : undefined;
      if (usdg) return await tradeViaUsdg(side, t, { usdg, me, recipient, deadline, pve: !graduated && mode === MODE.PVE, gradCurve });
      const pveCalls = side === "buy" && !graduated && mode === MODE.PVE ? await ensurePveLogin(pc, recipient) : [];
      const spendAsset = side === "buy" ? quoteAsset : t.token;
      const outAsset = side === "buy" ? t.token : quoteAsset;
      const smart = isSmartMode();
      const gradP = side === "buy" && !graduated ? buyMayGraduate(pc, curve, mode, t.amountIn, recipient) : Promise.resolve(false);
      // PVE/PVP curve: always a live, trader-specific quote (mode caps; PVE sells net of the profit tax)
      const quoteNow = () => !graduated && mode !== MODE.TRENCH ? readAmountOut(pc, t.token, side, t.amountIn, side === "buy" ? recipient : me)
        : marginalQuote(ckey("coin", t.token, side), t.amountIn, (a, age) => quoteOut(pc, t.token, side, a, age, true));
      const [qOut, have, refCalls, approve] = await Promise.all([
        t.minAmountOut > B(0) ? Promise.resolve(B(0)) : quoteNow(),
        balanceHint(pc, spendAsset, me),
        side === "buy" ? referralCallCached(me) : Promise.resolve([]),
        smart ? Promise.resolve(null) : approveCall(me, spendAsset, graduated ? deployment().router : curve, t.amountIn),
      ]);
      let minOut = t.minAmountOut > B(0) ? t.minAmountOut : applySlippage(qOut, t.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
      if (graduated && !hasRouter()) throw new ProtocolError("NoRouter", "This rocket reached orbit; the router isn't configured on this network yet.");
      const target: Address = graduated ? deployment().router : curve;
      const encodeTrade = (mo: bigint): Hex => graduated
        ? encodeFunctionData({ abi: discipleRouterAbi, functionName: side === "buy" ? "buyExactIn" : "sellExactIn", args: [t.token, t.amountIn, mo, recipient, deadline] })
        : encodeFunctionData({ abi: bondingCurveAbi, functionName: side, args: [t.amountIn, mo, deadline, recipient] });
      const data = encodeTrade(minOut);
      const grad = !graduated && await gradP;
      if (grad) { markGradBuy(data); GRAD.drop(curve); }
      // Preflight: an underfunded spend otherwise surfaces only as an opaque estimate failure / on-chain revert.
      if (have < t.amountIn) {
        const live = await pc.readContract({ address: spendAsset, abi: tokenAbi, functionName: "balanceOf", args: [me] });   // hint may be stale-low
        BALANCES.set(ckey(spendAsset, me), live);
        if (live < t.amountIn) {
          const [sym, dec] = await Promise.all([
            pc.readContract({ address: spendAsset, abi: tokenAbi, functionName: "symbol" }).catch(() => "token"),
            decimalsOf(pc, spendAsset).catch(() => null),
          ]);
          throw new ProtocolError("InsufficientBalance", dec == null ? `not enough ${sym} for that shot size`
            : `not enough ${sym}: need ${fmtUnits(t.amountIn, dec)} have ${fmtUnits(live, dec)}`);
        }
      }
      // Smart account: exact approve batched into the same op, always (no allowance read on the hot path).
      const approveCalls = smart ? [{ to: spendAsset, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [target, t.amountIn] }) }] : (approve ?? []);
      const calls = [...pveCalls, ...refCalls, ...approveCalls, { to: target, data }];
      BALANCES.set(ckey(spendAsset, me), have - t.amountIn);   // optimistic; corrected by the next poll
      const ik = ckey("coin", t.token, side);
      let done = addInflight(ik, t.amountIn);
      const pressId = t.pressId ?? newPressId();   // GAME reservation id: same on every retry of this press
      const minOut0 = minOut;   // the first quote's minOut (a rebuild may go lower: freshMinOut)
      // Rapid taps: the ONE transient-error retry in mav2.sendCalls re-quotes (fresh minOut) instead of re-sending a
      // quote taken before the preceding in-flight shots moved the curve. Same amountIn/approvals ⇒ same spend + shape.
      const rebuild = t.minAmountOut > B(0) ? undefined : async (): Promise<Call[]> => {
        dropRouteQuotes(t.token); done();   // our own op hasn't landed: don't price it against itself
        try {
          const mo = freshMinOut(minOut0, applySlippage(await quoteNow(), t.slippageBps ?? DEFAULT_SLIPPAGE_BPS));
          const d2 = encodeTrade(mo);
          if (grad) markGradBuy(d2);
          minOut = mo;
          return [...calls.slice(0, -1), { to: target, data: d2 }];
        } finally { done = addInflight(ik, t.amountIn); }
      };
      let landed: bigint | undefined;
      try {
        const r = await execCalls(calls, { rebuild, pressId });
        landed = logsBlock(r.logs);
        return { ok: true, txHash: r.txHash, amountOut: received(r.logs, outAsset, recipient) || minOut, pressId: r.pressId ?? pressId };
      } finally { releaseInflight(done, landed); dropRouteQuotes(t.token); }
    } catch (e) {
      // GAME: the press's reservation id survives the friendly re-wrap (aaSend tagged the original error)
      const pid = (e as { pressId?: string } | null)?.pressId ?? t.pressId;
      const out = e instanceof ProtocolError ? e : e instanceof PveError ? new ProtocolError(e.code, e.message) : tradeNetworkError(e) ?? friendlyError(e);
      if (pid) tagPress(out, pid);
      // the op went out (reverted on-chain / outcome unknown): mark it so trade() never resends it
      const ac = (e as { code?: unknown; constructor?: { name?: string } } | null);
      if ((e instanceof AAError || ac?.constructor?.name === "AAError") && (ac?.code === "Reverted" || ac?.code === "Timeout")) markSent(out);
      if ((e instanceof AAError || ac?.constructor?.name === "AAError") && ac?.code === "Reverted") REVERTED.add(out);
      // sent, outcome unknown: hold the press and settle it from the chain (never resends); TradeBridge shows "confirming"
      if (pid && out.code === "Timeout") void watchPending(pid, pendingIds(e), { lookup: (ids) => lookupOp(pc, ids) });
      throw out;
    }
  }

  /**
   * Pay-in-USDG through DiscipleRouter (lib/trade/usdgRouter, #65): ONE userOp = [exact approve, buyWithUsdg|sellToUsdg].
   * t.amountIn is USDG on buys, coin on sells; minOut is end-to-end from quoteUsdgRoute − slippage (the caller clamps
   * slippage to the session max − 0.5% headroom). Pre- and post-grad alike (the router picks curve or v4 pool).
   * Recipient is pinned to the account on-chain, so t.recipient is ignored on this path.
   */
  async function tradeViaUsdg(side: "buy" | "sell", t: TradeParams, c: { usdg: Address; me: Address; recipient: Address; deadline: bigint; pve?: boolean; gradCurve?: { curve: Address; mode: number; quote: Address } }): Promise<TradeResult> {
    const router = deployment().router, isBuy = side === "buy";
    // Router path: the curve trades for msg.sender (the account) ⇒ PVE login is checked for `me`.
    const pveCalls = isBuy && c.pve ? await ensurePveLogin(pc, c.me) : [];
    // quoteUsdgRouteFor(me) reverts NotVerified until the attest is on-chain ⇒ this path needs the server relay.
    if (pveCalls.length) throw new ProtocolError("PveRelayUnavailable", "Couldn't record your PVE login right now — try again in a moment.");
    const spend = isBuy ? c.usdg : t.token, outAsset = isBuy ? t.token : c.usdg;
    const g = isBuy ? c.gradCurve : undefined;
    // USDG-quoted curve: usdgIn IS the curve's quoteIn. Other quote (STRATEGY …): the router swaps USDG → quote first ⇒
    // the same on-chain conversion + margin the relay applies (lib/trade/gradNeed, lib/server/gradBuy).
    const gradP = !g ? Promise.resolve(false) : g.quote.toLowerCase() === c.usdg.toLowerCase()
      ? buyMayGraduate(pc, g.curve, g.mode, t.amountIn, c.me)
      : usdgBuyGraduates(pc, { router, curve: g.curve, quote: g.quote, usdgIn: t.amountIn });
    const ik = ckey("usdgroute", t.token, side);
    // exact (no down-scaled warm quote): minOut must clear the session policy floor on the FIRST try
    const quoteNow = () => marginalQuote(ik, t.amountIn, (a, age) => usdgRouteQuote(pc, router, t.token, isBuy, a, age, c.me, true));
    const [q, have] = await Promise.all([
      t.minAmountOut > B(0) ? Promise.resolve(B(0)) : quoteNow(),
      balanceHint(pc, spend, c.me),
    ]);
    if (have < t.amountIn) {
      const live = await pc.readContract({ address: spend, abi: tokenAbi, functionName: "balanceOf", args: [c.me] }); BALANCES.set(ckey(spend, c.me), live);
      if (live < t.amountIn) throw new ProtocolError("InsufficientBalance", isBuy
        ? `Not enough cash for $${usdgRawToUsd(t.amountIn).toFixed(2)}: you have $${usdgRawToUsd(live).toFixed(2)}. Pick a smaller amount or deposit more.`
        : `not enough tokens: need ${fmtUnits(t.amountIn, COIN_DECIMALS)} have ${fmtUnits(live, COIN_DECIMALS)}`);
    }
    let minOut = t.minAmountOut > B(0) ? t.minAmountOut : applySlippage(q, t.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
    if (minOut <= B(0)) throw new ProtocolError("ZeroQuote", "Route quote is zero — amount too small.");
    const routerCalls = (mo: bigint): Call[] => isBuy
      ? toCalls(routerBuyWithUsdgCalls({ router, usdg: c.usdg, token: t.token, usdgIn: t.amountIn, minTokensOut: mo, deadline: c.deadline }))
      : toCalls(routerSellToUsdgCalls({ router, token: t.token, tokensIn: t.amountIn, minUsdgOut: mo, deadline: c.deadline }));
    const prefix: Call[] = isBuy ? [...pveCalls, ...(await referralCallCached(c.me))] : [];
    const calls: Call[] = [...prefix, ...routerCalls(minOut)];
    const grad = await gradP;
    if (grad) { const buy = calls[calls.length - 1]; markGradBuy(buy.data); GRAD.drop(c.gradCurve!.curve); }
    BALANCES.set(ckey(spend, c.me), have - t.amountIn);
    let done = addInflight(ik, t.amountIn);
    const pressId = t.pressId ?? newPressId();   // GAME reservation id
    const minOut0 = minOut;   // the first quote's minOut (freshMinOut)
    // Rapid taps: transient-error retry re-quotes (see tradeOnce). Same usdgIn/tokensIn ⇒ same exact approve + shape.
    const rebuild = t.minAmountOut > B(0) ? undefined : async (): Promise<Call[]> => {
      dropRouteQuotes(t.token); done();
      try {
        const mo = freshMinOut(minOut0, applySlippage(await quoteNow(), t.slippageBps ?? DEFAULT_SLIPPAGE_BPS));
        if (mo <= B(0)) throw new Error("re-quote is zero");
        const next = [...prefix, ...routerCalls(mo)];
        if (grad) markGradBuy(next[next.length - 1].data);
        minOut = mo;
        return next;
      } finally { done = addInflight(ik, t.amountIn); }
    };
    let landed: bigint | undefined;
    try {
      const r = await execCalls(calls, { rebuild, pressId });
      landed = logsBlock(r.logs);
      return { ok: true, txHash: r.txHash, amountOut: received(r.logs, outAsset, c.me) || minOut, pressId: r.pressId ?? pressId };
    } finally { releaseInflight(done, landed); dropRouteQuotes(t.token); }
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
          // (summed when the pair IS the fee token), then launchAnon(params, stealthOwner, buyRecipient = me, eph, viewTag, maxFee = the fee just read: the exact
          // approve above already caps it; v5 AnonLauncher reverts FeeTooHigh if the owner raises it before inclusion).
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
          calls.push({ to: anonL, data: encodeFunctionData({ abi: anonLauncherAbi, functionName: "launchAnon", args: [params, stealthOwner, me, ephemeralPubKey, viewTag, fee] }) });
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
