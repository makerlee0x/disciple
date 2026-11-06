/**
 * Quote rules for /api/paymaster (DisciplePaymaster, USDG token paymaster). Pure: every chain read and the signer are
 * injected (QuoteDeps), so scripts/test-paymaster.mts covers the rules without RPC or keys. lib/server/paymasterQuote
 * wires the real deps (env signer key, on-chain reads).
 *
 * Two-phase ERC-7677 flow:
 *  1. pm_getPaymasterStubData(op): fills the paymaster gas limits, answers the
 *     rate + the exact maxTokenCost the op must approve, with a dummy-signature paymasterData of the final length.
 *  2. The client finalises gas/fees, then pm_getPaymasterData(op): the server re-derives every
 *     number from the op itself and signs only if the op is safe for the paymaster (AUDIT F-01):
 *       - paymaster + gas limits are ours, fees/gas within lib/aa/gasPolicy (the deposit fronts the gas);
 *       - available gas credit covers tokenCost(maxCost, rate); a zero-credit sender may run one setup op;
 *       - MAX approvals, unmatched approve/deposit, and carried debt are refused;
 *       - the op's gas units must fit maxGasPerOp (or maxLaunchGasPerOp);
 *       - the rate is inside the contract's [minRate, maxRate].
 *     The signed hash is the OP-BOUND quote hash (DisciplePaymaster.getOpHash: nonce, callData, gas, fees, window,
 *     rate, maxTokenCost), so the quote — often a larger launch / graduating-buy maxTokenCost — is single-use and these
 *     per-op checks are binding (AUDIT #141 L-2). The contract also re-checks every per-op rule on-chain.
 *  3. pm_getPaymasterAllowance(sender) (feat/trade-latency): issues that allowance AHEAD of time for the standard trade
 *     envelope (ALLOWANCE_GAS × a fee ceiling), so a warm trade makes 0 pm_* calls. Exposure per sender stays
 *     ≤ maxTokenCost, with a separate gas-unit bound on-chain (contracts/docs/usdg-paymaster.md §Allowance).
 * We never sponsor: the user's own USDG secures every op before execution. Legacy debt fields stay zero.
 */
