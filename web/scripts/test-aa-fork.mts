// Fork test of the one-tap smart account flow: each action = ONE userOp, signed by the session/owner key, no other sigs.
// Runs against an anvil fork of RH testnet (RPC env FORK_RPC) where this script acts as the bundler (EntryPoint.handleOps).
// Usage: anvil --fork-url https://rpc.testnet.chain.robinhood.com --port 8547 --chain-id 46630 & FORK_RPC=http://127.0.0.1:8547 pnpm dlx tsx scripts/test-aa-fork.mts
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http, parseAbi, parseEther, concat, pad, type Hex, type Address, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { LightSmartAccount, ENTRYPOINT_V07, userOpHash, type Bundler, type UserOp } from "../lib/aa/core.ts";
import { checkCalls, recordSpend, SESSION_TTL_MS } from "../lib/aa/policy.ts";
import { bondingCurveAbi, launchpadAbi, tokenAbi } from "../lib/abi/index.ts";

const RPC = process.env.FORK_RPC || "http://127.0.0.1:8547";
const chain = { id: 46630, name: "rht-fork", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pc = createPublicClient({ chain, transport: http() }) as PublicClient;
const D = { launchpad: "0xf5c09182091e527f0445ce065f7fc59d4b55cede", router: "0xCfb16275fCbcF124dDe54F3dbc36ddC684111564", twm: "0xCCD9c94D7d4877fb487b01960C77917f6Df2F3fE", strategy: "0xd4d0eB01960AACE441bFcb323Bfaf7c3d8b555a3" } as const;
const epAbi = parseAbi(["struct P { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }", "function handleOps(P[] ops, address beneficiary)", "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"]);
const bundlerKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil default #0 (fork only)
const bw = createWalletClient({ chain, transport: http(), account: privateKeyToAccount(bundlerKey) });
const receipts = new Map<string, unknown>();
let sigCount = 0;
const p16 = (x?: Hex) => pad(x || "0x0", { size: 16 });
const bundler: Bundler = {
  async rpc(m, params) {
    if (m === "rundler_maxPriorityFeePerGas") return "0x0";
    if (m === "eth_estimateUserOperationGas") {
      const op = params[0] as UserOp;
      let cg = BigInt(1_500_000);
      if (!op.factory) cg = (await pc.estimateGas({ account: ENTRYPOINT_V07, to: op.sender, data: op.callData })) * BigInt(13) / BigInt(10);
      return { callGasLimit: "0x" + cg.toString(16), verificationGasLimit: "0x493e0", preVerificationGas: "0xc350" };
    }
    if (m === "alchemy_requestGasAndPaymasterAndData") throw new Error("alchemy_requestGasAndPaymasterAndData: Gas sponsorship is not enabled for this app");
    if (m === "eth_sendUserOperation") {
      const op = params[0] as UserOp;
      const packed = { sender: op.sender, nonce: BigInt(op.nonce), initCode: op.factory ? concat([op.factory, op.factoryData!]) : "0x" as Hex, callData: op.callData,
        accountGasLimits: concat([p16(op.verificationGasLimit), p16(op.callGasLimit)]), preVerificationGas: BigInt(op.preVerificationGas!),
        gasFees: concat([p16(op.maxPriorityFeePerGas), p16(op.maxFeePerGas)]), paymasterAndData: "0x" as Hex, signature: op.signature };
      const h = userOpHash(op, 46630);
      const tx = await bw.writeContract({ address: ENTRYPOINT_V07, abi: epAbi, functionName: "handleOps", args: [[packed], bw.account.address], gas: BigInt(15_000_000) });
      const rc = await pc.waitForTransactionReceipt({ hash: tx });
      let success = false;
      for (const l of rc.logs) { try { const e = decodeEventLog({ abi: epAbi, data: l.data, topics: l.topics }); if (e.eventName === "UserOperationEvent") success = e.args.success; } catch {} }
      receipts.set(h, { success, receipt: { transactionHash: tx, logs: rc.logs } });
      return h;
    }
    if (m === "eth_getUserOperationReceipt") return receipts.get(params[0] as string) ?? null;
    throw new Error("unsupported " + m);
  },
};

const ownerKey = generatePrivateKey(); // throwaway session/owner key
const base = privateKeyToAccount(ownerKey);
const owner = { address: base.address, signMessage: async (a: { message: { raw: Hex } }) => { sigCount++; return base.signMessage(a); } };
const sa = new LightSmartAccount({ pc, chainId: 46630, bundler, owner, sponsor: true, onGasMode: (m, r) => console.log("gas mode:", m, r ? `(${r.slice(0, 80)})` : "") });
const me = await sa.address();
await pc.request({ method: "anvil_setBalance" as never, params: [me, "0x38d7ea4c68000"] as never }); // 0.001 ETH = /api/drip default
console.log("smart account", me, "owner", owner.address);
let session = { expiresAt: Date.now() + SESSION_TTL_MS, spent: {} as Record<string, string> };
const cfg = { launchpad: D.launchpad as Address, router: D.router as Address, trampWallManager: D.twm as Address, mintable: [D.strategy as Address], defaultLimit: parseEther("1000000") };
const results: Record<string, unknown> = {};
async function step(label: string, calls: { to: Address; data: Hex }[]) {
  const before = sigCount;
  const delta = await checkCalls(pc, cfg, session, calls, me);
  const r = await sa.sendCalls(calls);
  session = { ...session, ...recordSpend(session, delta) };
  results[label] = { calls: calls.length, userOps: 1, ownerSignatures: sigCount - before, tx: r.txHash, gasMode: r.gasMode };
  console.log(label, results[label]);
  return r;
}
const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);
await step("getTestFunds", [{ to: D.strategy, data: encodeFunctionData({ abi: mintAbi, functionName: "mint", args: [me, parseEther("100000")] }) }]);
const now = BigInt(Math.floor(Date.now() / 1000));
const params = { name: "OneTap", ticker: "TAP", imageURI: "ipfs://x", description: "aa fork test", socialsURI: "", quote: "0x0000000000000000000000000000000000000000" as Address, creatorTaxBps: BigInt(0), creatorBuyQuoteIn: parseEther("100"), creatorBuyMinTokensOut: BigInt(0), deadline: now + BigInt(3600) };
const lr = await step("launch(+creator buy)", [
  { to: D.strategy, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [D.launchpad, parseEther("105")] }) },
  { to: D.launchpad, data: encodeFunctionData({ abi: launchpadAbi, functionName: "launchCoin", args: [params] }) }]);
