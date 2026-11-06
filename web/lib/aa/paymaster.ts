/**
 * DisciplePaymaster (contracts/src/paymaster/DisciplePaymaster.sol) — USDG token paymaster, EntryPoint v0.7.
 * Users never hold ETH: the paymaster's EntryPoint deposit pays gas and postOp bills the account in USDG at a
 * signed rate. Pure (no RPC, no server-only): shared by /api/paymaster (signs) and the op builders (client), and
 * unit-tested by scripts/test-paymaster.mts. Mirrors the contract byte-for-byte; keep them in sync.
 *
 * paymasterAndData (193 bytes):
 *   paymaster(20) | pmVerificationGas(16) | pmPostOpGas(16) | validUntil(6) | validAfter(6) | rate(32) | maxTokenCost(32) | sig(65)
 * In the v0.7 UserOp JSON the first 52 bytes are the separate `paymaster`, `paymasterVerificationGasLimit` and
 * `paymasterPostOpGasLimit` fields; `paymasterData` = the remaining 141 bytes.
 *
 * rate = USDG base units per 1 ETH (1e18 wei). Decimals-aware by construction: 18-dec testnet USDG at $3000/ETH is
 * 3000e18, 6-dec mainnet USDG is 3000e6. tokenCost(wei) = ceil(wei * rate / 1e18).
 *
 * v5 admits an op from the player's own gas credit (creditOf - reservedOf). Validation never calls the token.
 * A zero-credit account may run one setup op: approve(paymaster, amount) + deposit(account, amount).
 */
import { concat, decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, pad, parseAbi, parseAbiParameters, size, slice, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import type { Call, UserOp } from "./core";
import { GAS_CAPS } from "./gasPolicy";

export const PAYMASTER_DATA_LENGTH = 141; // paymasterData (after the 52-byte paymaster + gas limits prefix)
export const PAYMASTER_AND_DATA_LENGTH = 193;
export const MAX_QUOTE_WINDOW_SEC = 3600;
/** Gas limits the server signs; must stay ≤ lib/aa/gasPolicy GAS_CAPS.paymaster*. Validation precharges; postOp settles/refunds. */
export const PAYMASTER_GAS = {
  verificationGasLimit: BigInt(250_000), // ecrecover + own-storage credit check (no token call)
  postOpGasLimit: BigInt(160_000),       // measured postOp floor is 150_000; withdraw settles two transfers
} as const;
/** Default first-time gas credit. 6-decimal USDG, $2. */
export const SETUP_DEPOSIT = BigInt(2_000_000);

export const disciplePaymasterAbi = parseAbi([
  "function PREPAY_VERSION() view returns (uint256)",
  "function paused() view returns (bool)",
  "function signer() view returns (address)",
  "function treasury() view returns (address)",
  "function usdg() view returns (address)",
  "function minRate() view returns (uint256)",
  "function maxRate() view returns (uint256)",
  "function maxLaunchGasPerOp() view returns (uint256)",
  "function maxGasPerOp() view returns (uint256)",
  "function postOpGas() view returns (uint256)",
  "function getDeposit() view returns (uint256)",
  "function reservedOf(address) view returns (uint256)",
  "function owedOf(address) view returns (uint256)",
  "function creditOf(address) view returns (uint256)",
  "function availableCredit(address) view returns (uint256)",
  "function bootstrapUsed(address) view returns (bool)",
  "function withdrawPending(address) view returns (bool)",
  "function claimOf(address) view returns (uint256)",
  "function SETUP_DEPOSIT() view returns (uint256)",
  "function maxBootstrapGasPerOp() view returns (uint256)",
  "function deposit(address,uint256)",
  "function release(uint256)",
  "function withdraw()",
  "function getHash(address sender, uint48 validUntil, uint48 validAfter, uint256 rate, uint256 maxTokenCost) view returns (bytes32)",
  "function deposit() payable",
  "event UserOperationCharged(bytes32 indexed userOpHash, address indexed sender, uint256 gasCostToken, uint256 debtRepaid, uint256 rate)",
]);
const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const execAbi = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "struct Call { address target; uint256 value; bytes data; }",
  "function executeBatch(Call[] calls)",
]);
const EXECUTE_USER_OP = "0x8dd7712f";

