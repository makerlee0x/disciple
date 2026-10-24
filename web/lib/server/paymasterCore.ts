/**
 * Quote rules for /api/paymaster (DisciplePaymaster, USDG token paymaster). Pure: every chain read and the signer are
 * injected (QuoteDeps), so scripts/test-paymaster.mts covers the rules without RPC or keys. lib/server/paymasterQuote
 * wires the real deps (env signer key, on-chain reads).
 *
 * Two-phase ERC-7677 flow:
 *  1. pm_getPaymasterStubData(op): fills the paymaster gas limits, reads the sender's carried debt and answers the
 *     rate + the exact maxTokenCost the op must approve, with a dummy-signature paymasterData of the final length.
 *  2. The client prepends usdg.approve(paymaster, maxTokenCost) as the FIRST inner call (session keys: policy 1.4.0
 *     requires exactly that amount), finalises gas/fees, then pm_getPaymasterData(op): the server re-derives every
 *     number from the op itself and signs only if the op is safe for the paymaster:
 *       - paymaster + gas limits are ours, fees/gas within lib/aa/gasPolicy (the deposit fronts the gas);
 *       - first inner call approves EXACTLY the signed maxTokenCost, which covers tokenCost(maxCost, rate) + debt and
 *         is at most MAX_SLACK above it and ≤ the on-chain maxCostCap;
 *       - the sender holds that much USDG; the rate is inside the contract's [minRate, maxRate].
 *     The signed hash binds callData (⇒ the approve amount), all gas limits and fees, chain and paymaster.
 * We never sponsor: the user's own USDG pays every op's gas (and any carried debt).
 */
import { size, type Address, type Hex } from "viem";
import { capsForOp, checkOpGas, clientFees, exceedsCaps, GAS_CAPS, RelayPolicyError, type GasCaps } from "../aa/gasPolicy";
import type { UserOp } from "../aa/core";
import { ENTRYPOINT_V07 } from "../aa/constants";
import {
  encodePaymasterData, firstCallApproveAmount, formatUsdg, MAX_QUOTE_WINDOW_SEC, PAYMASTER_DATA_LENGTH, PAYMASTER_GAS,
  paymasterQuoteHash, requiredMaxTokenCost, stubPaymasterData, type PaymasterQuote,
} from "../aa/paymaster";

export const PAYMASTER_CHAIN_ID = 46630; // RH testnet only
export const DEFAULT_QUOTE_TTL_SEC = 180;
/** Back-date validAfter a little so a quote is usable on a node whose clock is slightly behind ours. */
export const VALID_AFTER_SKEW_SEC = 30;
/** Max the client may approve above the required amount (basis points). The charge is actual gas either way. */
export const DEFAULT_MAX_SLACK_BPS = BigInt(5_000);

export class PaymasterQuoteError extends Error {
  constructor(public code: "config" | "chain" | "entrypoint" | "op" | "gas" | "approve" | "balance" | "rate", msg: string, public data?: Record<string, string>) { super(msg); }
}

export type QuoteConfig = {
  paymaster: Address; usdg: Address; usdgDecimals: number; rate: bigint;
  ttlSec?: number; maxSlackBps?: bigint;
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
  debtOf(sender: Address): Promise<bigint>;
  balanceOf(sender: Address): Promise<bigint>;
  bounds(): Promise<{ minRate: bigint; maxRate: bigint; maxCostCap: bigint }>;
  baseFee(): Promise<bigint>;
  /** EIP-191 personal_sign of the raw 32-byte hash with PAYMASTER_SIGNER_KEY. */
  sign(hash: Hex): Promise<Hex>;
  /** On-chain graduating-buy check (lib/server/gradBuy isGradBuyOp: last call, sender balance + allowance); absent ⇒ never GRAD_GAS_CAPS. */
  isGradBuy?(callData: string, sender: string): Promise<boolean>;
};
export type PaymasterFields = {
  paymaster: Address; paymasterVerificationGasLimit: Hex; paymasterPostOpGasLimit: Hex; paymasterData: Hex;
};
export type StubResult = PaymasterFields & { isFinal: false; disciple: { usdg: Address; rate: Hex; maxTokenCost: Hex; debt: Hex; validUntil: number; usdgDecimals: number } };

const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}` as Hex;

function checkTarget(entryPoint: string, chainId: string | number) {
  if (String(entryPoint).toLowerCase() !== ENTRYPOINT_V07.toLowerCase()) throw new PaymasterQuoteError("entrypoint", `unsupported entryPoint ${entryPoint} (v0.7 only)`);
  if (Number(chainId) !== PAYMASTER_CHAIN_ID) throw new PaymasterQuoteError("chain", `unsupported chain ${Number(chainId)} (RH testnet ${PAYMASTER_CHAIN_ID} only)`);
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
  const maxTokenCost = requiredMaxTokenCost(sized, cfg.rate, debt);
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

  const amount = firstCallApproveAmount(o.callData, cfg.usdg, cfg.paymaster);
  const debt = await deps.debtOf(o.sender);
  const required = requiredMaxTokenCost(o, cfg.rate, debt);
  const d = (x: bigint) => formatUsdg(x, cfg.usdgDecimals);
  const data = { required: hex(required), rate: hex(cfg.rate), debt: hex(debt) };
  if (amount === null) throw new PaymasterQuoteError("approve", `first call must be USDG approve(paymaster, ${required}) (exact gas allowance)`, data);
  if (amount < required) throw new PaymasterQuoteError("approve", `USDG gas allowance ${d(amount)} below required ${d(required)} — re-quote`, data);
  const slack = cfg.maxSlackBps ?? DEFAULT_MAX_SLACK_BPS;
  if (amount > required + (required * slack) / BigInt(10_000)) throw new PaymasterQuoteError("approve", `USDG gas allowance ${d(amount)} too far above required ${d(required)}`, data);
  if (amount > b.maxCostCap) throw new PaymasterQuoteError("approve", `USDG gas allowance ${d(amount)} above the paymaster cap ${d(b.maxCostCap)} (lower gas limits / fees)`, data);
  const bal = await deps.balanceOf(o.sender);
  if (bal < amount) throw new PaymasterQuoteError("balance", `not enough USDG: need ${d(amount)}, have ${d(bal)}`, { ...data, balance: hex(bal) });

  const now = deps.now();
  const q: PaymasterQuote = { validUntil: now + ttl(cfg), validAfter: now - VALID_AFTER_SKEW_SEC, rate: cfg.rate, maxTokenCost: amount };
  const sig = await deps.sign(paymasterQuoteHash(o, q, PAYMASTER_CHAIN_ID, cfg.paymaster));
  const paymasterData = encodePaymasterData(q, sig);
  if (size(paymasterData) !== PAYMASTER_DATA_LENGTH) throw new Error("paymasterData length mismatch");
  return { paymaster: cfg.paymaster, paymasterVerificationGasLimit: o.paymasterVerificationGasLimit!, paymasterPostOpGasLimit: o.paymasterPostOpGasLimit!, paymasterData };
}

function ttl(cfg: QuoteConfig) {
  const t = cfg.ttlSec ?? DEFAULT_QUOTE_TTL_SEC;
  return Math.max(30, Math.min(t, MAX_QUOTE_WINDOW_SEC - VALID_AFTER_SKEW_SEC - 1));
}

/**
 * Testnet rate from env: PAYMASTER_RATE (USDG base units per 1 ETH, integer) wins; else PAYMASTER_USD_PER_ETH
 * (decimal string, e.g. "3000" or "2950.5") scaled by the token's on-chain decimals. Never assumes 18 decimals.
 */
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
