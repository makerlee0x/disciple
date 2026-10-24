/**
 * One-tap session e2e on RH testnet (DiscipleSessionPolicy v1.3.0, v4) against a running app (/api/drip, /api/bundler).
 * A fresh local key stands in for the Privy embedded EOA (same viem LocalAccount interface as toViemAccount).
 *   1. drip → owner op: mint test STRATEGY (deploys the MAv2)
 *   2. owner installs the session ONCE (TRADE_PERMS + P_REFERRAL, max slippage 5%) — same builder/permissions as the app
 *   3. session key: approve+buy, approve+sell, referral-attributed buy (tryAttribute+approve+buy)
 *   4. rejections: STRATEGY.transfer by the session key; tryAttribute for a third-party wallet; minOut at 20% slippage
 *   5. client clamp: 20% requested ⇒ 5% used, and that trade passes
 * Prints addresses / tx hashes only.   APP=http://localhost:3001 pnpm test:session-e2e
 */
import { createPublicClient, encodeFunctionData, http, parseAbi, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { TRADE_PERMS, buildCreateSession, readSession } from "@disciple/session-keys";
import { getDefaultSingleSignerValidationModuleAddress, getDefaultTimeRangeModuleAddress } from "@account-kit/smart-contracts/experimental";
import { Mav2Account } from "../lib/aa/mav2";
import { SESSION_POLICY_MODULE_ID, P_REFERRAL, moduleIdAbi, sessionEligible, sessionPermissions, fmtSessionExpiry } from "../lib/aa/oneTap";
import { clampSlippage } from "../lib/aa/slippage";
import { applySlippage } from "../lib/curveMath";
import type { Call } from "../lib/aa/core";

const APP = process.env.APP || "http://localhost:3001";
const POLICY = (process.env.NEXT_PUBLIC_SESSION_POLICY || "0x3d3667e8880c6b633b424d645b8004788b1d6e27") as Address;
const { robinhoodTestnet, DEPLOYMENTS, TESTNET_COINS } = await import("../lib/chains");
const { ANON_ADDONS } = await import("../lib/anon");
const d = DEPLOYMENTS[46630];
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const out: Record<string, string> = {};
let failures = 0;
const ok = (k: string, cond: boolean, v = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${k}${v ? `: ${v}` : ""}`); if (!cond) failures++; };

const erc20 = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const router = parseAbi([
  "function buyExactIn(address token, uint256 quoteIn, uint256 minTokensOut, address recipient, uint256 deadline) returns (uint256)",
  "function sellExactIn(address token, uint256 tokensIn, uint256 minQuoteOut, address recipient, uint256 deadline) returns (uint256)",
  "function quoteExactIn(address token, bool isBuy, uint256 amountIn) returns (uint256 amountOut, uint256 impactBps, uint256 mcapAfterUsd)",
]);
const registryAbi = parseAbi(["function tryAttribute(address wallet, address referrer) returns (bool)", "function referrerOf(address) view returns (address)", "function pendingReferrer(address) view returns (address)"]);
const coin = TESTNET_COINS.graduated as Address;
const dl = () => BigInt(Math.floor(Date.now() / 1000) + 600);
const quote = async (isBuy: boolean, amt: bigint) => (await pc.simulateContract({ address: d.router, abi: router, functionName: "quoteExactIn", args: [coin, isBuy, amt] })).result[0];

// moduleId check (same constant the app enforces)
const id = await pc.readContract({ address: POLICY, abi: moduleIdAbi, functionName: "moduleId" });
ok("policy moduleId", id === SESSION_POLICY_MODULE_ID, id);

const owner = privateKeyToAccount(generatePrivateKey());
const sa = new Mav2Account({ chain: robinhoodTestnet, pc: pc as never, bundlerUrl: `${APP}/api/bundler` }, owner);
const me = await sa.address();
console.log("owner", owner.address, "\naccount", me);

// 1. drip + owner mint (deploys)
const drip = await fetch(`${APP}/api/drip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: me }) }).then((r) => r.json());
ok("drip", !!drip.ok, drip.txHash || drip.reason); out.drip = drip.txHash;
if (drip.txHash) await pc.waitForTransactionReceipt({ hash: drip.txHash });
const mint = await sa.sendCalls([{ to: d.defaultQuote, data: encodeFunctionData({ abi: erc20, functionName: "mint", args: [me, parseEther("200")] }) }], "owner");
ok("owner mint (account deploy)", true, mint.txHash); out.ownerMint = mint.txHash;