export type PaymasterQuote = { validUntil: number; validAfter: number; rate: bigint; maxTokenCost: bigint };

const big = (x?: Hex | string | bigint) => (x === undefined || x === "" ? BigInt(0) : BigInt(x));
const p16 = (x?: Hex | bigint | string) => pad(toHex(big(x as Hex)), { size: 16 });

/** ceil(wei * rate / 1e18) — same rounding (up) as DisciplePaymaster.tokenCost. */
export function tokenCost(weiAmount: bigint, rate: bigint): bigint {
  const E = BigInt(10) ** BigInt(18);
  return (weiAmount * rate + E - BigInt(1)) / E;
}

/** What the EntryPoint passes as `maxCost` to validatePaymasterUserOp: every gas limit × maxFeePerGas. */
export function entryPointMaxCost(op: Pick<UserOp, "callGasLimit" | "verificationGasLimit" | "preVerificationGas" | "maxFeePerGas" | "paymasterVerificationGasLimit" | "paymasterPostOpGasLimit">): bigint {
  const g = big(op.callGasLimit) + big(op.verificationGasLimit) + big(op.preVerificationGas) + big(op.paymasterVerificationGasLimit) + big(op.paymasterPostOpGasLimit);
  return g * big(op.maxFeePerGas);
}

/** Minimum maxTokenCost the contract accepts for this op: tokenCost(maxCost, rate) + the sender's carried debt. */
export function requiredMaxTokenCost(op: Parameters<typeof entryPointMaxCost>[0], rate: bigint, _debt: bigint = BigInt(0)): bigint {
  return tokenCost(entryPointMaxCost(op), rate);
}

export function encodePaymasterData(q: PaymasterQuote, signature: Hex): Hex {
  if (size(signature) !== 65) throw new Error("paymaster signature must be 65 bytes");
  return concat([pad(toHex(q.validUntil), { size: 6 }), pad(toHex(q.validAfter), { size: 6 }), pad(toHex(q.rate), { size: 32 }), pad(toHex(q.maxTokenCost), { size: 32 }), signature]);
}

/** Stub paymasterData (dummy 65-byte sig) for gas estimation: same length, so calldata gas matches the final op. */
export function stubPaymasterData(q: PaymasterQuote): Hex {
  return encodePaymasterData(q, `0x${"ff".repeat(32)}${"ff".repeat(32)}1c` as Hex);
}

export function decodePaymasterData(data: Hex): PaymasterQuote & { signature: Hex } {
  if (size(data) !== PAYMASTER_DATA_LENGTH) throw new Error(`paymasterData must be ${PAYMASTER_DATA_LENGTH} bytes`);
  return {
    validUntil: Number(BigInt(slice(data, 0, 6))), validAfter: Number(BigInt(slice(data, 6, 12))),
    rate: BigInt(slice(data, 12, 44)), maxTokenCost: BigInt(slice(data, 44, 76)), signature: slice(data, 76, 141),
  };
}

/** keccak256("DisciplePaymaster.Allowance(v1)") — DisciplePaymaster.ALLOWANCE_TYPEHASH. */
export const ALLOWANCE_TYPEHASH = keccak256(toHex("DisciplePaymaster.Allowance(v1)"));
/** DisciplePaymaster.MIN_PM_POST_OP_GAS_LIMIT: the contract refuses an op whose paymasterPostOpGasLimit is lower. */
export const MIN_PM_POST_OP_GAS_LIMIT = PAYMASTER_GAS.postOpGasLimit;

/**
 * DisciplePaymaster.getHash(sender, validUntil, validAfter, rate, maxTokenCost) — the per-sender ALLOWANCE the signer
 * personal_signs (EIP-191). Not bound to one op: any op of `sender` inside [validAfter, validUntil] on this chain +
 * paymaster may reuse it; every per-op rule is enforced on-chain in validatePaymasterUserOp.
 */