import { size, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const KEY32 = /^0x[0-9a-fA-F]{64}$/;
import { capsForOp, checkOpGas, clientFees, exceedsCaps, GAS_CAPS, isLaunchOp, RelayPolicyError, type GasCaps } from "../aa/gasPolicy";
import type { UserOp } from "../aa/core";
import { SETUP_DEPOSIT } from "../aa/prepayBootstrap";
import { ENTRYPOINT_V07 } from "../aa/constants";
import {
  ALLOWANCE_GAS, classifyCreditCalldata, encodePaymasterData, entryPointMaxCost, tokenCost, formatUsdg, MAX_QUOTE_WINDOW_SEC, PAYMASTER_DATA_LENGTH, PAYMASTER_GAS,
  paymasterAllowanceHash, paymasterQuoteHash, paymasterLaunchQuoteHash, requiredMaxTokenCost, stubPaymasterData, type PaymasterQuote,
} from "../aa/paymaster";

export const PAYMASTER_CHAIN_ID = 46630;
const PAYMASTER_CHAINS = new Set([4663, 46630]);
export const DEFAULT_QUOTE_TTL_SEC = 180;
/** Pre-issued allowance lifetime (PAYMASTER_ALLOWANCE_TTL_SEC); the client refreshes ALLOWANCE_REFRESH_AHEAD_SEC before. */
export const DEFAULT_ALLOWANCE_TTL_SEC = 600;
/** Fee ceiling of an allowance = clientFees(baseFee) × this (FeeCache doubles the client's maxFee the same way). */
export const ALLOWANCE_FEE_MULT = BigInt(2);
/** Back-date validAfter a little so a quote is usable on a node whose clock is slightly behind ours. */
export const VALID_AFTER_SKEW_SEC = 30;
/** Max the client may approve above the required amount (basis points). The charge is actual gas either way. */
export const DEFAULT_MAX_SLACK_BPS = BigInt(5_000);

export class PaymasterQuoteError extends Error {
  constructor(public code: "config" | "chain" | "entrypoint" | "op" | "gas" | "approve" | "balance" | "rate", msg: string, public data?: Record<string, string>) { super(msg); }
}

export type QuoteConfig = {
  paymaster: Address; usdg: Address; usdgDecimals: number; rate: bigint;
  ttlSec?: number; maxSlackBps?: bigint; allowanceTtlSec?: number;
  /** Launchpad / AnonLauncher(s) (lib/aa/launchTargets): their launch ops get LAUNCH_GAS_CAPS (10M call / 11M total), as in the relay. */
  launchers?: string[];
};
/**
 * Same per-op caps the relay applies (fastRelay / selfBundler relayCaps): launches to `launchers` ⇒ LAUNCH_GAS_CAPS;
 * an op above GAS_CAPS that deps.isGradBuy verifies on-chain (graduating curve buy) ⇒ GRAD_GAS_CAPS; else GAS_CAPS.
 */
export async function quoteCaps(op: UserOp, cfg: QuoteConfig, deps?: Pick<QuoteDeps, "isGradBuy">): Promise<GasCaps> {
  const caps = capsForOp(op, cfg.launchers ?? []);
  if (caps !== GAS_CAPS || !deps?.isGradBuy || !op.callData || !exceedsCaps(op, GAS_CAPS)) return caps;
  return capsForOp(op, cfg.launchers ?? [], { gradBuy: await deps.isGradBuy(op.callData, op.sender) });
}
export type QuoteDeps = {
  now(): number; // unix seconds
  /** Legacy owedOf. v5 is always zero; a nonzero value is refused. */
  debtOf(sender: Address): Promise<bigint>;
  /** Available gas credit (creditOf - reservedOf), not the wallet's USDG balance. */
  balanceOf(sender: Address): Promise<bigint>;
  /** Unused by v5 admission. Kept so existing dep objects still type-check. */
  allowanceOf(sender: Address): Promise<bigint>;
  /** credit reserved by ops already in this bundle. Defaults to 0. */
  reservedOf?(sender: Address): Promise<bigint>;
  /** True after the one-time zero-credit setup has been admitted. Defaults to false. */
  bootstrapUsed?(sender: Address): Promise<boolean>;
  bounds(): Promise<{ minRate: bigint; maxRate: bigint; maxGasPerOp: bigint; maxLaunchGasPerOp: bigint }>;
  baseFee(): Promise<bigint>;
  /** EIP-191 personal_sign of the raw 32-byte hash with PAYMASTER_SIGNER_KEY. */
  sign(hash: Hex): Promise<Hex>;
  /** On-chain graduating-buy check (lib/server/gradBuy isGradBuyOp: exact [pm approve?, approve*, buy] shape, post-approve balance + allowance); absent ⇒ never GRAD_GAS_CAPS. */
  isGradBuy?(callData: string, sender: string): Promise<boolean>;
};
export type PaymasterFields = {
  paymaster: Address; paymasterVerificationGasLimit: Hex; paymasterPostOpGasLimit: Hex; paymasterData: Hex;
};
export type StubResult = PaymasterFields & { isFinal: false; disciple: { usdg: Address; rate: Hex; maxTokenCost: Hex; debt: Hex; validUntil: number; usdgDecimals: number } };

const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}` as Hex;

function checkTarget(entryPoint: string, chainId: string | number) {
  if (String(entryPoint).toLowerCase() !== ENTRYPOINT_V07.toLowerCase()) throw new PaymasterQuoteError("entrypoint", `unsupported entryPoint ${entryPoint} (v0.7 only)`);
  if (!PAYMASTER_CHAINS.has(Number(chainId))) throw new PaymasterQuoteError("chain", `unsupported chain ${Number(chainId)}`);
}

function withPaymaster(op: UserOp, paymaster: Address): UserOp {
  return { ...op, paymaster, paymasterVerificationGasLimit: hex(PAYMASTER_GAS.verificationGasLimit), paymasterPostOpGasLimit: hex(PAYMASTER_GAS.postOpGasLimit) };
}

async function rateInBounds(cfg: QuoteConfig, deps: QuoteDeps) {
  const b = await deps.bounds();
  if (cfg.rate < b.minRate || cfg.rate > b.maxRate) throw new PaymasterQuoteError("rate", `configured rate ${cfg.rate} outside the paymaster's bounds [${b.minRate}, ${b.maxRate}]`);
  return b;
}

