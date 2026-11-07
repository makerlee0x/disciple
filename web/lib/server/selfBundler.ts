import "server-only";
/** Historical local testnet packer/estimator/read helpers. Paid sends use only the authenticated sync path.
 * No automatic Alchemy rejection fallback; a simulation does not guarantee cost neutrality after state races.
 */
import { BaseError, concat, createPublicClient, decodeEventLog, encodeFunctionData, http, numberToHex, pad, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { robinhoodTestnet } from "../chains";
import { userOpHash, type UserOp } from "../aa/core";
import { ENTRYPOINT_V07, LIGHT_ACCOUNT_V2_FACTORY, MAV2_FACTORY } from "../aa/constants";
import { requireSelfBundlerMode } from "./relayLockdown";

const uoEvent = parseAbiItem("event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)");
const execUserOpAbi = parseAbi([
  "struct P { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function executeUserOp(P userOp, bytes32 userOpHash)",
]);
const EXECUTE_USER_OP = "0x8dd7712f";
const implAbi = parseAbi(["function ACCOUNT_IMPLEMENTATION() view returns (address)"]);
const mav2ImplAbi = parseAbi(["function SEMI_MODULAR_ACCOUNT_IMPL() view returns (address)"]);
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const p16 = (x?: Hex) => pad(x || "0x0", { size: 16 });
export const packUserOp = (op: UserOp) => ({
  ...packFields(op),
});
const packFields = (op: UserOp) => ({
  sender: op.sender, nonce: BigInt(op.nonce), initCode: op.factory ? concat([op.factory, op.factoryData!]) : ("0x" as Hex), callData: op.callData,
  accountGasLimits: concat([p16(op.verificationGasLimit), p16(op.callGasLimit)]), preVerificationGas: BigInt(op.preVerificationGas || "0x0"),
  gasFees: concat([p16(op.maxPriorityFeePerGas), p16(op.maxFeePerGas)]),
  paymasterAndData: op.paymaster ? concat([op.paymaster, p16(op.paymasterVerificationGasLimit), p16(op.paymasterPostOpGasLimit), op.paymasterData || "0x"]) : ("0x" as Hex),
  signature: op.signature,
});
const pack = packUserOp;
let implCode: Hex | undefined;
let mav2ImplCode: Hex | undefined;

/** Error carrying the inner call's revert data so /api/bundler can return it as JSON-RPC error.data (client decodes it). */
export class BundlerRpcError extends Error { constructor(msg: string, public data?: Hex) { super(msg); } }
function estimateError(e: unknown): BundlerRpcError {
  let data: Hex | undefined;
  if (e instanceof BaseError) e.walk((x) => { const d = (x as { data?: unknown }).data; if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) { data = d as Hex; return true; } return false; });
  const m = (e as { shortMessage?: string }).shortMessage || (e as Error).message || String(e);
  return new BundlerRpcError(`execution reverted in simulation${data ? ` (${data.slice(0, 10)})` : ""}: ${m.split("\n")[0].slice(0, 200)}`, data);
}