export function paymasterAllowanceHash(sender: Address, q: PaymasterQuote, chainId: number, paymaster: Address): Hex {
  return keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32, address, uint256, address, uint48, uint48, uint256, uint256"),
    [ALLOWANCE_TYPEHASH, sender, BigInt(chainId), paymaster, q.validUntil, q.validAfter, q.rate, q.maxTokenCost],
  ));
}
/** keccak256("DisciplePaymaster.OpQuote(v1)") — DisciplePaymaster.OP_QUOTE_TYPEHASH. */
export const OP_QUOTE_TYPEHASH = keccak256(toHex("DisciplePaymaster.OpQuote(v1)"));
/**
 * DisciplePaymaster.getOpHash(op, …) — the per-op quote (pm_getPaymasterData) is bound to ONE exact userOp: sender,
 * nonce, initCode, callData (incl. the approve amount), account gas limits, the paymaster gas limits, PVG and fees.
 * Single use (nonce), so a large per-op maxTokenCost (launch / graduating buy) can't be reused as an allowance
 * (AUDIT #141 L-2). Only pm_getPaymasterAllowance issues the reusable, sender-bound hash above.
 */
export const LAUNCH_QUOTE_TYPEHASH = keccak256(toHex("DisciplePaymaster.LaunchQuote(v1)"));
export const paymasterLaunchQuoteHash = (op: UserOp, q: PaymasterQuote, chainId: number, paymaster: Address) =>
  paymasterQuoteHash(op, q, chainId, paymaster, LAUNCH_QUOTE_TYPEHASH);
export function paymasterQuoteHash(op: UserOp, q: PaymasterQuote, chainId: number, paymaster: Address, domain: Hex = OP_QUOTE_TYPEHASH): Hex {
  const initCode = op.factory ? concat([op.factory, op.factoryData || "0x"]) : "0x";
  const accountGasLimits = concat([p16(op.verificationGasLimit), p16(op.callGasLimit)]);
  const pmGas = concat([p16(op.paymasterVerificationGasLimit), p16(op.paymasterPostOpGasLimit)]);
  const gasFees = concat([p16(op.maxPriorityFeePerGas), p16(op.maxFeePerGas)]);
  const opPart = keccak256(encodeAbiParameters(
    parseAbiParameters("address, uint256, bytes32, bytes32, bytes32, bytes32, uint256, bytes32"),
    [op.sender, big(op.nonce), keccak256(initCode), keccak256(op.callData), accountGasLimits, pmGas, big(op.preVerificationGas), gasFees],
  ));
  return keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32, bytes32, uint256, address, uint48, uint48, uint256, uint256"),
    [domain, opPart, BigInt(chainId), paymaster, q.validUntil, q.validAfter, q.rate, q.maxTokenCost],
  ));
}

/**
 * Gas envelope one pre-issued allowance covers: STATIC_GAS-sized trade (deployed account, session or owner) + the
 * paymaster's own limits. Reserve the existing PVG field cap (not a submitted gas limit), so buffered PVG does
 * not make every warm tap outgrow its standing allowance. Ops above it (launches, graduating buys, cold estimates) use the per-op pm_* flow.
 */
export const ALLOWANCE_GAS = {
  callGasLimit: BigInt(1_800_000), verificationGasLimit: BigInt(350_000), preVerificationGas: GAS_CAPS.preVerificationGas,
  paymasterVerificationGasLimit: PAYMASTER_GAS.verificationGasLimit, paymasterPostOpGasLimit: PAYMASTER_GAS.postOpGasLimit,
} as const;

/** First-call gas accounting marker; accepts either the quote amount or a persistent maximum allowance. */
export function paymasterApproveCall(usdg: Address, paymaster: Address, maxTokenCost: bigint): Call {
  return { to: usdg, value: BigInt(0), data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [paymaster, maxTokenCost] }) };
}

/**
 * The amount of the op's first inner call if it is usdg.approve(paymaster, amount), else null. Accepts execute /
 * executeBatch with or without the executeUserOp prefix (same shapes as DisciplePaymaster.firstCallApproves).
 */
export function firstCallApproveAmount(callData: Hex, usdg: Address, paymaster: Address): bigint | null {
  let cd = callData;
  if (cd.slice(0, 10).toLowerCase() === EXECUTE_USER_OP) cd = `0x${cd.slice(10)}` as Hex;
  try {
    const d = decodeFunctionData({ abi: execAbi, data: cd });
    const first = d.functionName === "execute"
      ? { target: d.args[0], value: d.args[1], data: d.args[2] }
      : (d.args[0] as readonly { target: Address; value: bigint; data: Hex }[])[0];
    if (!first || first.target.toLowerCase() !== usdg.toLowerCase() || first.value !== BigInt(0)) return null;
    const a = decodeFunctionData({ abi: erc20Abi, data: first.data });
    if (a.functionName !== "approve" || a.args[0].toLowerCase() !== paymaster.toLowerCase()) return null;
    return a.args[1];
  } catch { return null; }
}