/** Phase 1 (pm_getPaymasterStubData). Gas fields still unset are counted at their gasPolicy caps (upper bound). */
export async function stubQuote(op: UserOp, entryPoint: string, chainId: string | number, cfg: QuoteConfig, deps: QuoteDeps): Promise<StubResult> {
  checkTarget(entryPoint, chainId);
  await rateInBounds(cfg, deps);
  const o = withPaymaster(op, cfg.paymaster);
  const caps = await quoteCaps(o, cfg, deps);
  const sized: UserOp = {
    ...o,
    callGasLimit: o.callGasLimit || hex(caps.callGasLimit), verificationGasLimit: o.verificationGasLimit || hex(caps.verificationGasLimit),
    preVerificationGas: o.preVerificationGas || hex(caps.preVerificationGas),
    maxFeePerGas: o.maxFeePerGas || hex(clientFees(await deps.baseFee()).maxFeePerGas),
  };
  const debt = await deps.debtOf(op.sender);
  if (debt !== BigInt(0)) throw new PaymasterQuoteError("approve", "carried debt is not part of v5 credit");
  const maxTokenCost = requiredMaxTokenCost(sized, cfg.rate);
  const now = deps.now();
  const q: PaymasterQuote = { validUntil: now + ttl(cfg), validAfter: now - VALID_AFTER_SKEW_SEC, rate: cfg.rate, maxTokenCost };
  return {
    paymaster: cfg.paymaster, paymasterVerificationGasLimit: o.paymasterVerificationGasLimit!, paymasterPostOpGasLimit: o.paymasterPostOpGasLimit!,
    paymasterData: stubPaymasterData(q), isFinal: false,
    disciple: { usdg: cfg.usdg, rate: hex(cfg.rate), maxTokenCost: hex(maxTokenCost), debt: hex(debt), validUntil: q.validUntil, usdgDecimals: cfg.usdgDecimals },
  };
}

/** Phase 2 (pm_getPaymasterData): validate the final op and sign. */
export async function finalQuote(op: UserOp, entryPoint: string, chainId: string | number, cfg: QuoteConfig, deps: QuoteDeps): Promise<PaymasterFields> {
  checkTarget(entryPoint, chainId);
  if (op.paymaster && op.paymaster.toLowerCase() !== cfg.paymaster.toLowerCase()) throw new PaymasterQuoteError("op", `op names paymaster ${op.paymaster}, not ${cfg.paymaster}`);
  const o = withPaymaster(op, cfg.paymaster);
  // the deposit fronts the gas and the relayer is refunded from it: same fee floor + caps as self-pay ops
  try { checkOpGas(o, await deps.baseFee(), await quoteCaps(o, cfg, deps)); } catch (e) { if (e instanceof RelayPolicyError) throw new PaymasterQuoteError("gas", e.message); throw e; }
  const b = await rateInBounds(cfg, deps);

  const [debt, credit, reserved, used] = await Promise.all([
    deps.debtOf(o.sender), deps.balanceOf(o.sender), deps.reservedOf?.(o.sender) ?? Promise.resolve(BigInt(0)), deps.bootstrapUsed?.(o.sender) ?? Promise.resolve(false),
  ]);
  if (debt !== BigInt(0)) throw new PaymasterQuoteError("approve", "carried debt is not part of v5 credit");
  const available = credit > reserved ? credit - reserved : BigInt(0);
  const required = requiredMaxTokenCost(o, cfg.rate);
  const d = (x: bigint) => formatUsdg(x, cfg.usdgDecimals);
  const data = { required: hex(required), rate: hex(cfg.rate), debt: hex(debt), balance: hex(available) };
  const shape = classifyCreditCalldata(o.callData || "0x", o.sender, cfg.usdg, cfg.paymaster);
  if (shape.kind === "bad") throw new PaymasterQuoteError("approve", "credit call rejected", data);
  const launch = shape.kind === "normal" && isLaunchOp(o.callData || "", cfg.launchers ?? [], o.sender);
  const gasCap = launch ? b.maxLaunchGasPerOp : shape.kind === "funding" && available === BigInt(0) ? (b.maxGasPerOp > BigInt(3_200_000) ? BigInt(3_200_000) : b.maxGasPerOp) : b.maxGasPerOp;
  if (entryPointMaxCost(o) / BigInt(o.maxFeePerGas!) > gasCap) throw new PaymasterQuoteError("approve", "operation above paymaster gas-unit limit", data);
  if (shape.kind === "funding" && available === BigInt(0) && reserved === BigInt(0)) {
    if (used) throw new PaymasterQuoteError("balance", `not enough USDG: need ${d(required)}, have 0`, data);
    if (shape.amount < SETUP_DEPOSIT || shape.amount < required) throw new PaymasterQuoteError("approve", `setup deposit ${d(shape.amount)} below $2 or this op's max ${d(required)}`, data);
  } else if (available < required || (shape.kind === "withdraw" && reserved !== BigInt(0))) {
    throw new PaymasterQuoteError("balance", `not enough USDG: need ${d(required)}, have ${d(available)}`, data);
  }
  const maxTokenCost = required;

  const now = deps.now();
  const q: PaymasterQuote = { validUntil: now + ttl(cfg), validAfter: now - VALID_AFTER_SKEW_SEC, rate: cfg.rate, maxTokenCost };
  const sig = await deps.sign((launch ? paymasterLaunchQuoteHash : paymasterQuoteHash)(o, q, Number(chainId), cfg.paymaster));
  const paymasterData = encodePaymasterData(q, sig);
  if (size(paymasterData) !== PAYMASTER_DATA_LENGTH) throw new Error("paymasterData length mismatch");
  return { paymaster: cfg.paymaster, paymasterVerificationGasLimit: o.paymasterVerificationGasLimit!, paymasterPostOpGasLimit: o.paymasterPostOpGasLimit!, paymasterData };
}

