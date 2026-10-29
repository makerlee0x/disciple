/**
 * Relayer gas policy (W-1), shared by the self-bundler (server) and the one-tap op builders (client).
 *
 * Who pays: the relayer EOA submits EntryPoint.handleOps and pays the tx at ITS gas price; the EntryPoint reimburses
 * the beneficiary (= relayer) at the OP's price, min(op.maxFeePerGas, op.maxPriorityFeePerGas + basefee), times the
 * gas the op used. If an op's fees are below the relayer's (fee 0 in the worst case) every op is a loss for the
 * relayer, and a huge callGasLimit makes each one expensive. So:
 *  1. The op must pay at least the relayer's price: maxFeePerGas >= relayerPrice(base) and
 *     maxPriorityFeePerGas >= RELAYER_TIP (RELAYER_FEE_FLOOR).
 *  2. The relayer tx is submitted at relayerTxFees(op, base): never above the op's own fees, so the op's effective
 *     price is always >= the relayer's effective price (reimbursed at least the cost per gas).
 *  3. Gas limits are capped (GAS_CAPS) so one op can't make the relayer front a huge tx, and preVerificationGas must
 *     cover the fixed handleOps overhead (MIN_PRE_VERIFICATION_GAS).
 * Pure (no server-only, no RPC): unit-tested by scripts/test-relay-policy.mts.
 */
import { decodeFunctionData, encodeFunctionData, parseAbi, toFunctionSelector, type AbiFunction, type AbiItem, type Hex } from "viem";
import { anonLauncherAbi } from "../abi/AnonLauncher";
import { bondingCurveAbi } from "../abi/BondingCurve";
import { discipleRouterAbi } from "../abi/DiscipleRouter";
import { launchpadAbi } from "../abi/Launchpad";

/** 0.001 gwei: the relayer's priority fee (RH testnet inclusion floor; also what rundler_maxPriorityFeePerGas answers). */
export const RELAYER_TIP = BigInt(1_000_000);
/** The relayer's max fee for a given base fee: 2x base (absorbs base-fee moves for a block or two) + tip. */
export const relayerPrice = (baseFee: bigint) => baseFee * BigInt(2) + RELAYER_TIP;

/**
 * Gas caps for one op, from real one-tap ops (lib/aa/fastPath STATIC_GAS and the self-bundler estimates):
 *  - STATIC_GAS (deployed account, any preset): call 1.8M, verification 350k, PVG 60k.
 *  - measured v4 buy/sell incl. approve + hook ≈ 0.45–0.65M execution; GasCache adds 1.5x on top of the
 *    self-bundler estimate (1.3x + 20k) ⇒ ≈ 1.3M for the heaviest preset seen.
 *  - first op (account deploy): self-bundler verification estimate 450k, ×1.2 client headroom = 540k.
 *  - PVG: the self-bundler answers 60k; LightAccount path adds 1.2x = 72k.
 * Caps leave ≥ 1.6x headroom over all of those.
 */
export const GAS_CAPS = {
  callGasLimit: BigInt(3_000_000),
  verificationGasLimit: BigInt(1_000_000),
  preVerificationGas: BigInt(200_000),
  paymasterVerificationGasLimit: BigInt(300_000),
  paymasterPostOpGasLimit: BigInt(300_000),
  /** sum of all of the above that the op sets */
  total: BigInt(4_000_000),
} as const;
/**
 * Launch ops only (Launchpad launch / AnonLauncher launchAnon / DiscipleRouter launchWithUsdg, plus their approvals): a
 * launch deploys the token + curve and seeds state ≈ 6.06M execution gas, ≈ 7.9M after the self-bundler's 1.3x + 20k
 * estimate padding, which GAS_CAPS (3M / 4M) rejected as "above cap" ⇒ "simulation failed". Every other op keeps the
 * W-1 caps above. v5: the live smoke launch (approve + Launchpad.launch with First BOOST) used 6,780,271 gas;
 * launchWithUsdg = the same launchFor + the router's USDG pull / USDG→pair swap (+ an optional refund swap) ≈ 7.0–7.3M
 * ⇒ ≈ 9.1–9.5M estimated call gas: inside 10M, with the account / paymaster limits inside the 11M total.
 */
