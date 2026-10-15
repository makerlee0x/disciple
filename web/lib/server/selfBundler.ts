import "server-only";
/**
 * Minimal ERC-4337 v0.7 bundler for RH testnet, used by /api/bundler when Alchemy rejects the key
 * (or AA_SELF_BUNDLER=1). The relayer (DRIP_FAUCET_KEY) submits EntryPoint.handleOps and is refunded
 * by the EntryPoint from the account's prefund, so it is cost-neutral apart from failed sims (we eth_call first).
 * Stateless (serverless-safe): receipts come from EntryPoint UserOperationEvent logs.
 */
import { concat, createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http, numberToHex, pad, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodTestnet } from "../chains";
import { ENTRYPOINT_V07, LIGHT_ACCOUNT_V2_FACTORY, userOpHash, type UserOp } from "../aa/core";

const epAbi = parseAbi([
  "struct P { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(P[] ops, address beneficiary)",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);
const uoEvent = parseAbiItem("event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)");
const implAbi = parseAbi(["function ACCOUNT_IMPLEMENTATION() view returns (address)"]);
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const p16 = (x?: Hex) => pad(x || "0x0", { size: 16 });
const pack = (op: UserOp) => ({
  sender: op.sender, nonce: BigInt(op.nonce), initCode: op.factory ? concat([op.factory, op.factoryData!]) : ("0x" as Hex), callData: op.callData,
  accountGasLimits: concat([p16(op.verificationGasLimit), p16(op.callGasLimit)]), preVerificationGas: BigInt(op.preVerificationGas || "0x0"),
  gasFees: concat([p16(op.maxPriorityFeePerGas), p16(op.maxFeePerGas)]),
  paymasterAndData: op.paymaster ? concat([op.paymaster, p16(op.paymasterVerificationGasLimit), p16(op.paymasterPostOpGasLimit), op.paymasterData || "0x"]) : ("0x" as Hex),
  signature: op.signature,
});
let implCode: Hex | undefined;

export async function selfBundle(method: string, params: unknown[]): Promise<unknown> {
  switch (method) {
    case "eth_chainId": return numberToHex(robinhoodTestnet.id);
    case "eth_supportedEntryPoints": return [ENTRYPOINT_V07];
    case "rundler_maxPriorityFeePerGas": return "0x0";
    case "alchemy_requestGasAndPaymasterAndData": throw new Error("Gas sponsorship is not enabled for this app (self-bundler)");
    case "eth_estimateUserOperationGas": {
      const op = params[0] as UserOp;
      const code = await pc.getCode({ address: op.sender });
      let stateOverride;
      if (!code || code === "0x") {
        // not deployed yet: estimate execution against the LightAccount implementation code at the sender address
        if (!implCode) implCode = await pc.getCode({ address: await pc.readContract({ address: LIGHT_ACCOUNT_V2_FACTORY, abi: implAbi, functionName: "ACCOUNT_IMPLEMENTATION" }) });
        stateOverride = [{ address: op.sender, code: implCode }];
      }
      const g = await pc.estimateGas({ account: ENTRYPOINT_V07, to: op.sender, data: op.callData, stateOverride });
      return { callGasLimit: numberToHex(g * BigInt(13) / BigInt(10) + BigInt(20000)), verificationGasLimit: numberToHex(op.factory ? 450000 : 150000), preVerificationGas: numberToHex(60000) };
    }
    case "eth_sendUserOperation": {
      const key = process.env.DRIP_FAUCET_KEY as Hex | undefined;
      if (!key) throw new Error("self-bundler not configured");
      const op = params[0] as UserOp;
      const relayer = privateKeyToAccount(key);
      const data = encodeFunctionData({ abi: epAbi, functionName: "handleOps", args: [[pack(op)], relayer.address] });
      const total = BigInt(op.verificationGasLimit!) + BigInt(op.callGasLimit!) + BigInt(op.preVerificationGas!);
      await pc.call({ account: relayer.address, to: ENTRYPOINT_V07, data }); // revert ⇒ reject before spending relayer gas
      const wc = createWalletClient({ chain: robinhoodTestnet, transport: http(), account: relayer });
      const blk = await pc.getBlock();
      const hash = await wc.sendTransaction({ to: ENTRYPOINT_V07, data, gas: total + BigInt(150000), maxFeePerGas: (blk.baseFeePerGas ?? BigInt(0)) * BigInt(2), maxPriorityFeePerGas: BigInt(0) });
      await pc.waitForTransactionReceipt({ hash, timeout: 25000 }).catch(() => null);
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
