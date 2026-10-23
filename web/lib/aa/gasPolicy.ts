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
import { decodeFunctionData, parseAbi, toFunctionSelector, type AbiFunction, type AbiItem, type Hex } from "viem";
import { anonLauncherAbi } from "../abi/AnonLauncher";
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
 * Launch ops only (Launchpad launch / AnonLauncher launchAnon, plus their approvals): a launch deploys the token +
 * curve and seeds state ≈ 6.06M execution gas, ≈ 7.9M after the self-bundler's 1.3x + 20k estimate padding, which
 * GAS_CAPS (3M / 4M) rejected as "above cap" ⇒ "simulation failed". Every other op keeps the W-1 caps above.
 */
export const LAUNCH_GAS_CAPS = {
  ...GAS_CAPS,
  callGasLimit: BigInt(10_000_000),
  total: BigInt(11_000_000),
} as const;
export type GasCaps = { [K in keyof typeof GAS_CAPS]: bigint };

const LAUNCH_SELECTORS = new Set(
  ([...launchpadAbi, ...anonLauncherAbi] as readonly AbiItem[])
    .filter((f): f is AbiFunction => f.type === "function" && ["launch", "launchCoin", "launchWithMode", "launchAnon"].includes(f.name))
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
export function accountCalls(callData: string): { to: string; data: string }[] | null {
  let cd = (callData || "0x").toLowerCase() as Hex;
  if (cd.startsWith(EXECUTE_USER_OP)) cd = ("0x" + cd.slice(10)) as Hex;
  try {
    const d = decodeFunctionData({ abi: accountAbi, data: cd });
    if (d.functionName === "execute") { const [to, , data] = d.args as readonly [string, bigint, string]; return [{ to, data }]; }
    return (d.args[0] as readonly { target: string; data: string }[]).map((c) => ({ to: c.target, data: c.data }));
  } catch { return null; }
}
/**
 * Is this op a launch? Every inner call must be an approve / LoginGate.attest or a launch selector, at least one launch, and every launch
 * must target one of `launchers` (Launchpad, AnonLauncher v2). Anything else (or an undecodable callData) ⇒ false ⇒
 * normal GAS_CAPS. Selectors come from the generated Launchpad / AnonLauncher ABIs.
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

/** Caps for an op: LAUNCH_GAS_CAPS when it is a launch to one of `launchers`, else the W-1 GAS_CAPS. */
export const capsForOp = (op: { callData?: string }, launchers: string[]): GasCaps =>
  op.callData && isLaunchOp(op.callData, launchers) ? LAUNCH_GAS_CAPS : GAS_CAPS;

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

export class RelayPolicyError extends Error {
  constructor(msg: string, public code: "fee" | "gas") { super(msg); }
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
