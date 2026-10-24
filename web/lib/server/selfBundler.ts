import "server-only";
/**
 * Minimal ERC-4337 v0.7 bundler for RH testnet, used by /api/bundler when Alchemy rejects the key
 * (or AA_SELF_BUNDLER=1). The relayer (RELAYER_PRIVATE_KEY; DRIP_FAUCET_KEY fallback outside production only) submits EntryPoint.handleOps and
 * is refunded by the EntryPoint from the account's prefund at the op's gas price. lib/aa/gasPolicy enforces that the
 * op's fees cover the relayer's price and caps its gas, so it is cost-neutral apart from failed sims (we eth_call first).
 * Stateless (serverless-safe): receipts come from EntryPoint UserOperationEvent logs.
 */
import { BaseError, concat, createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http, numberToHex, pad, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { relayerKey, withRelayer } from "./relayer";
import { checkOpGas, relayerTxFees, RelayPolicyError } from "../aa/gasPolicy";
import { chainGradReads, relayCaps } from "./gradBuy";
import { launchTargets } from "../aa/launchTargets";
import { checkPaymaster, maxPrefund, relayerPrice } from "../aa/gasPolicy";
import { allowedPaymaster, debitPaymasterDeposit, paymasterDepositCached } from "./paymasterDeposit";
import { robinhoodTestnet } from "../chains";
import { userOpHash, type UserOp } from "../aa/core";
import { ENTRYPOINT_V07, LIGHT_ACCOUNT_V2_FACTORY, MAV2_FACTORY } from "../aa/constants";

const epAbi = parseAbi([
  "struct P { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(P[] ops, address beneficiary)",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);
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

export async function selfBundle(method: string, params: unknown[]): Promise<unknown> {
  switch (method) {
    case "eth_chainId": return numberToHex(robinhoodTestnet.id);
    case "disciple_sendUserOperationSync": { const { sendUserOperationSync } = await import("./fastRelay"); return sendUserOperationSync(params[0] as UserOp); }
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
    case "eth_sendUserOperation": {
      const key = relayerKey(); // production: throws RelayerNotConfiguredError (→ 503) unless a dedicated relayer key is set
      const op = params[0] as UserOp;
      const relayer = privateKeyToAccount(key);
      // W-1: the op must pay at least the relayer's gas price, within the gas caps (else the relayer subsidises it)
      const base = (await pc.getBlock()).baseFeePerGas ?? BigInt(0);
      try { checkOpGas(op, base, await relayCaps(op, launchTargets(robinhoodTestnet.id), chainGradReads(pc as never, robinhoodTestnet.id, { paymaster: allowedPaymaster() }))); } catch (e) { if (e instanceof RelayPolicyError) throw new BundlerRpcError(e.message); throw e; }
      // USDG-gas op: the prefund comes from OUR paymaster's deposit (the sender holds no ETH; launches up to 11M gas)
      if (op.paymaster) { try { const pm = allowedPaymaster(); checkPaymaster(op, pm, pm ? await paymasterDepositCached(pm) : BigInt(0), base); } catch (e) { if (e instanceof RelayPolicyError) { console.warn("[selfBundler] paymaster check:", e.detail ?? e.message); throw new BundlerRpcError(e.message); } throw e; } }
      const data = encodeFunctionData({ abi: epAbi, functionName: "handleOps", args: [[pack(op)], relayer.address] });
      await pc.call({ account: relayer.address, to: ENTRYPOINT_V07, data }); // revert ⇒ reject before spending relayer gas
      const estimated = await pc.estimateGas({ account: relayer.address, to: ENTRYPOINT_V07, data });
      const gas = estimated * BigInt(12) / BigInt(10) + BigInt(50000);
      // one relayer send at a time (+ nonce retry): concurrent ops otherwise reuse the relayer's pending nonce
      let relayerNonce: number | undefined;
      const hash = await withRelayer(async () => {
        const wc = createWalletClient({ chain: robinhoodTestnet, transport: http(), account: relayer });
        // never above the op's own fees ⇒ the EntryPoint refund (at the op's price) covers the relayer's cost per gas
        const fees = relayerTxFees(op, base);
        const { sendWithRelayerNonce } = await import("./fastRelay");
        return sendWithRelayerNonce((nonce) => { relayerNonce = nonce; return wc.sendTransaction({ to: ENTRYPOINT_V07, data, gas, nonce, ...fees }); });
      });
      const receipt = await pc.waitForTransactionReceipt({ hash, timeout: 25000 }).catch(() => null);
      // first op of an account (deploy / test funds) went the slow, simulated path: trust it now so its first TRADE
      // can skip simulation (anti-grief entry in fastRelay; one balance read, off the trade path)
      if (op.paymaster) debitPaymasterDeposit(op.paymaster, maxPrefund(op, relayerPrice(base)));
      if (receipt?.status === "success") { const { primeSenderNow } = await import("./fastRelay"); await primeSenderNow(op.sender, { simulated: true }).catch(() => undefined); }
      // unclear, never a failure: the tx may still land (relayTypes RelayErrorData.unclear)
      if (!receipt) throw Object.assign(new Error(`relayer tx ${hash} not confirmed (timeout)`), { txHash: hash, userOpHash: userOpHash(op, robinhoodTestnet.id), relayNonce: relayerNonce, unclear: true, reason: "receipt-timeout" });
      if (receipt.status !== "success") throw new Error(`relayer tx ${hash} reverted`);
      return userOpHash(op, robinhoodTestnet.id);
    }
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
