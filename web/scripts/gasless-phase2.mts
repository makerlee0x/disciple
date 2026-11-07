/* eslint-disable @typescript-eslint/no-explicit-any */
/** Explicitly gated testnet harness. Fresh keys live only in RAM. Never run old v5 harnesses. */
import { createPublicClient, createWalletClient, decodeEventLog, decodeFunctionData, encodeFunctionData, http, parseAbi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

if (process.env.PHASE2_TESTNET_RUN !== "1") throw Error("Explicit PHASE2_TESTNET_RUN=1 required");
if (process.env.VERCEL_ENV || process.env.NODE_ENV === "production") throw Error("Local only; no Vercel environment permitted");
// All changes below are this disposable local process only, never a Vercel env write.
process.env.GAS_SPONSORSHIP_MODE = "bso";
process.env.NEXT_PUBLIC_GAS_SPONSORSHIP_MODE = "bso";
process.env.ALCHEMY_BSO_POLICY_ID = "d38ec347-5eb0-498f-ba1a-842ea308c332";
process.env.NEXT_PUBLIC_CHAIN_ID = "46630";
process.env.NEXT_PUBLIC_SESSION_POLICY = "0xD2cF85dd7cDC3c3e53EA0472BF6Bf006de45E4d2";
process.env.KV_LOCAL_FILE = "/workspace/gasless-phase2-kv.json";
for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[k];
const { robinhoodTestnet: chain, DEPLOYMENTS, TESTNET_COINS } = await import("../lib/chains");
const { ANON_ADDONS } = await import("../lib/anon");
const { Mav2Account } = await import("../lib/aa/mav2");
const { userOpHash } = await import("../lib/aa/core");
const { ENTRYPOINT_V07: EP } = await import("../lib/aa/constants");
const { POST } = await import("../app/api/bundler/route");
const { buildCreateSession, buildUninstallSession, TRADE_PERMS } = await import("@disciple/session-keys");
const { getDefaultSingleSignerValidationModuleAddress, getDefaultTimeRangeModuleAddress } = await import("@account-kit/smart-contracts/experimental");
const d = DEPLOYMENTS[46630], USDG = d.usdg, COIN = TESTNET_COINS.graduated;
const modules = { policy: process.env.NEXT_PUBLIC_SESSION_POLICY as Address, singleSigner: getDefaultSingleSignerValidationModuleAddress(chain), timeRange: getDefaultTimeRangeModuleAddress(chain) };
const abi = parseAbi(["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)", "function transfer(address,uint256) returns(bool)", "function approve(address,uint256) returns(bool)", "function usdg() view returns(address)", "function moduleId() view returns(string)", "function quoteUsdgRouteFor(address,address,bool,uint256) returns(uint256,uint256)", "function buyWithUsdg(address,uint256,uint256,uint256) returns(uint256)", "function sellToUsdg(address,uint256,uint256,uint256) returns(uint256)"]);
const uoEvents = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)"]);
const handleAbi = parseAbi(["function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)"]);
const pc = createPublicClient({ chain, transport: http(undefined, { timeout: 12000, retryCount: 0 }), cacheTime: 0 });
const read = (address: Address, functionName: any, args: any[] = [], blockNumber?: bigint): Promise<any> => pc.readContract({ address, abi, functionName, args, blockNumber } as any);
const ct = () => new Date().toLocaleString("sv-SE", { timeZone: "America/Chicago" }) + " CT";
const clean = (x: unknown) => JSON.stringify(x, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2).replace(/https?:\/\/[^\s"<>]+/g, "[RPC URL REDACTED]"); // no keys/signatures are saved
const ev: any = { startCT: ct(), sourceSHA: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), chainId: 46630, policyId: process.env.ALCHEMY_BSO_POLICY_ID, policySnapshot: "Dashboard active/free supplied by lee; allowlist/caps not independently readable. No policy edit.", requests: [], cases: [], funds: [], submitted: 0, accepted: 0, trace: "unavailable", budgetExhausted: "not provable on testnet" };
const save = () => writeFileSync(process.env.PHASE2_EVIDENCE || "/workspace/gasless-phase2-evidence.json", clean(ev));
const safeError = (e: any) => ({ code: e?.code, message: String(e?.shortMessage || e?.message || e).split("\n")[0].slice(0, 500).replace(/https?:\/\/[^\s]+/g, "[RPC URL REDACTED]"), detail: e?.extra?.detail });
const fixtures: any[] = [];
let stage = "preflight";
const rawFetch = globalThis.fetch;
globalThis.fetch = async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (/disciple\.vip/.test(url)) throw Error("Production host forbidden");
  if (url !== "http://localhost:46630/api/bundler") return rawFetch(input, init);
  const request = new Request(url, init);
  const body = await request.clone().json();
  const req: any = { case: stage, method: body.method, submitCT: ct(), submitMs: performance.now() };
  const op = body.params?.[0];
  if (op && typeof op === "object") {
    req.sender = op.sender; req.nonce = op.nonce;
    req.shape = Object.fromEntries(["callGasLimit", "verificationGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas", "factory", "paymaster"].filter(k => op[k] !== undefined).map(k => [k, op[k]]));
  }
  if (body.method === "eth_sendUserOperation") {
    if (!ev.appConfirmation?.confirmed) throw Error("STOP policy/app confirmation required before send");
    if (ev.submitted >= 60 || await pc.getChainId() !== 46630 || !fixtures.some(x => x.address.toLowerCase() === op.sender.toLowerCase())) throw Error("Send budget/chain/sender guard");
    if (await pc.getBalance({ address: op.sender }) !== 0n) throw Error("Smart account must remain zero ETH");
    req.localHash = userOpHash(op, 46630); ev.submitted++;
  }
  ev.requests.push(req); save();
  const response = await POST(request);
  const answer = await response.clone().json();
  req.responseCT = ct(); req.responseMs = performance.now(); req.response = answer; req.httpStatus = response.status;
  if (body.method === "eth_estimateUserOperationGas" && !ev.appConfirmation) {
    const message = String(answer.error?.message || "");
    ev.appConfirmation = { confirmed: response.ok && !!answer.result && !answer.error,
      evidenceType: "Lee-authorized policy-header estimate criterion, not an independently read appId",
      policyId: process.env.ALCHEMY_BSO_POLICY_ID, keySource: "disciple Vercel Development ALCHEMY_API_KEY only",
      timeCT: ct(), httpStatus: response.status, rpcError: answer.error,
      result: answer.result, explicitMismatch: /policy.*(not found|invalid|app)|(?:invalid|unknown).*policy/i.test(message) };
  }
  if (body.method === "eth_sendUserOperation" && answer.result) ev.accepted++;
  save(); return response;
};
async function snapshot(f: any, blockNumber?: bigint) {
  const b = blockNumber ?? await pc.getBlockNumber({ cacheTime: 0 });
  return { blockNumber: b, ethWei: await pc.getBalance({ address: f.address, blockNumber: b }), usdgRaw: await read(USDG, "balanceOf", [f.address], b), coinRaw: await read(COIN, "balanceOf", [f.address], b) };
}
async function run(label: string, f: any, calls: any[], as: "owner" | "session" = "session", negative = false) {
  stage = label;
  const row: any = { label, account: f.address, actionCT: ct(), actionMs: performance.now(), before: await snapshot(f) };
  ev.cases.push(row); save();
  try {
    const result = await f.sa.sendCalls(calls, { as, feeRetry: false, pressId: `${label}-${crypto.randomUUID()}` });
    const rc = await pc.getTransactionReceipt({ hash: result.txHash });
    const block = await pc.getBlock({ blockNumber: rc.blockNumber });
    const tx = await pc.getTransaction({ hash: result.txHash });
    let uo: any;
    for (const log of rc.logs) { if (log.address.toLowerCase() !== EP.toLowerCase()) continue; try { const x = decodeEventLog({ abi: uoEvents, ...log }); if (x.args.userOpHash === result.userOpHash) uo = x.args; } catch {} }
    const packed = decodeFunctionData({ abi: handleAbi, data: tx.input }).args[0].find(x => x.sender.toLowerCase() === f.address.toLowerCase() && x.nonce === uo?.nonce);
    row.after = await snapshot(f, rc.blockNumber);
    Object.assign(row, { outcome: negative ? "UNEXPECTED INCLUSION" : "included", txHash: result.txHash, userOpHash: result.userOpHash, detectedCT: ct(), detectedMs: performance.now(), blockNumber: rc.blockNumber, blockCT: new Date(Number(block.timestamp) * 1000).toLocaleString("sv-SE", { timeZone: "America/Chicago" }) + " CT", blockTimeMs: Number(block.timestamp) * 1000,
      userGasChargeUsdgRaw: 0n, userGasChargeEthWei: uo?.actualGasCost, usdgTradeDeltaRaw: row.after.usdgRaw - row.before.usdgRaw, actualGasUsed: uo?.actualGasUsed, outerGasUsed: rc.gasUsed, outerEffectiveGasPrice: rc.effectiveGasPrice, bundlerSender: tx.from,
      onchainEnvelope: packed ? { preVerificationGas: packed.preVerificationGas, gasFees: packed.gasFees, paymasterAndData: packed.paymasterAndData, accountGasLimits: packed.accountGasLimits } : null, providerFiatCharge: "not exposed; documented free testnet, ledger unavailable" });
    if (!uo?.success || uo.actualGasCost !== 0n || row.after.ethWei !== 0n || !packed || packed.paymasterAndData !== "0x" || negative) throw Error("Receipt/accounting invariant failed");
  } catch (e) {
    if (row.txHash) { row.error = safeError(e); throw e; }
    row.after = await snapshot(f); row.error = safeError(e); row.outcome = negative ? "rejected (expected)" : "BLOCKED";
    row.userGasChargeUsdgRaw = row.before.usdgRaw - row.after.usdgRaw; row.userGasChargeEthWei = row.before.ethWei - row.after.ethWei; row.rejectedCT = ct(); row.rejectedMs = performance.now();
    if (!negative) { save(); throw e; }
  } finally { save(); }
  console.log(clean({ label, outcome: row.outcome, txHash: row.txHash, error: row.error })); return row;
}
async function fresh(ttlSec = 1200) {
  const owner = privateKeyToAccount(generatePrivateKey()), session = privateKeyToAccount(generatePrivateKey());
  const sa = new Mav2Account({ chain, pc: pc as any, bundlerUrl: "http://localhost:46630/api/bundler", bso: true, requireUsdgGas: true }, owner);
  const address = await sa.address(); const now = Number((await pc.getBlock()).timestamp);
  const setup = buildCreateSession({ now, modules, targets: { router: d.router, launchpad: d.launchpad, trampWallManager: d.trampWallManager, anonLauncher: ANON_ADDONS[46630].anonLauncher }, sessionSigner: session.address, ttlSec,
    permissions: TRADE_PERMS, caps: [{ token: d.defaultQuote, cap: 10n ** 24n }, { token: USDG, cap: 5_000_000n }] });
  const f = { owner, session, sa, address, setup }; fixtures.push(f);
  await run(`setup-${fixtures.length}`, f, [{ to: address, data: setup.data }], "owner");
  await sa.useSession(setup.entityId, session); return f;
}
const approve = (token: Address, amount: bigint) => ({ to: token, data: encodeFunctionData({ abi, functionName: "approve", args: [d.router, amount] }) });
async function trade(f: any, buy: boolean, amount: bigint, impossible = false) {
  const q = await read(d.router, "quoteUsdgRouteFor", [f.address, COIN, buy, amount]);
  if (q[0] <= 0n) throw Error("No existing liquid route");
  const min = impossible ? (1n << 128n) - 1n : q[0] * 9500n / 10000n || 1n;
  return [approve(buy ? USDG : COIN, amount), { to: d.router, data: encodeFunctionData({ abi, functionName: buy ? "buyWithUsdg" : "sellToUsdg", args: [COIN, amount, min, BigInt(Math.floor(Date.now() / 1000) + 600)] }) }];
}
try {
  if (await pc.getChainId() !== 46630 || await read(USDG, "decimals") !== 6 || (await read(d.router, "usdg")).toLowerCase() !== USDG.toLowerCase() || await read(modules.policy, "moduleId") !== "disciple.session-policy.1.4.3") throw Error("Fixture identity mismatch");
  const donor = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);
  if (donor.address.toLowerCase() !== process.env.DEPLOYER_ADDRESS?.toLowerCase()) throw Error("Donor address mismatch");
  ev.donor = { address: donor.address, ethWei: await pc.getBalance({ address: donor.address }), usdgRaw: await read(USDG, "balanceOf", [donor.address]) }; save();
  if (ev.donor.usdgRaw < 5_000_000n || ev.donor.ethWei < 100_000_000_000_000n) throw Error("Donor lacks approved fixtures; no mint/faucet");
  // Narrow positive admission gate BEFORE spending fixture USDG.
  const f = await fresh();
  const wc = createWalletClient({ account: donor, chain, transport: http() });
  let funded = 0n;
  async function fund(x: any) {
    if (!ev.appConfirmation?.confirmed) throw Error("STOP policy/app confirmation required before funding");
    if (funded + 1_000_000n > 5_000_000n || await pc.getChainId() !== 46630) throw Error("Funding cap/chain");
    const hash = await wc.writeContract({ address: USDG, abi, functionName: "transfer", args: [x.address, 1_000_000n] });
    ev.funds.push({ hash, recipient: x.address, usdgRaw: 1_000_000n, submitCT: ct() }); save();
    const rc = await pc.waitForTransactionReceipt({ hash }); funded += 1_000_000n;
    Object.assign(ev.funds.at(-1), { status: rc.status, donorGasWei: rc.gasUsed * rc.effectiveGasPrice, blockNumber: rc.blockNumber }); save();
    if (rc.status !== "success") throw Error("Funding reverted; no retry");
  }
  await fund(f);
  await run("first-buy", f, await trade(f, true, 100_000n));
  await run("sell", f, await trade(f, false, (await snapshot(f)).coinRaw));
  await run("failed-trade", f, await trade(f, true, 100_000n, true), "session", true);
  // Build oversized input without needing a quote that would itself reject before account construction.
  const insufficient = [approve(USDG, 2_000_000n), { to: d.router, data: encodeFunctionData({ abi, functionName: "buyWithUsdg", args: [COIN, 2_000_000n, 1n, BigInt(Math.floor(Date.now() / 1000) + 600)] }) }];
  await run("insufficient-usdg", f, insufficient, "session", true);
  const withdrawal = [{ to: USDG, data: encodeFunctionData({ abi, functionName: "transfer", args: [donor.address, 1n] }) }];
  await run("blocked-session-withdrawal", f, withdrawal, "session", true);
  await run("blocked-owner-withdrawal", f, withdrawal, "owner", true);
  for (let i = 0; i < 4; i++) await run(`queue-sequential-${i}`, f, await trade(f, true, 50_000n));
  const burst = await Promise.all(Array.from({ length: 4 }, () => trade(f, true, 50_000n)));
  await Promise.all(burst.map((calls, i) => run(`queue-same-account-${i}`, f, calls)));
  const other = [];
  for (let i = 0; i < 4; i++) { const x = await fresh(i === 3 ? 30 : 1200); await fund(x); other.push(x); }
  const separate = await Promise.all(other.map(x => trade(x, true, 50_000n)));
  await Promise.all(other.map((x, i) => run(`queue-separate-account-${i}`, x, separate[i])));
  // Uninstall on owner path, then deliberately retain old local key (no renewal/fallback).
  await run("revoke-session", f, [{ to: f.address, data: buildUninstallSession(f.setup.entityId, modules) }], "owner");
  await run("revoked-session", f, await trade(f, true, 50_000n), "session", true);
  const short = other.at(-1)!;
  while (Number((await pc.getBlock()).timestamp) <= short.setup.validUntil + 1) await new Promise(r => setTimeout(r, 1000));
  await run("expired-session", short, await trade(short, true, 50_000n), "session", true);
  ev.status = "matrix complete (budget/traces explicit limitations)";
} catch (e) { ev.status = "stopped at narrow gate"; ev.rootCause = safeError(e); console.log(clean({ stopped: stage, rootCause: ev.rootCause })); process.exitCode = 1; }
finally { ev.endCT = ct(); save(); globalThis.fetch = rawFetch; }

export const phase2Evidence = ev;