/** `o.beforeSend`: see fastRelay.sendUserOperationSync — awaited after validation (policy + simulation), before signing. */
export async function selfBundle(method: string, params: unknown[], o: { beforeSend?: () => Promise<void> } = {}): Promise<unknown> {
  requireSelfBundlerMode();
  switch (method) {
    case "eth_chainId": return numberToHex(robinhoodTestnet.id);
    case "disciple_sendUserOperationSync": { const { sendUserOperationSync } = await import("./fastRelay"); return sendUserOperationSync(params[0] as UserOp, undefined, o.beforeSend); }
    case "disciple_warm": { const { warmRelay } = await import("./fastRelay"); await warmRelay(typeof params[0] === "string" ? params[0] : undefined); return true; }
    case "eth_supportedEntryPoints": return [ENTRYPOINT_V07];
    case "rundler_maxPriorityFeePerGas": return "0xf4240"; // 0.001 gwei
    case "eth_estimateUserOperationGas": {
      const op = params[0] as UserOp;
      const code = await pc.getCode({ address: op.sender });
      let stateOverride;
      if (!code || code === "0x") {
        // not deployed yet: estimate execution against the account implementation code at the sender address
        const f = op.factory?.toLowerCase();
        if (!f) throw new BundlerRpcError(`account ${op.sender} is not deployed and the userOp has no factory/initCode`);
        if (f === MAV2_FACTORY.toLowerCase()) {
          if (!mav2ImplCode) mav2ImplCode = await pc.getCode({ address: await pc.readContract({ address: MAV2_FACTORY, abi: mav2ImplAbi, functionName: "SEMI_MODULAR_ACCOUNT_IMPL" }) });
          stateOverride = [{ address: op.sender, code: mav2ImplCode }];
        } else if (f === LIGHT_ACCOUNT_V2_FACTORY.toLowerCase()) {
          if (!implCode) implCode = await pc.getCode({ address: await pc.readContract({ address: LIGHT_ACCOUNT_V2_FACTORY, abi: implAbi, functionName: "ACCOUNT_IMPLEMENTATION" }) });
          stateOverride = [{ address: op.sender, code: implCode }];
        } else {
          throw new BundlerRpcError(`unsupported account factory ${op.factory} (self-bundler supports MAv2 and LightAccount v2)`);
        }
      }
      let g: bigint;
      // ERC-4337 v0.7: callData prefixed with executeUserOp ⇒ the EntryPoint calls account.executeUserOp(op, hash)
      // (MAv2 uses it when the validation has execution hooks, e.g. DiscipleSessionPolicy session keys).
      const data = op.callData.slice(0, 10).toLowerCase() === EXECUTE_USER_OP
        ? encodeFunctionData({ abi: execUserOpAbi, functionName: "executeUserOp", args: [pack({ ...op, signature: "0x" }), userOpHash({ ...op, callGasLimit: op.callGasLimit || "0x0", verificationGasLimit: op.verificationGasLimit || "0x0", preVerificationGas: op.preVerificationGas || "0x0", maxFeePerGas: op.maxFeePerGas || "0x0", maxPriorityFeePerGas: op.maxPriorityFeePerGas || "0x0" }, robinhoodTestnet.id)] })
        : op.callData;
      try { g = await pc.estimateGas({ account: ENTRYPOINT_V07, to: op.sender, data, stateOverride }); }
      catch (e) { throw estimateError(e); }
      return { callGasLimit: numberToHex(g * BigInt(13) / BigInt(10) + BigInt(20000)), verificationGasLimit: numberToHex(op.factory ? 450000 : 150000), preVerificationGas: numberToHex(60000) };
    }
    case "eth_sendUserOperation": throw new BundlerRpcError("use authenticated sync relay; legacy standard self-send disabled");
    case "eth_getUserOperationReceipt": {
      const h = params[0] as Hex;
      const latest = await pc.getBlockNumber();
      const logs = await pc.getLogs({ address: ENTRYPOINT_V07, event: uoEvent, args: { userOpHash: h }, fromBlock: latest > BigInt(20000) ? latest - BigInt(20000) : BigInt(0), toBlock: latest });
      if (!logs.length) return null;
      const l = logs[logs.length - 1];
      const rc = await pc.getTransactionReceipt({ hash: l.transactionHash! });
      const ev = decodeEventLog({ abi: [uoEvent], data: l.data, topics: l.topics });
      const a = ev.args as { success: boolean; actualGasCost: bigint; paymaster: Address };
      return {
        userOpHash: h, success: a.success, actualGasCost: numberToHex(a.actualGasCost), paymaster: a.paymaster,
        receipt: { transactionHash: rc.transactionHash, logs: rc.logs.map((x) => ({ address: x.address, data: x.data, topics: x.topics })) },
      };
    }
    default: throw new Error("method not supported");
  }
}