let token: Address = "0x0", curve: Address = "0x0";
for (const l of lr.receipt.receipt.logs) { try { const e = decodeEventLog({ abi: launchpadAbi, data: l.data, topics: l.topics as [Hex] }); if (e.eventName === "Launched") { token = e.args.token as Address; curve = e.args.curve as Address; } } catch {} }
console.log("token", token, "curve", curve);
const dl = now + BigInt(600);
await step("buy", [
  { to: D.strategy, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [curve, parseEther("500")] }) },
  { to: curve, data: encodeFunctionData({ abi: bondingCurveAbi, functionName: "buy", args: [parseEther("500"), BigInt(0), dl, me] }) }]);
const bal = await pc.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [me] });
const sellAmt = bal / BigInt(2);
await step("sell", [
  { to: token, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [curve, sellAmt] }) },
  { to: curve, data: encodeFunctionData({ abi: bondingCurveAbi, functionName: "sell", args: [sellAmt, BigInt(0), dl, me] }) }]);
// policy negative test
try { await checkCalls(pc, cfg, session, [{ to: D.strategy, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [owner.address, BigInt(1)] }) }], me); console.log("POLICY FAIL"); }
catch (e) { console.log("policy blocks foreign approve:", (e as Error).message); }
console.log("token bal after", (await pc.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [me] })).toString(), "ETH left", (await pc.getBalance({ address: me })).toString());
console.log(JSON.stringify(results, (_, v) => typeof v === "bigint" ? v.toString() : v));
