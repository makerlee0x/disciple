/**
 * One-tap session e2e on RH testnet, v5 stack (DiscipleSessionPolicy 1.4.1, 6-dec USDG, DisciplePaymaster USDG gas) against a
 * running app (/api/drip, /api/bundler, /api/paymaster). Successor of test-session-e2e.mts (v4 / 1.3.0 / STRATEGY buyExactIn).
 * A fresh local key stands in for the Privy embedded EOA (same viem LocalAccount interface as toViemAccount).
 *   1. drip → owner self-pay op: mint 100 USDG (deploys the MAv2; the account has no USDG for paymaster gas yet)
 *   2. owner installs the session like enableOneTap: SESSION_NO_CAP caps, sessionPermissions(TRADE_PERMS), max slippage 5%,
 *      targets incl. ANON_ADDONS[46630].anonLauncher; account built like lib/aa/session.ts (usdgGas → /api/paymaster)
 *   3. session key: BOOST (approve + buyWithUsdg) and DUMP (approve + sellToUsdg), gas paid in USDG via the paymaster
 *   4. policy ≥ 1.4.1: session swapUsdgToQuote / swapQuoteToUsdg (USDG <-> STRATEGY, recipient = account)
 *   5. rejections: minOut at 20% slippage; USDG.transfer / STRATEGY.transfer; tryAttribute for a third-party wallet;
 *      swap to a third-party recipient; launchWithUsdg (P_LAUNCH not granted); client routes transfers to the owner signer
 * Prints addresses / tx hashes only.
 *   APP=https://<deployment> pnpm test:session-e2e-v5        (COIN=<graduated v5 coin>, default TESTNET_COINS.graduated)
 */