export type AllowanceResult = PaymasterFields & {
  isFinal: true;
  disciple: {
    kind: "allowance"; sender: Address; usdg: Address; usdgDecimals: number; rate: Hex; maxTokenCost: Hex; debt: Hex;
    validUntil: number; validAfter: number;
    /** the envelope maxTokenCost was sized for: an op fits iff tokenCost(its maxCost) + debt ≤ maxTokenCost */
    maxFeePerGas: Hex; gas: Record<keyof typeof ALLOWANCE_GAS, Hex>;
  };
};

/**
 * pm_getPaymasterAllowance [sender, entryPoint, chainId] → signed per-sender allowance for the standard trade
 * envelope. Refuses (like the per-op flow) when the rate is out of bounds, the gas-unit envelope exceeds maxGasPerOp or the sender
 * can't hold it. Credit is the admission check; carried debt is refused.
 */
export async function allowanceQuote(sender: Address, entryPoint: string, chainId: string | number, cfg: QuoteConfig, deps: QuoteDeps): Promise<AllowanceResult> {
  checkTarget(entryPoint, chainId);
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(sender))) throw new PaymasterQuoteError("op", "sender must be an address");
  const b = await rateInBounds(cfg, deps);
  const maxFeePerGas = clientFees(await deps.baseFee()).maxFeePerGas * ALLOWANCE_FEE_MULT;
  const [debt, bal] = await Promise.all([deps.debtOf(sender), deps.balanceOf(sender)]);
  if (debt !== BigInt(0)) throw new PaymasterQuoteError("approve", "carried debt is not part of v5 credit");
  const maxTokenCost = tokenCost(entryPointMaxCost({ ...hexGas(), maxFeePerGas: hex(maxFeePerGas) }), cfg.rate);
  const d = (x: bigint) => formatUsdg(x, cfg.usdgDecimals);
  if (Object.values(ALLOWANCE_GAS).reduce((a, v) => a + v, BigInt(0)) > b.maxGasPerOp) throw new PaymasterQuoteError("approve", "trade envelope above paymaster gas-unit limit", { required: hex(maxTokenCost) });
  if (bal < maxTokenCost) throw new PaymasterQuoteError("balance", `not enough USDG: need ${d(maxTokenCost)}, have ${d(bal)}`, { required: hex(maxTokenCost), balance: hex(bal) });
  const now = deps.now();
  const life = Math.max(60, Math.min(cfg.allowanceTtlSec ?? DEFAULT_ALLOWANCE_TTL_SEC, MAX_QUOTE_WINDOW_SEC - VALID_AFTER_SKEW_SEC - 1));
  const q: PaymasterQuote = { validUntil: now + life, validAfter: now - VALID_AFTER_SKEW_SEC, rate: cfg.rate, maxTokenCost };
  const sig = await deps.sign(paymasterAllowanceHash(sender, q, Number(chainId), cfg.paymaster));
  const paymasterData = encodePaymasterData(q, sig);
  if (size(paymasterData) !== PAYMASTER_DATA_LENGTH) throw new Error("paymasterData length mismatch");
  return {
    paymaster: cfg.paymaster, paymasterVerificationGasLimit: hex(PAYMASTER_GAS.verificationGasLimit), paymasterPostOpGasLimit: hex(PAYMASTER_GAS.postOpGasLimit),
    paymasterData, isFinal: true,
    disciple: { kind: "allowance", sender, usdg: cfg.usdg, usdgDecimals: cfg.usdgDecimals, rate: hex(cfg.rate), maxTokenCost: hex(maxTokenCost), debt: hex(debt), validUntil: q.validUntil, validAfter: q.validAfter, maxFeePerGas: hex(maxFeePerGas), gas: hexGas() },
  };
}
function hexGas() {
  return Object.fromEntries(Object.entries(ALLOWANCE_GAS).map(([k, v]) => [k, hex(v)])) as Record<keyof typeof ALLOWANCE_GAS, Hex>;
}

