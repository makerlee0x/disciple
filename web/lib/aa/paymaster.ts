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
 * The op's FIRST inner call must be usdg.approve(paymaster, maxTokenCost) (exact amount: DiscipleSessionPolicy 1.4.0
 * only lets session keys approve the paymaster for exactly the signed maxTokenCost, and counts it against the cap).
 */
import { concat, decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, pad, parseAbi, parseAbiParameters, size, slice, toHex, type Address, type Hex } from "viem";
import type { Call, UserOp } from "./core";

export const PAYMASTER_DATA_LENGTH = 141; // paymasterData (after the 52-byte paymaster + gas limits prefix)
export const PAYMASTER_AND_DATA_LENGTH = 193;
export const MAX_QUOTE_WINDOW_SEC = 3600;
/** Gas limits the server signs; must stay ≤ lib/aa/gasPolicy GAS_CAPS.paymaster*. postOp is a single transferFrom. */
export const PAYMASTER_GAS = {
  verificationGasLimit: BigInt(120_000), // measured ≈ 45–60k (ecrecover + balanceOf + allowance/calldata walk)
  postOpGasLimit: BigInt(80_000),        // measured ≈ 30–45k (transferFrom + event); contract's flat postOpGas = 30k
} as const;

export const disciplePaymasterAbi = parseAbi([
  "function debtOf(address) view returns (uint256)",
  "function signer() view returns (address)",
  "function treasury() view returns (address)",
  "function usdg() view returns (address)",
  "function minRate() view returns (uint256)",
  "function maxRate() view returns (uint256)",
  "function maxCostCap() view returns (uint256)",
  "function postOpGas() view returns (uint256)",
  "function getDeposit() view returns (uint256)",
  "function deposit() payable",
  "event UserOperationCharged(bytes32 indexed userOpHash, address indexed sender, uint256 gasCostToken, uint256 debtRepaid, uint256 rate)",
  "event DebtRecorded(bytes32 indexed userOpHash, address indexed sender, uint256 amount, uint256 totalDebt)",
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
export function requiredMaxTokenCost(op: Parameters<typeof entryPointMaxCost>[0], rate: bigint, debt: bigint = BigInt(0)): bigint {
  return tokenCost(entryPointMaxCost(op), rate) + debt;
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

/** DisciplePaymaster.getHash — the signer personal_signs (EIP-191) this 32-byte hash. */
export function paymasterQuoteHash(op: UserOp, q: PaymasterQuote, chainId: number, paymaster: Address): Hex {
  const initCode = op.factory ? concat([op.factory, op.factoryData || "0x"]) : "0x";
  const accountGasLimits = concat([p16(op.verificationGasLimit), p16(op.callGasLimit)]);
  const pmGas = concat([p16(op.paymasterVerificationGasLimit), p16(op.paymasterPostOpGasLimit)]);
  const gasFees = concat([p16(op.maxPriorityFeePerGas), p16(op.maxFeePerGas)]);
  const opPart = keccak256(encodeAbiParameters(
    parseAbiParameters("address, uint256, bytes32, bytes32, bytes32, bytes32, uint256, bytes32"),
    [op.sender, big(op.nonce), keccak256(initCode), keccak256(op.callData), accountGasLimits, pmGas, big(op.preVerificationGas), gasFees],
  ));
  return keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32, uint256, address, uint48, uint48, uint256, uint256"),
    [opPart, BigInt(chainId), paymaster, q.validUntil, q.validAfter, q.rate, q.maxTokenCost],
  ));
}

/** The exact-amount approve that must be the op's first inner call. */
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

/** Human USDG amount (for "not enough USDG for gas" messages) — decimals-aware, never hard-codes 1e18. */
export function formatUsdg(amount: bigint, decimals: number, dp = 4): string {
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).slice(0, dp).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