import { createPublicClient, encodeFunctionData, http, parseAbi, parseUnits, formatUnits, formatEther, decodeEventLog, decodeAbiParameters, toFunctionSelector, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { TRADE_PERMS, buildCreateSession, readSession } from "@disciple/session-keys";
import { getDefaultSingleSignerValidationModuleAddress, getDefaultTimeRangeModuleAddress } from "@account-kit/smart-contracts/experimental";
import { Mav2Account } from "../lib/aa/mav2";
import { SESSION_POLICY_MODULE_ID, moduleIdAbi, sessionEligible, sessionPermissions, sessionPolicyFor, fmtSessionExpiry, SESSION_NO_CAP, policyHasPaymaster, policyHasUsdgSwaps } from "../lib/aa/oneTap";
import { routerUsdg, routerBuyWithUsdgCalls, routerSellToUsdgCalls, toCalls, usdgRouteQuote } from "../lib/trade/usdgRouter";
import { clampSlippage } from "../lib/aa/slippage";
import { applySlippage } from "../lib/curveMath";
import { discipleRouterAbi } from "../lib/abi";
import type { Call } from "../lib/aa/core";

const APP = process.env.APP || "http://localhost:3001";
const { robinhoodTestnet, DEPLOYMENTS, TESTNET_COINS } = await import("../lib/chains");
const { ANON_ADDONS } = await import("../lib/anon");
const POLICY = sessionPolicyFor(46630) as Address;
const COIN = (process.env.COIN || TESTNET_COINS.graduated) as Address;
const d = DEPLOYMENTS[46630];
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const out: Record<string, string> = {};
let failures = 0;
const ok = (k: string, cond: boolean, v = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${k}${v ? `: ${v}` : ""}`); if (!cond) failures++; };
const erc20 = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const registryAbi = parseAbi(["function tryAttribute(address wallet, address referrer) returns (bool)"]);
const uoEv = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"]);
const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032".toLowerCase();
const bal = (t: Address, a: Address) => pc.readContract({ address: t, abi: erc20, functionName: "balanceOf", args: [a] });
const dec = d.usdgDecimals, fu = (x: bigint) => formatUnits(x, dec);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// RPC is load-balanced: after a receipt, wait until reads see that block
async function settle(tx: Hex) { const r = await pc.waitForTransactionReceipt({ hash: tx, pollingInterval: 100 }); for (let i = 0; i < 50 && (await pc.getBlockNumber()) < r.blockNumber; i++) await sleep(100); await sleep(300); return r; }
async function pmInfo(tx: Hex) {
  const r = await pc.getTransactionReceipt({ hash: tx });
  for (const l of r.logs) { if (l.address.toLowerCase() !== EP) continue; try { const e = decodeEventLog({ abi: uoEv, data: l.data, topics: l.topics }); return { status: r.status, paymaster: e.args.paymaster, success: e.args.success, gasEth: formatEther(e.args.actualGasCost) }; } catch {} }
  return { status: r.status, paymaster: "none", success: false, gasEth: "?" };
}

// DiscipleSessionPolicy 1.4.1 errors (wrapped by MAv2 in PreExecHookReverted(bytes24 module, bytes reason))
const POLICY_ERRORS = ["InvalidConfig()", "SessionInactive()", "SessionExpired()", "NotAllowed(address,bytes4)", "EthValueNotAllowed()", "RecipientNotAccount()",
  "StealthOwnerNotAllowed(address)", "SpenderNotAllowed(address)", "SpendCapExceeded(address,uint256,uint256)", "NotCurve(address)", "OnlyExecuteCalls()",
  "SignatureValidationNotAllowed()", "ZeroMinOut()", "MinOutTooLow(uint256,uint256)", "QuoteFailed(address)", "WalletNotAccount()",
  "UsdgApproveNotExact(uint256,uint256)", "PaymasterApproveNotExact(uint256,uint256)"];
const errName = (data: string) => POLICY_ERRORS.find((x) => toFunctionSelector(x) === data.slice(0, 10)) ?? data.slice(0, 10);
const why = (e: unknown) => {
  const rd = (e as { extra?: { revertData?: string } }).extra?.revertData;
  if (!rd) return (e as Error).message.slice(0, 160);
  if (rd.slice(0, 10) === "0x74a1a72c") { const [mod, reason] = decodeAbiParameters([{ type: "bytes24" }, { type: "bytes" }], `0x${rd.slice(10)}` as Hex); return `PreExecHookReverted(${mod.slice(0, 42)}…) → ${errName(reason)}`; }
  return errName(rd);
};

console.log("APP", APP, "policy", POLICY, "coin", COIN, "usdgDecimals", dec, "paymaster", d.paymaster);
const id = await pc.readContract({ address: POLICY, abi: moduleIdAbi, functionName: "moduleId" });
ok("policy moduleId", id === SESSION_POLICY_MODULE_ID, id);
const usdg = await routerUsdg(pc as never, d.router);
ok("router.usdg() == deployment USDG", !!usdg && usdg.toLowerCase() === d.usdg.toLowerCase(), String(usdg));

const owner = privateKeyToAccount(generatePrivateKey());
const boot = new Mav2Account({ chain: robinhoodTestnet, pc: pc as never, bundlerUrl: `${APP}/api/bundler` }, owner); // self-pay bootstrap
const sa = new Mav2Account({ chain: robinhoodTestnet, pc: pc as never, bundlerUrl: `${APP}/api/bundler`, usdgGas: { paymaster: d.paymaster, usdg: d.usdg, url: `${APP}/api/paymaster`, session: policyHasPaymaster() } }, owner);
const me = await sa.address();
console.log("owner", owner.address, "\naccount", me);

// 1. drip + owner mint 100 USDG (self-pay: no USDG yet for paymaster gas; also deploys the account)
const drip = await fetch(`${APP}/api/drip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: me }) }).then((r) => r.json());
ok("drip", !!drip.ok, drip.txHash || drip.reason); out.drip = drip.txHash;
if (drip.txHash) await pc.waitForTransactionReceipt({ hash: drip.txHash });
for (let i = 0; i < 100 && (await pc.getBalance({ address: me })) === BigInt(0); i++) await sleep(200);
const mint = await boot.sendCalls([{ to: d.usdg, data: encodeFunctionData({ abi: erc20, functionName: "mint", args: [me, parseUnits("100", dec)] }) }], "owner");
await settle(mint.txHash); ok("owner mint 100 USDG (account deploy, self-pay)", (await bal(d.usdg, me)) === parseUnits("100", dec), mint.txHash); out.ownerMint = mint.txHash;
await sa.warm();