export const LAUNCH_GAS_CAPS = {
  ...GAS_CAPS,
  callGasLimit: BigInt(10_000_000),
  total: BigInt(11_000_000),
} as const;
/**
 * Buys that may GRADUATE the curve (steep curve #1 + 16-band floor, feat/steep-curve-floor): the graduating buy runs
 * Migration + the full-range seed + 16 floor positions in one tx ≈ 2.76M execution gas at 6-dec USDG (forge FloorSeedGas, cap 3.0M),
 * ≈ 3.4M after the self-bundler's 1.3x + 20k padding ⇒ above GAS_CAPS (3M / 4M). Only buys whose quote reaches the
 * remaining USDG to graduation (curve.quoteBuy(q).graduates) get these; the client always estimates them fresh.
 */
export const GRAD_GAS_CAPS = {
  ...GAS_CAPS,
  callGasLimit: BigInt(5_000_000),
  total: BigInt(6_000_000),
} as const;
export type GasCaps = { [K in keyof typeof GAS_CAPS]: bigint };

/** User-callable launch entry points (Launchpad.launchFor is router-only, not listed). Exported for tests. */
export const LAUNCH_FUNCTIONS = ["launch", "launchCoin", "launchWithMode", "launchAnon", "launchWithUsdg"] as const;
export const LAUNCH_SELECTORS: ReadonlySet<string> = new Set(
  ([...launchpadAbi, ...anonLauncherAbi, ...discipleRouterAbi] as readonly AbiItem[])
    .filter((f): f is AbiFunction => f.type === "function" && (LAUNCH_FUNCTIONS as readonly string[]).includes(f.name))
    .map((f) => toFunctionSelector(f).toLowerCase()),
);
/** Calls allowed next to a launch: the exact First BOOST approve and the PVE LoginGate.attest (#99 ensurePveLogin). */
const LAUNCH_HELPERS = new Set([
  toFunctionSelector("function approve(address,uint256)"),
  toFunctionSelector("function attest(address wallet, uint64 expiry, address coin, bytes sig)"),
].map((x) => x.toLowerCase()));
const accountAbi = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
]);
const EXECUTE_USER_OP = "0x8dd7712f";
/** Inner calls of an MAv2 / LightAccount callData (execute / executeBatch, optionally behind executeUserOp). null = unknown shape. */
export function accountCalls(callData: string): { to: string; data: string; value: bigint }[] | null {
  let cd = (callData || "0x").toLowerCase() as Hex;
  if (cd.startsWith(EXECUTE_USER_OP)) cd = ("0x" + cd.slice(10)) as Hex;
  try {
    const d = decodeFunctionData({ abi: accountAbi, data: cd });
    if (d.functionName === "execute") { const [to, value, data] = d.args as readonly [string, bigint, string]; return [{ to, data, value }]; }
    return (d.args[0] as readonly { target: string; value: bigint; data: string }[]).map((c) => ({ to: c.target, data: c.data, value: c.value }));
  } catch { return null; }
}
/**
 * Is this op a launch? Every inner call must be an approve / LoginGate.attest or a launch selector, at least one launch, and every launch
 * must target one of `launchers` (Launchpad, AnonLauncher(s), DiscipleRouter: lib/aa/launchTargets). Anything else (or an undecodable callData) ⇒ false ⇒
 * normal GAS_CAPS. Selectors come from the generated Launchpad / AnonLauncher / DiscipleRouter ABIs.
 */