const UINT_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);
const DEPOSIT_SEL = toFunctionSelector("deposit(address,uint256)").toLowerCase();
const WITHDRAW_SEL = toFunctionSelector("withdraw()").toLowerCase();
const APPROVE_SEL = toFunctionSelector("approve(address,uint256)").toLowerCase();
const INSTALL_SEL = toFunctionSelector("installValidation(bytes25,bytes4[],bytes,bytes[])").toLowerCase();

export type CreditShape =
  | { kind: "normal" }
  | { kind: "withdraw" }
  | { kind: "funding"; amount: bigint }
  | { kind: "bad" };

function innerCalls(callData: Hex): { target: Address; value: bigint; data: Hex }[] | null {
  let cd = callData;
  if (cd.slice(0, 10).toLowerCase() === EXECUTE_USER_OP) cd = `0x${cd.slice(10)}` as Hex;
  try {
    const d = decodeFunctionData({ abi: execAbi, data: cd });
    if (d.functionName === "execute") return [{ target: d.args[0], value: d.args[1], data: d.args[2] }];
    return [...(d.args[0] as readonly { target: Address; value: bigint; data: Hex }[])];
  } catch { return null; }
}

/**
 * Same shapes DisciplePaymasterV5 admits. `funding` is an exact approve+deposit (optional self install).
 * `bad` is a credit call the contract rejects (MAX, mismatch, mixed withdraw, wrong token).
 */
export function classifyCreditCalldata(callData: Hex, sender: Address, usdg: Address, paymaster: Address): CreditShape {
  const calls = innerCalls(callData || "0x");
  if (!calls) return { kind: "normal" };
  let approve = BigInt(0), deposit = BigInt(0), deposits = 0, withdraws = 0, other = false;
  for (const c of calls) {
    if (c.value !== BigInt(0)) { other = true; continue; }
    const sel = c.data.slice(0, 10).toLowerCase();
    const to = c.target.toLowerCase();
    if (sel === APPROVE_SEL && to === usdg.toLowerCase()) {
      if (size(c.data) !== 68) return { kind: "bad" };
      const spender = `0x${c.data.slice(34, 74)}`.toLowerCase();
      const amount = BigInt(`0x${c.data.slice(74, 138)}`);
      if (spender !== paymaster.toLowerCase()) { other = true; continue; }
      if (amount === BigInt(0)) continue;
      if (amount === UINT_MAX || approve !== BigInt(0)) return { kind: "bad" };
      approve = amount;
    } else if (sel === DEPOSIT_SEL && to === paymaster.toLowerCase()) {
      if (size(c.data) !== 68) return { kind: "bad" };
      const who = `0x${c.data.slice(34, 74)}`.toLowerCase();
      const amount = BigInt(`0x${c.data.slice(74, 138)}`);
      if (who !== sender.toLowerCase() || amount === BigInt(0) || amount === UINT_MAX) return { kind: "bad" };
      deposits++; deposit += amount;
    } else if (sel === WITHDRAW_SEL && to === paymaster.toLowerCase()) {
      if (size(c.data) !== 4) return { kind: "bad" };
      withdraws++;
    } else if (!(sel === INSTALL_SEL && to === sender.toLowerCase())) other = true;
  }
  if (withdraws > 0) return withdraws === 1 && approve === BigInt(0) && deposits === 0 && !other ? { kind: "withdraw" } : { kind: "bad" };
  if (approve !== BigInt(0) || deposits !== 0) {
    if (deposits !== 1 || approve !== deposit) return { kind: "bad" };
    // A top-up beside a trade is an ordinary op: this op's reservation still comes from existing credit.
    return other ? { kind: "normal" } : { kind: "funding", amount: deposit };
  }
  return { kind: "normal" };
}

/** Human USDG amount (for "not enough USDG" messages) — decimals-aware, never hard-codes 1e18. */
export function formatUsdg(amount: bigint, decimals: number, dp = 4): string {
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).slice(0, dp).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
