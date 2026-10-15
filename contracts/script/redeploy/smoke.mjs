// Post-redeploy smoke on RH testnet 46630. Env: PRIVATE_KEY (deployer; can mint test STRATEGY). GRADUATE=1 tries graduation.
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, formatEther, decodeEventLog, maxUint256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
const B = JSON.parse(fs.readFileSync(new URL("../../deployments/web-bundle/addresses.json", import.meta.url))).contracts;
const RPC = "https://rpc.testnet.chain.robinhood.com";
const chain = { id: 46630, name: "rh", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pc = createPublicClient({ chain, transport: http(RPC) });
const me = privateKeyToAccount(process.env.PRIVATE_KEY);
const wc = createWalletClient({ chain, transport: http(RPC), account: me });
const Q = "0xd4d0eB01960AACE441bFcb323Bfaf7c3d8b555a3";
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function mint(address,uint256)"]);
const lp = parseAbi([
  "struct P { string name; string ticker; string imageURI; string description; string socialsURI; address quote; uint256 creatorTaxBps; uint256 creatorBuyQuoteIn; uint256 creatorBuyMinTokensOut; uint256 deadline; }",
  "struct R { address token; address curve; uint256 creatorTokensBought; }",
  "function launch(P) returns (R)", "function quoteCreatorBuy(address,uint256) view returns (uint256,uint256,uint256,uint256,bool)",
  "function creatorBuyMaxBpsOf(address) view returns (uint256)", "function creatorBuyMaxBps() view returns (uint256)", "error CreatorBuyTooLarge()",
]);
const curveAbi = parseAbi(["function buy(uint256,uint256,uint256) returns (uint256)", "function mcapNow() view returns (uint256)", "function priceNow() view returns (uint256)",
  "function quotePriceUsd() view returns (uint256)", "function graduated() view returns (bool)", "function progressBps() view returns (uint256)", "function currentSnipeFeeBps() view returns (uint256)"]);
const frAbi = parseAbi(["event SnipeFeeRouted(address indexed token, address indexed quote, uint256 toRewards, uint256 toTreasury)", "function treasury() view returns (address)", "function rewardsVault() view returns (address)"]);
const llAbi = parseAbi(["function addLockedLiquidity(address,address,uint256,uint256)", "error Unauthorized()"]);
const lensAbi = parseAbi(["function mcapNow(address) view returns (uint256)"]);
const res = {}; const ok = (k, v) => { res[k] = v; console.log(k, typeof v === "bigint" ? v.toString() : v); };
const send = async (k, p) => { const h = await wc.writeContract(p); const r = await pc.waitForTransactionReceipt({ hash: h }); if (r.status !== "success") throw new Error(k + " reverted " + h); ok(k, h); return r; };
const bal0 = await pc.getBalance({ address: me.address });
const dl = BigInt(Math.floor(Date.now() / 1000) + 900);
if ((await pc.readContract({ address: Q, abi: erc20, functionName: "balanceOf", args: [me.address] })) < parseEther("5000"))
  await send("mintTx", { address: Q, abi: erc20, functionName: "mint", args: [me.address, parseEther("20000")] });
await send("approveLaunchpadTx", { address: Q, abi: erc20, functionName: "approve", args: [B.Launchpad, maxUint256] });
// creator buy sizing: largest of candidates within cap
const cands = ["1", "5", "10", "20", "50", "100"].map((x) => parseEther(x));
let inCap = 0n, over = 0n;
for (const c of cands) { const [, , , , ex] = await pc.readContract({ address: B.Launchpad, abi: lp, functionName: "quoteCreatorBuy", args: [Q, c] }); if (!ex) inCap = c; else if (!over) over = c; }
ok("creatorBuyMaxBps", await pc.readContract({ address: B.Launchpad, abi: lp, functionName: "creatorBuyMaxBps" }));
const P = (buy) => ({ name: "Smoke " + Date.now() % 1e5, ticker: "SMK", imageURI: "ipfs://smoke", description: "redeploy smoke", socialsURI: "", quote: Q, creatorTaxBps: 0n, creatorBuyQuoteIn: buy, creatorBuyMinTokensOut: 0n, deadline: dl });
if (over) { try { await pc.simulateContract({ account: me, address: B.Launchpad, abi: lp, functionName: "launch", args: [P(over)] }); ok("overCapCreatorBuy", "UNEXPECTEDLY ALLOWED"); } catch (e) { ok("overCapCreatorBuy(" + formatEther(over) + " STRATEGY)", "rejected: " + (e.cause?.data?.errorName ?? e.shortMessage)); } }
const sim = await pc.simulateContract({ account: me, address: B.Launchpad, abi: lp, functionName: "launch", args: [P(inCap)] });
const r1 = await send("launchTx", sim.request);
const { token, curve, creatorTokensBought } = sim.result;
ok("token", token); ok("curve", curve);
const cap = (7_000_000_000n * 10n ** 18n * (await pc.readContract({ address: B.Launchpad, abi: lp, functionName: "creatorBuyMaxBpsOf", args: [token] }))) / 10000n;
ok("creatorBuy", `${formatEther(inCap)} STRATEGY -> ${formatEther(creatorTokensBought)} tokens (cap ${formatEther(cap)}) withinCap=${creatorTokensBought <= cap}`);
// snipe buy inside the 7s window
await send("approveCurveTx", { address: Q, abi: erc20, functionName: "approve", args: [curve, maxUint256] });
const tre = await pc.readContract({ address: B.FeeRouter, abi: frAbi, functionName: "treasury" });
const rv = await pc.readContract({ address: B.FeeRouter, abi: frAbi, functionName: "rewardsVault" });
const bq = async (a) => pc.readContract({ address: Q, abi: erc20, functionName: "balanceOf", args: [a] });
const [rv0, tr0, fr0] = [await bq(rv), await bq(tre), await bq(B.FeeRouter)];
ok("snipeFeeBpsBeforeBuy", await pc.readContract({ address: curve, abi: curveAbi, functionName: "currentSnipeFeeBps" }));
const r2 = await send("snipeBuyTx", { address: curve, abi: curveAbi, functionName: "buy", args: [parseEther("10"), 0n, dl] });
for (const l of r2.logs) { try { const d = decodeEventLog({ abi: frAbi, ...l }); if (d.eventName === "SnipeFeeRouted") {
  const { toRewards, toTreasury } = d.args; const t = toRewards + toTreasury;
  ok("snipeSplit", `rewards ${formatEther(toRewards)} / treasury ${formatEther(toTreasury)} = ${Number((toRewards * 10000n) / t) / 100}% / ${Number((toTreasury * 10000n) / t) / 100}%`);
} } catch {} }
ok("balanceDeltas", `RewardsVault +${formatEther((await bq(rv)) - rv0)} treasury +${formatEther((await bq(tre)) - tr0)} FeeRouter +${formatEther((await bq(B.FeeRouter)) - fr0)} (treasury=${tre}, deployer=${me.address})`);
// SEC-01
try { await pc.simulateContract({ account: me, address: B.LockedLP, abi: llAbi, functionName: "addLockedLiquidity", args: [token, Q, 1n, 1n] }); ok("SEC-01", "UNEXPECTEDLY ALLOWED"); }
catch (e) { ok("SEC-01 addLockedLiquidity from EOA", "rejected: " + (e.cause?.data?.errorName ?? e.shortMessage)); }
// mcapNow
const mcheck = async (tag) => {
  const [m, p, q, lens] = await Promise.all(["mcapNow", "priceNow", "quotePriceUsd"].map((f) => pc.readContract({ address: curve, abi: curveAbi, functionName: f })).concat(pc.readContract({ address: B.MarketLens, abi: lensAbi, functionName: "mcapNow", args: [token] })));
  const exp = (((p * 7_000_000_000n * 10n ** 18n) / 10n ** 18n) * q) / 10n ** 18n;
  ok("mcapNow " + tag, `curve $${formatEther(m)} expected(price*supply*quoteUsd) $${formatEther(exp)} lens $${formatEther(lens)} match=${m === exp}`);
};
await mcheck("pre-grad");
if (process.env.GRADUATE === "1") {
  for (let i = 0; i < 6 && !(await pc.readContract({ address: curve, abi: curveAbi, functionName: "graduated" })); i++) {
    const amt = parseEther("2000");
    if ((await bq(me.address)) < amt) await send("mintTx" + i, { address: Q, abi: erc20, functionName: "mint", args: [me.address, parseEther("20000")] });
    await send("gradBuyTx" + i, { address: curve, abi: curveAbi, functionName: "buy", args: [amt, 0n, dl] });
    ok("progressBps", await pc.readContract({ address: curve, abi: curveAbi, functionName: "progressBps" }));
  }
  ok("graduated", await pc.readContract({ address: curve, abi: curveAbi, functionName: "graduated" }));
  if (res.graduated) await mcheck("post-grad (v4 pool)");
}
ok("ethSpentSmoke", formatEther(bal0 - (await pc.getBalance({ address: me.address }))));
fs.writeFileSync(new URL("../../deployments/rh-testnet-46630.smoke.json", import.meta.url), JSON.stringify(res, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