export function isLaunchOp(callData: string, launchers: string[]): boolean {
  const calls = accountCalls(callData);
  if (!calls?.length) return false;
  const ls = launchers.map((a) => a.toLowerCase());
  let launches = 0;
  for (const c of calls) {
    const sel = c.data.slice(0, 10).toLowerCase();
    if (LAUNCH_HELPERS.has(sel)) continue;
    if (!LAUNCH_SELECTORS.has(sel) || !ls.includes(c.to.toLowerCase())) return false;
    launches++;
  }
  return launches > 0;
}
/** True if a client-side call list launches (same rule as isLaunchOp, before encoding). */
export const isLaunchCalls = (calls: { to: string; data: string }[], launchers: string[]) =>
  calls.some((c) => LAUNCH_SELECTORS.has(c.data.slice(0, 10).toLowerCase()) && launchers.map((a) => a.toLowerCase()).includes(c.to.toLowerCase()));

/**
 * Caps for an op: LAUNCH_GAS_CAPS when it is a launch to one of `launchers`; GRAD_GAS_CAPS when the caller verified
 * it is a graduating buy (lib/server/gradBuy relayCaps: on-chain check, only for ops above GAS_CAPS); else GAS_CAPS.
 */
export const capsForOp = (op: { callData?: string }, launchers: string[], opts?: { gradBuy?: boolean }): GasCaps =>
  op.callData && isLaunchOp(op.callData, launchers) ? LAUNCH_GAS_CAPS : opts?.gradBuy ? GRAD_GAS_CAPS : GAS_CAPS;

/**
 * Curve buys (direct, or DiscipleRouter buyWithUsdg / buyExactIn ⇒ curve.routerBuy pre-graduation), taken from the
 * generated v5 ABIs so a contract signature change can't leave a stale selector here (v5 buyFor is 5-arg:
 * buyFor(buyer, quoteIn, minTokensOut, deadline, maxTokens); it is Launchpad-only on-chain, so a user op calling it reverts).
 * Arg order the decoder relies on: curve buy / buyFor quoteIn = args[0] / args[1]; router (token, amountIn, …).
 */
const buyAbi = [
  ...bondingCurveAbi.filter((f) => f.type === "function" && (f.name === "buy" || f.name === "buyFor")),
  ...discipleRouterAbi.filter((f) => f.type === "function" && (f.name === "buyWithUsdg" || f.name === "buyExactIn")),
] as readonly AbiFunction[];
/** Exported for tests: must equal the ABI-derived selectors of the five buy entry points above. */
export const BUY_SELECTORS: ReadonlySet<string> = new Set(buyAbi.map((f) => toFunctionSelector(f).toLowerCase()));
/**
 * One buy inside a call list: `curve` = called on a curve (to = curve); `router` = called on a router (to = router, token
 * named). `unit` = what quoteIn is denominated in: "quote" (the curve's own quote: curve buy / buyFor, router
 * buyExactIn) or "usdg" (router buyWithUsdg — only comparable with curve.quoteBuy when the curve's quote IS USDG).
 */