function ttl(cfg: QuoteConfig) {
  const t = cfg.ttlSec ?? DEFAULT_QUOTE_TTL_SEC;
  return Math.max(30, Math.min(t, MAX_QUOTE_WINDOW_SEC - VALID_AFTER_SKEW_SEC - 1));
}

/**
 * Testnet rate from env: PAYMASTER_RATE (USDG base units per 1 ETH, integer) wins; else PAYMASTER_USD_PER_ETH
 * (decimal string, e.g. "3000" or "2950.5") scaled by the token's on-chain decimals. Never assumes 18 decimals.
 */
/**
 * Lee 2026-10-24 1:17 PM CT (testnet): "Reuse the site's existing login-signer key as the paymaster signer on testnet".
 * PAYMASTER_SIGNER_KEY wins when set (a malformed value fails closed; no silent fallback); when it is unset/empty the
 * login-attest key PVE_ATTESTER_PRIVATE_KEY is used, so the sensitive value never has to be copied between env vars.
 * Never the relayer or faucet key. Returns the key only to the in-process signer; never logged, never returned to clients.
 */
export function paymasterSignerKey(env: {
  PAYMASTER_SIGNER_KEY?: string; PVE_ATTESTER_PRIVATE_KEY?: string; RELAYER_PRIVATE_KEY?: string; DRIP_FAUCET_KEY?: string;
}): { key: Hex; source: "PAYMASTER_SIGNER_KEY" | "PVE_ATTESTER_PRIVATE_KEY" } {
  const own = (env.PAYMASTER_SIGNER_KEY || "").trim();
  const source = own ? "PAYMASTER_SIGNER_KEY" : "PVE_ATTESTER_PRIVATE_KEY";
  const k = own || (env.PVE_ATTESTER_PRIVATE_KEY || "").trim();
  if (!KEY32.test(k)) throw new PaymasterQuoteError("config", "paymaster signer not configured");
  const a = privateKeyToAccount(k as Hex).address;
  for (const other of [env.RELAYER_PRIVATE_KEY, env.DRIP_FAUCET_KEY]) {
    const o = (other || "").trim();
    if (KEY32.test(o) && privateKeyToAccount(o as Hex).address === a)
      throw new PaymasterQuoteError("config", "paymaster signer must be a dedicated key (not the relayer / faucet key)");
  }
  return { key: k as Hex, source };
}

/** Fail closed unless the local signer is DisciplePaymaster.signer() on chain (else every quote would revert on-chain). */
export function assertSignerMatches(local: Address, onchain: Address): void {
  if (local.toLowerCase() !== onchain.toLowerCase())
    throw new PaymasterQuoteError("config", "paymaster signer key does not match DisciplePaymaster.signer()");
}

export function rateFromEnv(env: { PAYMASTER_RATE?: string; PAYMASTER_USD_PER_ETH?: string }, usdgDecimals: number): bigint {
  if (env.PAYMASTER_RATE) {
    if (!/^\d+$/.test(env.PAYMASTER_RATE)) throw new PaymasterQuoteError("config", "PAYMASTER_RATE must be an integer (USDG base units per 1 ETH)");
    return BigInt(env.PAYMASTER_RATE);
  }
  const usd = env.PAYMASTER_USD_PER_ETH || "";
  const m = /^(\d+)(?:\.(\d+))?$/.exec(usd);
  if (!m) throw new PaymasterQuoteError("config", "set PAYMASTER_RATE or PAYMASTER_USD_PER_ETH");
  const frac = (m[2] || "").slice(0, usdgDecimals).padEnd(usdgDecimals, "0");
  return BigInt(m[1]) * BigInt(10) ** BigInt(usdgDecimals) + (usdgDecimals ? BigInt(frac || "0") : BigInt(0));
}

/** No gas markup: use the price-source rate unchanged (1.0x). */
export function unmarkedRate(baseRate: bigint): bigint { return baseRate; }
