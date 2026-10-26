/**
 * On-chain: pay-in-USDG through DiscipleRouter.buyWithUsdg / sellToUsdg (FLOW #65). Runs against APP's /api/bundler.
 *  - deployed router WITHOUT usdg() (pre-#65): asserts the app falls back to the native-quote path (routerUsdg = null)
 *    and exits 0 with SKIP for the USDG legs.
 *  - router WITH usdg() (after the #65 redeploy): owner-signed USDG buy + sell of $COIN; checks USDG spent == usdgIn,
 *    coin ≥ minOut, USDG back ≥ minOut, one userOp each. (Session-signed USDG legs: test:session-e2e with
 *    NEXT_PUBLIC_SESSION_POLICY_VERSION=1.3.0 once the 1.3.0 policy is deployed.)
 *   APP=http://localhost:3001 COIN=0x… pnpm test:usdg-router
 */
import { createPublicClient, encodeFunctionData, http, parseAbi, parseUnits, formatUnits, formatEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Mav2Account } from "../lib/aa/mav2";
import { routerUsdg, routerBuyWithUsdgCalls, routerSellToUsdgCalls, toCalls, usdgRouteQuote } from "../lib/trade/usdgRouter";
import { applySlippage } from "../lib/curveMath";
import { clampSlippage } from "../lib/aa/slippage";
const { robinhoodTestnet, DEPLOYMENTS } = await import("../lib/chains");
const d = DEPLOYMENTS[46630];
const APP = process.env.APP || "http://localhost:3001";
const COIN = (process.env.COIN || "0xcac8A9654dE3aE01470fC9E93e58fb97d5B86bb3") as Address;
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const erc20 = parseAbi(["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"]);
let fails = 0; const ok = (c: boolean, m: string) => { console.log(c ? "ok  " : "FAIL", m); if (!c) fails++; };

const usdg = await routerUsdg(pc as never, d.router);
if (!usdg) {
  ok(true, `router ${d.router} has no usdg() (pre-#65) ⇒ app uses the native-quote path (fallback)`);
  console.log("SKIP USDG legs until the #65 redeploy"); process.exit(fails ? 1 : 0);
}
ok(usdg.toLowerCase() === d.usdg.toLowerCase(), `router.usdg() = ${usdg}`);
const bal = (t: Address, a: Address) => pc.readContract({ address: t, abi: erc20, functionName: "balanceOf", args: [a] });
async function settle(tx: Hex) { const r = await pc.waitForTransactionReceipt({ hash: tx, pollingInterval: 100 }); for (let i = 0; i < 50 && (await pc.getBlockNumber()) < r.blockNumber; i++) await new Promise((x) => setTimeout(x, 100)); await new Promise((x) => setTimeout(x, 300)); }
const sa = new Mav2Account({ chain: robinhoodTestnet, pc: pc as never, bundlerUrl: `${APP}/api/bundler` }, privateKeyToAccount(generatePrivateKey()));
const me = await sa.address(); console.log("account", me);
await fetch(`${APP}/api/drip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: me }) });
for (let i = 0; i < 100 && (await pc.getBalance({ address: me })) === BigInt(0); i++) await new Promise((r) => setTimeout(r, 200));
await settle((await sa.sendCalls([{ to: usdg, data: encodeFunctionData({ abi: erc20, functionName: "mint", args: [me, parseUnits("100", d.usdgDecimals)] }) }])).txHash as Hex);
await Promise.all([sa.warm(), fetch(`${APP}/api/bundler`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "disciple_warm", params: [me] }) })]);
const dl = BigInt(Math.floor(Date.now() / 1000) + 300), slip = clampSlippage(100, 500).bps ?? 100;

const usdgIn = parseUnits("10", d.usdgDecimals);
const q = await usdgRouteQuote(pc as never, d.router, COIN, true, usdgIn, 0); const minT = applySlippage(q, slip);
const [u0, c0] = await Promise.all([bal(usdg, me), bal(COIN, me)]);
let t = performance.now(); const rb = await sa.sendCalls(toCalls(routerBuyWithUsdgCalls({ router: d.router, usdg, token: COIN, usdgIn, minTokensOut: minT, deadline: dl }))); const tb = Math.round(performance.now() - t);
await settle(rb.txHash as Hex);
const [u1, c1] = await Promise.all([bal(usdg, me), bal(COIN, me)]);
console.log("  owner buy", tb, "ms", JSON.stringify(rb.timings));
ok(u0 - u1 === usdgIn, `buyWithUsdg spent exactly ${formatUnits(u0 - u1, d.usdgDecimals)} USDG (${rb.txHash})`);
ok(c1 - c0 >= minT, `received ${formatEther(c1 - c0)} coin ≥ minOut ${formatEther(minT)}`);

const tIn = c1 - c0, qs = await usdgRouteQuote(pc as never, d.router, COIN, false, tIn, 0), minU = applySlippage(qs, slip);
t = performance.now(); const rs = await sa.sendCalls(toCalls(routerSellToUsdgCalls({ router: d.router, token: COIN, tokensIn: tIn, minUsdgOut: minU, deadline: dl }))); const ts = Math.round(performance.now() - t);
await settle(rs.txHash as Hex);
const [u2, c2] = await Promise.all([bal(usdg, me), bal(COIN, me)]);
console.log("  owner sell", ts, "ms", JSON.stringify(rs.timings));
ok(c2 === c1 - tIn, "sold all coin"); ok(u2 - u1 >= minU, `sellToUsdg paid ${formatUnits(u2 - u1, d.usdgDecimals)} USDG ≥ minOut ${formatUnits(minU, d.usdgDecimals)} (${rs.txHash})`);
console.log(fails ? `${fails} FAILED` : "ALL OK"); process.exit(fails ? 1 : 0);