export type BuyIntent = { kind: "curve" | "router"; to: string; token?: string; quoteIn: bigint; unit: "quote" | "usdg" };
/** Every curve / router buy in a call list (or an account callData). Undecodable or no buys ⇒ []. Pure. */
export function buyIntents(callsOrCallData: string | { to: string; data: string }[]): BuyIntent[] {
  const calls = typeof callsOrCallData === "string" ? accountCalls(callsOrCallData) : callsOrCallData;
  const out: BuyIntent[] = [];
  for (const c of calls ?? []) {
    if (!BUY_SELECTORS.has(c.data.slice(0, 10).toLowerCase())) continue;
    try {
      const d = decodeFunctionData({ abi: buyAbi, data: c.data as Hex });
      const a = d.args as readonly unknown[];
      const to = c.to.toLowerCase();
      if (d.functionName === "buy") out.push({ kind: "curve", to, quoteIn: a[0] as bigint, unit: "quote" });
      else if (d.functionName === "buyFor") out.push({ kind: "curve", to, quoteIn: a[1] as bigint, unit: "quote" });
      else out.push({ kind: "router", to, token: (a[0] as string).toLowerCase(), quoteIn: a[1] as bigint, unit: d.functionName === "buyWithUsdg" ? "usdg" : "quote" });
    } catch { /* not a buy after all */ }
  }
  return out;
}
const APPROVE_SEL = toFunctionSelector("function approve(address,uint256)").toLowerCase();
const approveAbi = parseAbi(["function approve(address spender, uint256 amount)"]);
/** Ops with more buys than this never get GRAD_GAS_CAPS (bounds the relay's on-chain work per op). */
export const MAX_GRAD_BUY_INTENTS = 2;
/** An approve that runs inside the op before the buy: token = the approve's target. */
export type InOpApproval = { token: string; spender: string; amount: bigint };
/**
 * What a grad-buy op may carry besides approves + the buy (gradBuyCandidate). All addresses come from the relay's own
 * config (lib/server/gradBuy chainGradReads: DEPLOYMENTS[chainId], the same deployment() the client builds calls from):
 *  - `usdg` + `paymaster`: usdg.approve(paymaster, x), the one extra leading call a USDG-gas (DisciplePaymaster) op
 *    must carry — set only when the op's paymaster field IS our paymaster;
 *  - `referralRegistry`: ReferralRegistry.tryAttribute(sender, referrer) (protocol-viem referralCall, first buy of a
 *    referred wallet); `sender` binds its `wallet` arg (the registry reverts NotWalletOrAttestor otherwise);
 *  - `loginGate`: LoginGate.attest(wallet, expiry, coin, sig) (lib/pve ensurePveLogin, relay-unavailable fallback).
 */
export type GradShapeOpts = { usdg?: string; paymaster?: string; referralRegistry?: string; loginGate?: string; sender?: string };
/** `c` decoded as ERC-20 approve(spender, amount) on `c.to`, else null (selector AND full decode required). */
function asApprove(c: { to: string; data: string }): InOpApproval | null {
  if (c.data.slice(0, 10).toLowerCase() !== APPROVE_SEL) return null;
  try {
    const d = decodeFunctionData({ abi: approveAbi, data: c.data as Hex });
    return { token: c.to.toLowerCase(), spender: (d.args[0] as string).toLowerCase(), amount: d.args[1] as bigint };
  } catch { return null; }
}
const referralAbi = parseAbi(["function tryAttribute(address wallet, address referrer)"]);
const loginGateAttestAbi = parseAbi(["function attest(address wallet, uint64 expiry, address coin, bytes sig)"]);
const TRY_ATTRIBUTE_SEL = toFunctionSelector(referralAbi[0]).toLowerCase();
const ATTEST_SEL = toFunctionSelector(loginGateAttestAbi[0]).toLowerCase();
const sameAddr = (a: string | undefined, b: string | undefined) => !!a && !!b && !/^0x0{40}$/i.test(b) && a.toLowerCase() === b.toLowerCase();
/**
 * `c` is exactly `fn` on `target`: configured (non-zero) target, value 0, exact selector, and the data is the
 * CANONICAL encoding of its decoded args (no trailing / non-canonical bytes). Returns the decoded args, else null.
 */