// 2. install session once (owner)
const key = generatePrivateKey();
const s = buildCreateSession({
  modules: { policy: POLICY, singleSigner: getDefaultSingleSignerValidationModuleAddress(robinhoodTestnet), timeRange: getDefaultTimeRangeModuleAddress(robinhoodTestnet) },
  targets: { router: d.router, launchpad: d.launchpad, anonLauncher: ANON_ADDONS[46630]?.anonLauncher, trampWallManager: d.trampWallManager },
  sessionSigner: privateKeyToAccount(key).address,
  caps: [{ token: d.defaultQuote, cap: BigInt("1000000000000000000000000") }, { token: d.usdg, cap: BigInt("1000000000000000000000000") }],
  ttlSec: 86400 - 600, // AUDIT #148 M-1: skew margin under the on-chain 24h max
  maxSlippageBps: 500, permissions: sessionPermissions(TRADE_PERMS, true),
});
const inst = await sa.sendCalls([{ to: me, data: s.data }], "owner");
ok("owner installs session", true, inst.txHash); out.installSession = inst.txHash;
// RPC is load-balanced: right after the sync receipt a read can hit a node one block behind
let info = await readSession(pc as never, POLICY, me, s.entityId);
for (let i = 0; i < 30 && !(info.validUntil > 0); i++) { await new Promise((r) => setTimeout(r, 100)); info = await readSession(pc as never, POLICY, me, s.entityId); }
const now = Number((await pc.getBlock()).timestamp);
ok("session active, ~24h validUntil (seconds)", info.active && Math.abs(info.validUntil - now - 86400) < 600, `${info.validUntil} (${fmtSessionExpiry(info.validUntil, now * 1000, "en-US", "America/Chicago")})`);
ok("session maxSlippageBps = 500", info.maxSlippageBps === 500);
ok("session has P_REFERRAL", (info.permissions & P_REFERRAL) === P_REFERRAL, info.permissions.toString());
await sa.useSession(s.entityId, privateKeyToAccount(key));

// Decode DiscipleSessionPolicy errors wrapped in MAv2 PreExecHookReverted(bytes24 module, bytes reason)
const POLICY_ERRORS = ["OnlyExecuteCalls()", "SessionInactive()", "SessionExpired()", "EthValueNotAllowed()", "ZeroMinOut()", "MinOutTooLow(uint256,uint256)",
  "NotAllowed(address,bytes4)", "SpendCapExceeded(address,uint256,uint256)", "QuoteFailed()", "BadRecipient()", "BadSpender()", "SignatureValidationNotAllowed()"];
const { toFunctionSelector, decodeAbiParameters } = await import("viem");
const why = (e: unknown) => {
  const rd = (e as { extra?: { revertData?: string } }).extra?.revertData;
  if (!rd) return (e as Error).message.slice(0, 140);
  let inner = rd;
  if (rd.slice(0, 10) === "0x74a1a72c") { const [mod, reason] = decodeAbiParameters([{ type: "bytes24" }, { type: "bytes" }], `0x${rd.slice(10)}` as Hex); inner = reason; return `PreExecHookReverted(${mod.slice(0, 42)}…) → ${POLICY_ERRORS.find((x) => toFunctionSelector(x) === inner.slice(0, 10)) ?? inner.slice(0, 10)}`; }
  return POLICY_ERRORS.find((x) => toFunctionSelector(x) === rd.slice(0, 10)) ?? rd.slice(0, 10);
};
const send = async (label: string, calls: Call[], referral = false) => {
  ok(`${label}: eligible for session key`, sessionEligible(calls, { referral, registry: d.referralRegistry }));
  try { const r = await sa.sendCalls(calls, "session"); ok(label, true, r.txHash); out[label] = r.txHash; return r; }
  catch (e) { ok(label, false, why(e)); return null; }
};
const reject = async (label: string, calls: Call[]) => {
  try { await sa.sendCalls(calls, "session"); ok(`rejected: ${label}`, false, "UNEXPECTEDLY ALLOWED"); }
  catch (e) { ok(`rejected: ${label}`, true, why(e)); }
};

