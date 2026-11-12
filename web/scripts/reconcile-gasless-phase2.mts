/** Read-only reconciliation: no signer, credentials or wallet client. */
import { createPublicClient, decodeEventLog, decodeFunctionData, erc20Abi, http, parseAbi, type Address } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { robinhoodTestnet, DEPLOYMENTS } from "../lib/chains";
import { accountCalls } from "../lib/aa/gasPolicy";
import { ENTRYPOINT_V07 } from "../lib/aa/constants";
const input = process.argv[2] || "/workspace/gasless-phase2-continue-evidence.json";
const output = process.argv[3] || "/workspace/gasless-phase2-reconciled.json";
const data = JSON.parse(readFileSync(input, "utf8"));
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http(), cacheTime: 0 });
if (await pc.getChainId() !== 46630) throw Error("Testnet read-only reconciliation only");
const epAbi = parseAbi(["function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)"]);
const eventAbi = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)"]);
const tradeAbi = parseAbi(["function buyWithUsdg(address,uint256,uint256,uint256)", "function sellToUsdg(address,uint256,uint256,uint256)"]);
const usdg = DEPLOYMENTS[46630].usdg.toLowerCase();
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
for (const row of data.cases) {
  if (!row.txHash) {
    row.reconciledTiming = { actionToRejectionMs: row.rejectedMs - row.actionMs, acceptance: null, inclusion: null };
    continue;
  }
  // Never join by shared asynchronous stage labels: use the signed canonical hash.
  const request = data.requests.find((r: { localHash?: string }) => r.localHash === row.userOpHash);
  if (!request || request.response?.result !== row.userOpHash) throw Error("Hash correlation failed");
  request.originalCase = request.case; request.case = row.label;
  const estimates = data.requests.filter((r: { method: string; sender?: string; nonce?: string }) => r.method === "eth_estimateUserOperationGas" && r.sender === request.sender && r.nonce === request.nonce);
  for (const r of estimates) { r.originalCase = r.case; r.case = row.label; }
  row.request = { sender: request.sender, nonce: request.nonce, signedGas: request.shape, estimateResult: estimates.at(-1)?.response?.result };
  row.reconciledTiming = { actionToSubmitMs: request.submitMs - row.actionMs, submitToAcceptanceMs: request.responseMs - request.submitMs, acceptanceToReceiptObservedMs: row.detectedMs - request.responseMs, actionToReceiptObservedMs: row.detectedMs - row.actionMs, submitCT: request.submitCT, acceptanceCT: request.responseCT, inclusionBlockCT: row.blockCT, detectionCT: row.detectedCT, inclusionPrecision: "block timestamp seconds; receipt detection is not inclusion time" };
  const [tx, rc] = await Promise.all([pc.getTransaction({ hash: row.txHash }), pc.getTransactionReceipt({ hash: row.txHash })]);
  const packed = decodeFunctionData({ abi: epAbi, data: tx.input }).args[0].find(op => eq(op.sender, row.account) && op.nonce === BigInt(request.nonce));
  if (!packed || packed.paymasterAndData !== "0x" || BigInt(packed.gasFees) !== 0n || packed.preVerificationGas !== 0n) throw Error("Onchain BSO envelope mismatch");
  let start = 0, end = -1, actualGasCost: bigint | undefined;
  for (let i = 0; i < rc.logs.length; i++) {
    const log = rc.logs[i]; if (!eq(log.address, ENTRYPOINT_V07)) continue;
    let e; try { e = decodeEventLog({ abi: eventAbi, data: log.data, topics: log.topics }); } catch { continue; }
    if (e.args.userOpHash === row.userOpHash) { end = i; actualGasCost = e.args.actualGasCost; if (!e.args.success) throw Error("Operation failed"); break; }
    start = i + 1;
  }
  if (end < 0 || actualGasCost !== 0n) throw Error("Missing/charged user operation");
  let out = 0n, incoming = 0n;
  for (const log of rc.logs.slice(start, end)) {
    if (!eq(log.address, usdg)) continue;
    try {
      const e = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (e.eventName === "Transfer") { if (eq(e.args.from, row.account)) out += e.args.value; if (eq(e.args.to, row.account)) incoming += e.args.value; }
    } catch { /* non-Transfer */ }
  }
  let exactBuyInput = 0n;
  for (const call of accountCalls(packed.callData) || []) {
    if (!eq(call.to, DEPLOYMENTS[46630].router)) continue;
    try { const t = decodeFunctionData({ abi: tradeAbi, data: call.data as `0x${string}` }); if (t.functionName === "buyWithUsdg") exactBuyInput += t.args[1]; } catch { /* nontrade */ }
  }
  if (out !== exactBuyInput) throw Error("Unexpected USDG outflow beyond exact trade input");
  // Overlapping concurrent wallet snapshots are not per-operation charges. These log segments are.
  row.receiptAccounting = { usdgOutRaw: out, usdgInRaw: incoming, usdgTradeDeltaRaw: incoming - out, userGasChargeUsdgRaw: out - exactBuyInput, userGasChargeEthWei: actualGasCost, nativeBalanceAfterWei: await pc.getBalance({ address: row.account as Address, blockNumber: rc.blockNumber }) };
  if (row.receiptAccounting.nativeBalanceAfterWei !== 0n) throw Error("Smart account received native ETH");
}
const sends = data.requests.filter((r: { method: string }) => r.method === "eth_sendUserOperation");
const nonceKeys = sends.map((r: { sender: string; nonce: string }) => `${r.sender.toLowerCase()}:${r.nonce}`);
if (new Set(nonceKeys).size !== nonceKeys.length) throw Error("Duplicate account nonce");
data.reconciliation = { readOnly: true, includedVerified: data.cases.filter((r: { txHash?: string }) => r.txHash).length, submittedIncludingPriorRejected: data.submitted, uniqueCurrentRunSenderNonces: nonceKeys.length, note: "Receipt-segment accounting fixes overlapping concurrent balance deltas; hash correlation fixes asynchronous stage-label races. No operations re-sent." };
writeFileSync(output, JSON.stringify(data, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
console.log(JSON.stringify(data.reconciliation));