function asExactCall(c: { to: string; data: string; value?: bigint }, target: string | undefined, abi: typeof referralAbi | typeof loginGateAttestAbi, sel: string): readonly unknown[] | null {
  if (!sameAddr(c.to, target) || (c.value ?? BigInt(0)) !== BigInt(0) || c.data.slice(0, 10).toLowerCase() !== sel) return null;
  try {
    const d = decodeFunctionData({ abi, data: c.data as Hex });
    const args = d.args as readonly unknown[];
    if (encodeFunctionData({ abi, functionName: d.functionName, args } as never).toLowerCase() !== c.data.toLowerCase()) return null;
    return args;
  } catch { return null; }
}
/**
 * The only op shape that may earn GRAD_GAS_CAPS (audit r106 Low gradBuy.ts:40, round 2 gasPolicy.ts:168/:177, round 3
 * prefix regression):
 *
 *   [ usdg.approve(paymaster, x)?          ← only for a USDG-gas op, only when `pm` names the op's paymaster + USDG
 *   , LoginGate.attest(w, exp, coin, sig)? ← at most one, target = the configured LoginGate
 *   , ReferralRegistry.tryAttribute(sender, ref)? ← at most one, target = the configured ReferralRegistry
 *   , approve(quoteToken, spender, y)*     ← zero or more, ALL on one token, spender = the buy's target (curve / router)
 *   , buy ]                                ← the literal LAST call (curve buy / buyFor, router buyWithUsdg / buyExactIn)
 *
 * This is the order protocol-viem emits: tradeOnce [...pveCalls, ...refCalls, ...approveCalls, buy], tradeViaUsdg
 * [...refCalls, approve, buyWithUsdg] (its attest path throws PveRelayUnavailable), with paymasterClient putting the
 * paymaster approve first. The two prefix calls are value-0, fully decoded, on OUR contracts: tryAttribute only writes
 * ReferralRegistry's own pending/referrer maps, attest only LoginGate's verifiedUntil — neither calls a token or the
 * account, so neither moves funds nor changes any allowance, and the post-approve funding state below is unchanged.
 *
 * Anything else ⇒ null: any other call before the buy, any call after it, a prefix call out of order / twice / on
 * another target / with value / with another selector, an approve to another spender or on a second token, more than
 * MAX_GRAD_BUY_INTENTS buys (checked first, before any decode work). The approve token is returned as `quoteToken`; the
 * caller (lib/server/gradBuy) must check it equals the curve's quote on-chain. Because only approves (and the
 * state-isolated prefix calls) precede the buy, the post-approve state the buy sees is (pre-op balance, last approve's
 * amount — or the pre-op allowance when there is none): `approvals` carries them in order. Pure.
 */
export function gradBuyCandidate(callData: string, pm: GradShapeOpts = {}): { intent: BuyIntent; approvals: InOpApproval[]; quoteToken?: string } | null {
  const calls = accountCalls(callData);
  if (!calls?.length) return null;
  if (buyIntents(calls).length > MAX_GRAD_BUY_INTENTS) return null;
  const last = calls.length - 1;
  const [intent] = buyIntents([calls[last]]);
  if (!intent) return null;
  let i = 0;
  if (last > 0 && pm.usdg && pm.paymaster) {
    const a = asApprove(calls[0]);
    if (a && a.token === pm.usdg.toLowerCase() && a.spender === pm.paymaster.toLowerCase()) i = 1;
  }
  // optional prefix, in emit order, each at most once
  if (i < last && asExactCall(calls[i], pm.loginGate, loginGateAttestAbi, ATTEST_SEL)) i++;
  if (i < last) {
    const t = asExactCall(calls[i], pm.referralRegistry, referralAbi, TRY_ATTRIBUTE_SEL);
    if (t) {
      if (!pm.sender || !sameAddr(t[0] as string, pm.sender)) return null;   // wallet must be the op's sender
      i++;
    }
  }
  const approvals: InOpApproval[] = [];
  for (; i < last; i++) {
    const a = asApprove(calls[i]);
    if (!a || a.spender !== intent.to) return null;                           // unknown call / wrong spender
    if (approvals.length && a.token !== approvals[0].token) return null;     // approves on two different tokens
    approvals.push(a);
  }
  return { intent, approvals, quoteToken: approvals[0]?.token };
}
/** A buy may graduate the curve when its quote reaches the remaining quote to graduation (> 0: not yet graduated). */
export const isGradBuy = (quoteIn: bigint, remainingToGrad: bigint) => remainingToGrad > BigInt(0) && quoteIn >= remainingToGrad;
/** True if the op's limits are above `caps` (the only case where a wider cap class is worth checking on-chain). */
export const exceedsCaps = (op: GasFields, caps: GasCaps = GAS_CAPS) =>
  big(op.callGasLimit) > caps.callGasLimit || totalGas(op) > caps.total;