// 2. install session (owner, USDG gas), like enableOneTap
const key = generatePrivateKey();
const s = buildCreateSession({
  modules: { policy: POLICY, singleSigner: getDefaultSingleSignerValidationModuleAddress(robinhoodTestnet), timeRange: getDefaultTimeRangeModuleAddress(robinhoodTestnet) },
  targets: { router: d.router, launchpad: d.launchpad, anonLauncher: ANON_ADDONS[46630]?.anonLauncher, trampWallManager: d.trampWallManager },
  sessionSigner: privateKeyToAccount(key).address,
  caps: [{ token: d.defaultQuote, cap: SESSION_NO_CAP }, { token: d.usdg, cap: SESSION_NO_CAP }],
  ttlSec: 86400 - 600, // AUDIT #148 M-1: skew margin under the on-chain 24h max
  maxSlippageBps: 500, permissions: sessionPermissions(TRADE_PERMS),
});
const inst = await sa.sendCalls([{ to: me, data: s.data }], "owner");
await settle(inst.txHash);
ok("owner installs session", true, `${inst.txHash} ${JSON.stringify(await pmInfo(inst.txHash))}`); out.installSession = inst.txHash;
let info = await readSession(pc as never, POLICY, me, s.entityId);
for (let i = 0; i < 30 && !(info.validUntil > 0); i++) { await sleep(100); info = await readSession(pc as never, POLICY, me, s.entityId); }
const now = Number((await pc.getBlock()).timestamp);
ok("session active, ~24h validUntil (seconds)", info.active && Math.abs(info.validUntil - now - 86400) < 1200, `${info.validUntil} (${fmtSessionExpiry(info.validUntil, now * 1000, "en-US", "America/Chicago")})`);
ok("session maxSlippageBps = 500", info.maxSlippageBps === 500);
await sa.useSession(s.entityId, privateKeyToAccount(key));
await sa.warm();

const elig = (calls: Call[]) => sessionEligible(calls, { referral: false, registry: d.referralRegistry, usdg: d.usdg, router: d.router });
const dl = () => BigInt(Math.floor(Date.now() / 1000) + 300);
const clamp = clampSlippage(2000, info.maxSlippageBps);
ok("client clamp 20% → 5% max (4.5% used: quote headroom)", clamp.capped && clamp.bps === 450, JSON.stringify(clamp));
const slip = clamp.bps!;
const send = async (label: string, calls: Call[]) => {
  ok(`${label}: eligible for session key`, elig(calls));
  try { const r = await sa.sendCalls(calls, "session"); await settle(r.txHash); const p = await pmInfo(r.txHash); ok(label, p.status === "success" && p.success, `${r.txHash} gas via ${p.paymaster}`); ok(`${label}: gas via paymaster`, p.paymaster.toLowerCase() === d.paymaster.toLowerCase()); out[label] = r.txHash; return r; }
  catch (e) { ok(label, false, why(e)); return null; }
};
const reject = async (label: string, calls: Call[]) => {
  try { await sa.sendCalls(calls, "session"); ok(`rejected: ${label}`, false, "UNEXPECTEDLY ALLOWED"); }
  catch (e) { ok(`rejected: ${label}`, true, why(e)); }
};

// 3a. BOOST $10 (approve USDG→router exact + buyWithUsdg)
const usdgIn = parseUnits("10", dec);
const q = await usdgRouteQuote(pc as never, d.router, COIN, true, usdgIn, 0);
const [u0, c0] = await Promise.all([bal(d.usdg, me), bal(COIN, me)]);
await send("session BOOST", toCalls(routerBuyWithUsdgCalls({ router: d.router, usdg: d.usdg, token: COIN, usdgIn, minTokensOut: applySlippage(q, slip), deadline: dl() })));
const [u1, c1] = await Promise.all([bal(d.usdg, me), bal(COIN, me)]);
ok("BOOST USDG out = 10 + gas fee", u0 - u1 >= usdgIn, `spent ${fu(u0 - u1)} USDG`);
ok("BOOST coin ≥ minOut", c1 - c0 >= applySlippage(q, slip), formatEther(c1 - c0));

// 5a. unclamped 20% slippage would revert on-chain (MinOutTooLow) — what the client clamp prevents
const q2 = await usdgRouteQuote(pc as never, d.router, COIN, true, usdgIn, 0);
await reject("minOut at 20% slippage (> session 5%)", toCalls(routerBuyWithUsdgCalls({ router: d.router, usdg: d.usdg, token: COIN, usdgIn, minTokensOut: applySlippage(q2, 2000), deadline: dl() })));