// 3a. buy with client clamp: user asked 20%, session max 5% ⇒ 5%
const buyAmt = parseEther("10");
const clamp = clampSlippage(2000, info.maxSlippageBps);
ok("client clamp 20% → 5% max (4.5% used: quote headroom)", clamp.capped && clamp.bps === 450, JSON.stringify(clamp));
const q1 = await quote(true, buyAmt);
await send("session buy (clamped 5%)", [
  { to: d.defaultQuote, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [d.router, buyAmt] }) },
  { to: d.router, data: encodeFunctionData({ abi: router, functionName: "buyExactIn", args: [coin, buyAmt, applySlippage(q1, clamp.bps!), me, dl()] }) },
]);

// 4c. unclamped 20% slippage would revert on-chain (MinOutTooLow) — this is what the clamp prevents
const q2 = await quote(true, buyAmt);
await reject("minOut at 20% slippage (> session 5%)", [
  { to: d.defaultQuote, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [d.router, buyAmt] }) },
  { to: d.router, data: encodeFunctionData({ abi: router, functionName: "buyExactIn", args: [coin, buyAmt, applySlippage(q2, 2000), me, dl()] }) },
]);

// 3b. sell half
let bal = await pc.readContract({ address: coin, abi: erc20, functionName: "balanceOf", args: [me] });
for (let i = 0; i < 30 && bal === BigInt(0); i++) { await new Promise((r) => setTimeout(r, 100)); bal = await pc.readContract({ address: coin, abi: erc20, functionName: "balanceOf", args: [me] }); } // lagging node
if (bal === BigInt(0)) { // session buy failed: owner buys a little so the sell leg can still be exercised
  const qo = await quote(true, buyAmt);
  await sa.sendCalls([
    { to: d.defaultQuote, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [d.router, buyAmt] }) },
    { to: d.router, data: encodeFunctionData({ abi: router, functionName: "buyExactIn", args: [coin, buyAmt, applySlippage(qo, 500), me, dl()] }) },
  ], "owner");
  bal = await pc.readContract({ address: coin, abi: erc20, functionName: "balanceOf", args: [me] });
}
const sellAmt = bal / BigInt(2);
const q3 = await quote(false, sellAmt);
await send("session sell", [
  { to: coin, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [d.router, sellAmt] }) },
  { to: d.router, data: encodeFunctionData({ abi: router, functionName: "sellExactIn", args: [coin, sellAmt, applySlippage(q3, clamp.bps!), me, dl()] }) },
]);

// 3c. referral-attributed buy (NEXT_PUBLIC_REFERRAL_ATTRIBUTE=1 path: tryAttribute(me, ref) + approve + buy)
const referrer = privateKeyToAccount(generatePrivateKey()).address;
const q4 = await quote(true, buyAmt);
await send("session referral buy", [
  { to: d.referralRegistry, data: encodeFunctionData({ abi: registryAbi, functionName: "tryAttribute", args: [me, referrer] }) },
  { to: d.defaultQuote, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [d.router, buyAmt] }) },
  { to: d.router, data: encodeFunctionData({ abi: router, functionName: "buyExactIn", args: [coin, buyAmt, applySlippage(q4, clamp.bps!), me, dl()] }) },
], true);
const readRef = () => Promise.all([
  pc.readContract({ address: d.referralRegistry, abi: registryAbi, functionName: "referrerOf", args: [me] }),
  pc.readContract({ address: d.referralRegistry, abi: registryAbi, functionName: "pendingReferrer", args: [me] }),
]);
let [refOf, pend] = await readRef();
for (let i = 0; i < 30 && ![refOf, pend].some((x) => x.toLowerCase() === referrer.toLowerCase()); i++) { await new Promise((r) => setTimeout(r, 100)); [refOf, pend] = await readRef(); } // lagging node
ok("referral recorded (referrerOf or pending)", [refOf, pend].some((x) => x.toLowerCase() === referrer.toLowerCase()), `referrerOf=${refOf} pending=${pend}`);

// 4a/4b. outside the policy
await reject("STRATEGY.transfer by session key", [{ to: d.defaultQuote, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [referrer, BigInt(1)] }) }]);
await reject("tryAttribute for a third-party wallet", [{ to: d.referralRegistry, data: encodeFunctionData({ abi: registryAbi, functionName: "tryAttribute", args: [referrer, me] }) }]);
ok("app routes transfer to owner, not session", !sessionEligible([{ to: d.defaultQuote, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [referrer, BigInt(1)] }) as Hex }], { referral: true, registry: d.referralRegistry }));

console.log("\ntx hashes:", JSON.stringify(out, null, 2));
console.log(failures ? `\n${failures} FAILED` : "\nALL OK");
process.exit(failures ? 1 : 0);