/** handleOps fixed overhead (21k intrinsic + calldata + EntryPoint bookkeeping) is paid via PVG; below this the relayer subsidises every op. */
export const MIN_PRE_VERIFICATION_GAS = BigInt(40_000);
/** Client headroom over the relayer floor (base fee may rise between the client's fee read and the relay). */
export const CLIENT_FEE_HEADROOM_PCT = BigInt(150);

export type GasFields = {
  callGasLimit?: string | bigint; verificationGasLimit?: string | bigint; preVerificationGas?: string | bigint;
  maxFeePerGas?: string | bigint; maxPriorityFeePerGas?: string | bigint;
  paymaster?: string; paymasterVerificationGasLimit?: string | bigint; paymasterPostOpGasLimit?: string | bigint;
};
const big = (x: string | bigint | undefined) => { try { return x === undefined || x === "" ? BigInt(0) : BigInt(x); } catch { return BigInt(-1); } };

/** Plain copy for any infrastructure-side failure a user could see (no gas / ETH / paymaster / bundler wording). */
export const TRADING_UNAVAILABLE = "Trading is temporarily unavailable — try again shortly.";
/** Plain copy when the account's USDG can't cover the trade plus its network cost. */
export const NOT_ENOUGH_USDG = "Not enough USDG — deposit more.";
/** Infrastructure wording that must never reach the UI verbatim. */
export const INFRA_WORDING = /\bgas\b|gaslimit|paymaster|bundler|sponsor|prefund|\bETH\b|\bwei\b|entry ?point|userop|AA3[0-9]/i;

export class RelayPolicyError extends Error {
  /** `detail`: internal reason for logs (may name gas / paymaster); `message` is what a client can show. */
  constructor(msg: string, public code: "fee" | "gas" | "paymaster", public detail?: string) { super(msg); }
}

/** Total gas the op may consume (what the EntryPoint prefunds). */
export function totalGas(op: GasFields): bigint {
  let g = big(op.callGasLimit) + big(op.verificationGasLimit) + big(op.preVerificationGas);
  if (op.paymaster) g += big(op.paymasterVerificationGasLimit) + big(op.paymasterPostOpGasLimit);
  return g;
}
/**
 * Max prefund for trust/balance decisions: all gas limits × max(op.maxFeePerGas, priceFloor). Pass the relayer's
 * price floor (relayerPrice(base)) so an op that under-states its fee (fee 0) can never look covered by a 0 balance.
 */
export function maxPrefund(op: GasFields, priceFloor: bigint = BigInt(0)): bigint {
  const f = big(op.maxFeePerGas);
  return totalGas(op) * (f > priceFloor ? f : priceFloor);
}