// 3b. DUMP half (approve coin→router + sellToUsdg)
const tIn = (c1 - c0) / BigInt(2);
if (tIn > BigInt(0)) {
  const qs = await usdgRouteQuote(pc as never, d.router, COIN, false, tIn, 0);
  await send("session DUMP", toCalls(routerSellToUsdgCalls({ router: d.router, token: COIN, tokensIn: tIn, minUsdgOut: applySlippage(qs, slip), deadline: dl() })));
  ok("DUMP sold half", (await bal(COIN, me)) === c1 - tIn);
} else ok("session DUMP", false, "no coin from BOOST");

// 4. policy 1.4.1: USDG <-> pair-coin swaps (DiscipleRouter.swapUsdgToQuote / swapQuoteToUsdg, recipient = account)
const STRAT = d.defaultQuote;
const swapQuote = async (toQuote: boolean, amt: bigint) =>
  (await pc.simulateContract({ address: d.router, abi: discipleRouterAbi, functionName: "quoteUsdgQuoteSwap", args: [STRAT, toQuote, amt] })).result[0];
const approve = (t: Address, amt: bigint): Call => ({ to: t, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [d.router, amt] }) });
const swapIn = parseUnits("1", dec);
if (policyHasUsdgSwaps()) {
  const s0 = await bal(STRAT, me);
  const qq = await swapQuote(true, swapIn);
  await send("session swapUsdgToQuote", [approve(d.usdg, swapIn), { to: d.router, data: encodeFunctionData({ abi: discipleRouterAbi, functionName: "swapUsdgToQuote", args: [STRAT, swapIn, applySlippage(qq, slip), me, dl()] }) }]);
  const got = (await bal(STRAT, me)) - s0;
  ok("swapUsdgToQuote STRATEGY in ≥ minOut", got >= applySlippage(qq, slip), formatEther(got));
  if (got > BigInt(0)) {
    const qu = await swapQuote(false, got);
    await send("session swapQuoteToUsdg", [approve(STRAT, got), { to: d.router, data: encodeFunctionData({ abi: discipleRouterAbi, functionName: "swapQuoteToUsdg", args: [STRAT, got, applySlippage(qu, slip), me, dl()] }) }]);
  }
} else console.log("skip swaps: policy < 1.4.1");

// 5b–5e. outside the policy
const stranger = privateKeyToAccount(generatePrivateKey()).address;
const xfer = (t: Address): Call => ({ to: t, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [stranger, BigInt(1)] }) });
await reject("USDG.transfer by session key", [xfer(d.usdg)]);
await reject("STRATEGY.transfer by session key", [xfer(STRAT)]);
await reject("tryAttribute for a third-party wallet", [{ to: d.referralRegistry, data: encodeFunctionData({ abi: registryAbi, functionName: "tryAttribute", args: [stranger, me] }) }]);
const qx = await swapQuote(true, swapIn);
await reject("swapUsdgToQuote to a third-party recipient", [approve(d.usdg, swapIn), { to: d.router, data: encodeFunctionData({ abi: discipleRouterAbi, functionName: "swapUsdgToQuote", args: [STRAT, swapIn, applySlippage(qx, slip), stranger, dl()] }) }]);
const launchParams = { name: "e2e", ticker: "E2E", imageURI: "", description: "", socialsURI: "", quote: d.usdg, creatorTaxBps: BigInt(0), creatorBuyQuoteIn: BigInt(0), creatorBuyMinTokensOut: BigInt(0), deadline: dl() };
await reject("launchWithUsdg (P_LAUNCH not in TRADE_PERMS)", [{ to: d.router, data: encodeFunctionData({ abi: discipleRouterAbi, functionName: "launchWithUsdg", args: [launchParams, 0, BigInt(0), BigInt(0)] }) }]);
ok("app routes transfer to owner, not session", !elig([xfer(d.usdg)]) && !elig([xfer(STRAT)]));
ok("app routes launchWithUsdg to owner, not session", !elig([{ to: d.router, data: encodeFunctionData({ abi: discipleRouterAbi, functionName: "launchWithUsdg", args: [launchParams, 0, BigInt(0), BigInt(0)] }) }]));

console.log("\ntx hashes:", JSON.stringify(out, null, 2));
console.log(failures ? `\n${failures} FAILED` : "\nALL OK");
process.exit(failures ? 1 : 0);
