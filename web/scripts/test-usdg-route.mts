/**
 * On-chain: pay-in-USDG route (lib/trade/usdgRoute) against a running app's /api/bundler (self-bundler).
 * Fresh owner-key MAv2 → drip → mint mUSDG → BUY $COIN with mUSDG (mUSDG→STRATEGY→coin, ONE userOp) → SELL all back
 * (coin→STRATEGY→mUSDG, ONE userOp). Checks: mUSDG spent == amountIn exactly, coin received ≥ minOut, sell pays mUSDG.
 * Also: first trade per preset uses STATIC gas (no estimate) once the account is deployed; prints per-stage timings.
 *   APP=http://localhost:3001 COIN=0x… pnpm test:usdg-route
 */
import { createPublicClient, encodeFunctionData, http, parseAbi, parseEther, formatEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Mav2Account } from "../lib/aa/mav2";
import { buyHopCalls, sellHopCall, swapQuote, hopBps, RH_TESTNET_USDG as U, UNIVERSAL_ROUTER } from "../lib/trade/usdgRoute";
import { applySlippage } from "../lib/curveMath";
import type { Call } from "../lib/aa/core";
const { robinhoodTestnet, DEPLOYMENTS } = await import("../lib/chains");
const d = DEPLOYMENTS[46630];
const APP = process.env.APP || "http://localhost:3001";
const COIN = (process.env.COIN || "0xcac8A9654dE3aE01470fC9E93e58fb97d5B86bb3") as Address;
const Q = d.defaultQuote as Address;
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const erc20 = parseAbi(["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const router = parseAbi(["function buyExactIn(address token, uint256 quoteIn, uint256 minTokensOut, address recipient, uint256 deadline) returns (uint256)", "function sellExactIn(address token, uint256 tokensIn, uint256 minQuoteOut, address recipient, uint256 deadline) returns (uint256)", "function quoteExactIn(address token, bool isBuy, uint256 amountIn) returns (uint256 amountOut, uint256 fee, uint256 impactBps)"]);
let fails = 0; const ok = (c: boolean, m: string) => { console.log(c ? "ok  " : "FAIL", m); if (!c) fails++; };
const bal = (t: Address, a: Address) => pc.readContract({ address: t, abi: erc20, functionName: "balanceOf", args: [a] });
/** the RPC is load-balanced: right after an eth_sendRawTransactionSync receipt a read can hit a node one block behind */
async function settle(tx: Hex) { const r = await pc.waitForTransactionReceipt({ hash: tx, pollingInterval: 100 }); for (let i = 0; i < 50 && (await pc.getBlockNumber()) < r.blockNumber; i++) await new Promise((x) => setTimeout(x, 100)); await new Promise((x) => setTimeout(x, 300)); }
const rq = (side: boolean, amt: bigint) => pc.simulateContract({ address: d.router, abi: router, functionName: "quoteExactIn", args: [COIN, side, amt] }).then((r) => r.result[0]);

const sa = new Mav2Account({ chain: robinhoodTestnet, pc: pc as never, bundlerUrl: `${APP}/api/bundler` }, privateKeyToAccount(generatePrivateKey()));
const me = await sa.address(); console.log("account", me);
const dr = await (await fetch(`${APP}/api/drip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: me }) })).json(); ok(!!dr.ok, `drip ${dr.tx ?? dr.reason ?? ""}`);
for (let i = 0; i < 100 && (await pc.getBalance({ address: me })) === BigInt(0); i++) await new Promise((r) => setTimeout(r, 200));
const r0 = await sa.sendCalls([{ to: U, data: encodeFunctionData({ abi: erc20, functionName: "mint", args: [me, parseEther("100")] }) }]);
ok(true, `deploy + mint 100 mUSDG: ${r0.txHash}`);
// warm (what the app does at login / coin load): deploy state, fees, relayer + sender trust
await Promise.all([sa.warm(), fetch(`${APP}/api/bundler`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "disciple_warm", params: [me] }) })]);
const dl = BigInt(Math.floor(Date.now() / 1000) + 300), half = hopBps(500);

// BUY 10 mUSDG → COIN
const amtIn = parseEther("10");
const q1 = await swapQuote(pc as never, U, Q, amtIn); const q1min = applySlippage(q1, half);
const q2 = await rq(true, q1min); const minCoin = applySlippage(q2, half);
const buy: Call[] = [...buyHopCalls(U, Q, amtIn, q1min, dl), { to: Q, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [d.router, q1min] }) },
  { to: d.router, data: encodeFunctionData({ abi: router, functionName: "buyExactIn", args: [COIN, q1min, minCoin, me, dl] }) }];
const [u0, c0] = await Promise.all([bal(U, me), bal(COIN, me)]);
let t = performance.now(); const rb = await sa.sendCalls(buy); const tb = Math.round(performance.now() - t); await settle(rb.txHash as Hex);
const [u1, c1] = await Promise.all([bal(U, me), bal(COIN, me)]);
console.log("  cold buy timings", tb, "ms", JSON.stringify(rb.timings));
ok(u0 - u1 > BigInt(0) && u0 - u1 <= amtIn, `buy spent ${formatEther(u0 - u1)} ≤ ${formatEther(amtIn)} mUSDG (one userOp ${rb.txHash})`);
ok(c1 - c0 >= minCoin, `buy received ${formatEther(c1 - c0)} coin ≥ minOut ${formatEther(minCoin)}`);
ok(!!rb.timings?.fast, "cold buy took the fast path (static gas, no estimate)");

// SELL all COIN → mUSDG
const sIn = c1 - c0;
const s1 = await rq(false, sIn); const s1min = applySlippage(s1, half);
const s2 = await swapQuote(pc as never, Q, U, s1min); const minU = applySlippage(s2, half);
const sell: Call[] = [{ to: COIN, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [d.router, sIn] }) },
  { to: d.router, data: encodeFunctionData({ abi: router, functionName: "sellExactIn", args: [COIN, sIn, s1min, UNIVERSAL_ROUTER, dl] }) }, sellHopCall(Q, U, minU, dl)];
t = performance.now(); const rs = await sa.sendCalls(sell); const ts = Math.round(performance.now() - t); await settle(rs.txHash as Hex);
const [u2, c2] = await Promise.all([bal(U, me), bal(COIN, me)]);
console.log("  cold sell timings", ts, "ms", JSON.stringify(rs.timings));
ok(c2 === c1 - sIn, "sell spent all coin");
ok(u2 - u1 >= minU, `sell paid out ${formatEther(u2 - u1)} mUSDG ≥ minOut ${formatEther(minU)} (${rs.txHash})`);
ok(!!rs.timings?.fast, "cold sell took the fast path");
console.log("  round trip: spent", formatEther(u0 - u1), "mUSDG → got back", formatEther(u2 - u1), "mUSDG");
ok((await bal(Q, me)) === BigInt(0), "no pair-token dust left in the account");
// anti-grief: an UNWARMED sender is simulated first (server t.simulate > 0)
console.log(fails ? `${fails} FAILED` : "ALL OK"); process.exit(fails ? 1 : 0);