/** Throws RelayPolicyError if the op could make the relayer pay. Returns the op's total gas. */
export function checkOpGas(op: GasFields, baseFee: bigint, caps: GasCaps = GAS_CAPS): bigint {
  const fields = [op.callGasLimit, op.verificationGasLimit, op.preVerificationGas, op.maxFeePerGas, op.maxPriorityFeePerGas, op.paymasterVerificationGasLimit, op.paymasterPostOpGasLimit];
  if (fields.some((f) => big(f) < BigInt(0))) throw new RelayPolicyError("malformed gas field", "gas");
  const maxFee = big(op.maxFeePerGas), tip = big(op.maxPriorityFeePerGas);
  const floor = relayerPrice(baseFee);
  // "fee below relayer floor" is matched by the client (lib/aa/mav2) to refresh its fee cache and retry once
  if (maxFee < floor) throw new RelayPolicyError(`fee below relayer floor: maxFeePerGas ${maxFee} < ${floor} (2x base fee + tip)`, "fee");
  if (tip < RELAYER_TIP) throw new RelayPolicyError(`fee below relayer floor: maxPriorityFeePerGas ${tip} < ${RELAYER_TIP}`, "fee");
  const cap = (name: keyof typeof GAS_CAPS, v: string | bigint | undefined) => { if (big(v) > caps[name]) throw new RelayPolicyError(`${name} ${big(v)} above cap ${caps[name]}`, "gas"); };
  cap("callGasLimit", op.callGasLimit); cap("verificationGasLimit", op.verificationGasLimit); cap("preVerificationGas", op.preVerificationGas);
  if (op.paymaster) { cap("paymasterVerificationGasLimit", op.paymasterVerificationGasLimit); cap("paymasterPostOpGasLimit", op.paymasterPostOpGasLimit); }
  if (big(op.preVerificationGas) < MIN_PRE_VERIFICATION_GAS) throw new RelayPolicyError(`preVerificationGas ${big(op.preVerificationGas)} below ${MIN_PRE_VERIFICATION_GAS}`, "gas");
  const total = totalGas(op);
  if (total > caps.total) throw new RelayPolicyError(`total gas ${total} above cap ${caps.total}`, "gas");
  return total;
}

/**
 * Paymaster ops (DisciplePaymaster, USDG gas): the EntryPoint takes the prefund from the PAYMASTER's deposit, not the
 * sender (who holds no ETH), and refunds the relayer from it. Only our own paymaster is accepted (a foreign one could
 * fail validation on-chain and leave the relayer paying), and its deposit must cover the op's max prefund priced at
 * >= the relayer floor, else handleOps reverts AA31 at the relayer's expense. No-op for self-pay ops.
 */
export function checkPaymaster(op: GasFields, allowed: string | undefined, deposit: bigint, baseFee: bigint): void {
  if (!op.paymaster) return;
  // Client-visible message is plain (Lee: users never see gas wording); the reason rides in `detail` for logs.
  if (!allowed || op.paymaster.toLowerCase() !== allowed.toLowerCase())
    throw new RelayPolicyError(TRADING_UNAVAILABLE, "paymaster", `paymaster ${op.paymaster} not accepted (DisciplePaymaster only)`);
  const need = maxPrefund(op, relayerPrice(baseFee));
  if (deposit < need)
    throw new RelayPolicyError(TRADING_UNAVAILABLE, "paymaster", `paymaster deposit too low: ${deposit} < ${need} wei (keeper top-up pending)`);
}

/**
 * Fees for the relayer's handleOps tx: the relayer's own price, but never above the op's fees. With the floor checked,
 * effective(op) = min(op.maxFee, base + op.tip) >= min(txMaxFee, base + txTip) = effective(tx).
 */
export function relayerTxFees(op: GasFields, baseFee: bigint): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const opMax = big(op.maxFeePerGas), opTip = big(op.maxPriorityFeePerGas);
  const maxFeePerGas = opMax < relayerPrice(baseFee) ? opMax : relayerPrice(baseFee);
  let maxPriorityFeePerGas = opTip < RELAYER_TIP ? opTip : RELAYER_TIP;
  if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/**
 * Client fees from the same formula, with headroom: tip = max(bundler tip, RELAYER_TIP) + 10%,
 * maxFee = (2x base + tip) × headroom (1.5 default; the one-tap FeeCache passes 1.0 and doubles maxFee itself). Users pay base + tip per gas actually used; maxFee only sizes the prefund.
 */
export function clientFees(baseFee: bigint, bundlerTip: bigint = RELAYER_TIP, headroomPct: bigint = CLIENT_FEE_HEADROOM_PCT): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const t = bundlerTip > RELAYER_TIP ? bundlerTip : RELAYER_TIP;
  const maxPriorityFeePerGas = (t * BigInt(110)) / BigInt(100);
  const maxFeePerGas = ((baseFee * BigInt(2) + maxPriorityFeePerGas) * headroomPct) / BigInt(100);
  return { maxFeePerGas, maxPriorityFeePerGas };
}
