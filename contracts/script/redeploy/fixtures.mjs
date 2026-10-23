import { createPublicClient, createWalletClient, http, parseAbi, parseEther, formatEther, maxUint256, decodeEventLog } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import fs from "node:fs";
const RPC = "https://rpc.testnet.chain.robinhood.com";
const chain = { id: 46630, name: "rh", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pc = createPublicClient({ chain, transport: http(RPC) });
const me = privateKeyToAccount(process.env.PRIVATE_KEY);
const wc = createWalletClient({ chain, transport: http(RPC), account: me });
const LP = "0x4f540bc1585ca36c8a49662dc642f6e28ae534da", ROUTER = "0xb53c37baa373c22b85fd3bb27fa71b8091abd316", LOCKED = "0x6edb30bce65f87aeb750822de0de36b1cabd3d9a", MIG = "0x37f20243c2cb78613fcfbd58607ce9905cf423b0";
const S = "0xd4d0eB01960AACE441bFcb323Bfaf7c3d8b555a3", U = "0x25030Bff74764aD72b912276a603717DB1C00644";
const OUT = process.env.OUT ?? "fixtures-state.json"; // usage: PRIVATE_KEY=.. node fixtures.mjs fresh|near|grad
const st = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT)) : { coins: {} };
const save = () => fs.writeFileSync(OUT, JSON.stringify(st, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const lp = parseAbi([
  "struct P { string name; string ticker; string imageURI; string description; string socialsURI; address quote; uint256 creatorTaxBps; uint256 creatorBuyQuoteIn; uint256 creatorBuyMinTokensOut; uint256 deadline; }",
  "struct R { address token; address curve; uint256 creatorTokensBought; }",
  "function launchWithMode(P,uint8) returns (R)", "function quoteCreatorBuy(address,uint256) view returns (uint256,uint256,uint256,uint256,bool)"]);
const cv = parseAbi([
  "struct Q { uint256 tokensOut; uint256 fee; uint256 snipeFee; uint256 quoteToCurve; uint256 priceAfterX18; uint256 impactBps; uint256 mcapAfterUsd; bool graduates; uint256 refund; }",
  "function quoteBuy(uint256) view returns (Q)", "function buy(uint256,uint256,uint256,address) returns (uint256)",
  "function graduated() view returns (bool)", "function progressBps() view returns (uint256)", "function mcapNow() view returns (uint256)", "function tokensSold() view returns (uint256)", "function walletCapBps() view returns (uint256)", "function netCapNow() view returns (uint256)", "function currentSnipeFeeBps() view returns (uint256)",
  "event GraduatedToV4(address indexed token, bytes32 poolId, uint256 tokenLiq, uint256 quoteLiq)"]);
const rt = parseAbi(["function buyExactIn(address,uint256,uint256,address,uint256) returns (uint256)", "function sellExactIn(address,uint256,uint256,address,uint256) returns (uint256)",
  "function buyWithUsdg(address,uint256,uint256,uint256) returns (uint256)", "function sellToUsdg(address,uint256,uint256,uint256) returns (uint256)"]);
const send = async (tag, p) => { const h = await wc.writeContract(p); const r = await pc.waitForTransactionReceipt({ hash: h }); console.log(tag, r.status, h, "gas", r.gasUsed); if (r.status !== "success") throw new Error(tag + " reverted " + h); return r; };
const dl = () => BigInt(Math.floor(Date.now() / 1000) + 900);
const rd = (a, f, args = []) => pc.readContract({ address: a, abi: cv, functionName: f, args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bal0 = await pc.getBalance({ address: me.address });
for (const a of [LP, ROUTER]) if ((await pc.readContract({ address: S, abi: erc20, functionName: "allowance", args: [me.address, a] })) < parseEther("1000000000")) await send("approveS " + a, { address: S, abi: erc20, functionName: "approve", args: [a, maxUint256] });
if ((await pc.readContract({ address: U, abi: erc20, functionName: "allowance", args: [me.address, ROUTER] })) < parseEther("1000000")) await send("approveU router", { address: U, abi: erc20, functionName: "approve", args: [ROUTER, maxUint256] });

async function launch(key, name, ticker, creatorBuy) {
  if (st.coins[key]?.token) return st.coins[key];
  const P = { name, ticker, imageURI: "ipfs://replay-fixture", description: "testnet replay fixture (" + key + ")", socialsURI: "", quote: S, creatorTaxBps: 0n, creatorBuyQuoteIn: creatorBuy, creatorBuyMinTokensOut: 0n, deadline: dl() };
  const sim = await pc.simulateContract({ account: me, address: LP, abi: lp, functionName: "launchWithMode", args: [P, 0], gas: 7_000_000n });
  const r = await send("launch " + ticker, { ...sim.request, gas: 7_000_000n });
  const c = { name, symbol: ticker, mode: 0, token: sim.result.token, curve: sim.result.curve, launchTx: r.transactionHash, launchGas: r.gasUsed, creatorBuyStrategy: formatEther(creatorBuy), creatorTokens: formatEther(sim.result.creatorTokensBought), buys: [] };
  st.coins[key] = c; save(); return c;
}
async function approveCurve(c) { if (!c.approved) { await send("approveS curve", { address: S, abi: erc20, functionName: "approve", args: [c.curve, maxUint256] }); c.approved = true; save(); } }
async function waitSnipe(c) { while ((await rd(c.curve, "currentSnipeFeeBps")) > 0n) await sleep(2000); }
async function buyTo(c, targetBps, allowGrad) {
  await approveCurve(c); await waitSnipe(c);
  const cap = await rd(c.curve, "netCapNow"); const SC = 5_040_000_000n * 10n ** 18n;
  let amt = parseEther(process.env.CHUNK ?? "2000000");
  for (let i = 0; i < 40 && !(await rd(c.curve, "graduated")); i++) {
    const prog = await rd(c.curve, "progressBps");
    if (!allowGrad && prog >= targetBps) break;
    const q = await rd(c.curve, "quoteBuy", [amt]);
    if (q.tokensOut > cap || (!allowGrad && q.graduates)) { amt /= 2n; continue; }
    if (!allowGrad) { const sold = await rd(c.curve, "tokensSold"); if ((sold + q.tokensOut) * 10000n / SC > BigInt(targetBps) + 300n) { amt = amt * 2n / 3n; continue; } }
    const rcpt = privateKeyToAccount(generatePrivateKey()).address;
    const r = await send(`buy ${c.symbol} ${formatEther(amt)}`, { address: c.curve, abi: cv, functionName: "buy", args: [amt, 0n, dl(), rcpt], gas: allowGrad && q.graduates ? 8_000_000n : 1_500_000n });
    let poolId;
    for (const l of r.logs) { try { const d = decodeEventLog({ abi: cv, ...l }); if (d.eventName === "GraduatedToV4") poolId = d.args.poolId; } catch {} }
    c.buys.push({ strategyIn: formatEther(amt), tx: r.transactionHash, recipient: rcpt, graduated: !!poolId }); if (poolId) { c.poolId = poolId; c.graduationTx = r.transactionHash; }
    console.log(" progressBps", await rd(c.curve, "progressBps")); save();
  }
}
const which = process.argv[2];
if (which === "fresh") { const c = await launch("fresh", "Replay Fresh", "RPFR", parseEther("1000")); }
if (which === "near") { const c = await launch("near", "Replay Near", "RPNR", parseEther("1000")); await buyTo(c, 9000, false); }
if (which === "grad") { const c = await launch("grad", "Replay Grad", "RPGD", parseEther("1000")); await buyTo(c, 10000, true);
  if (await rd(c.curve, "graduated")) {
    const b0 = await pc.readContract({ address: c.token, abi: erc20, functionName: "balanceOf", args: [me.address] });
    const rb = await send("router buyExactIn", { address: ROUTER, abi: rt, functionName: "buyExactIn", args: [c.token, parseEther("10000"), 1n, me.address, dl()], gas: 1_500_000n });
    const got = (await pc.readContract({ address: c.token, abi: erc20, functionName: "balanceOf", args: [me.address] })) - b0;
    await send("approve token router", { address: c.token, abi: erc20, functionName: "approve", args: [ROUTER, maxUint256] });
    const s0 = await pc.readContract({ address: S, abi: erc20, functionName: "balanceOf", args: [me.address] });
    const rs = await send("router sellExactIn", { address: ROUTER, abi: rt, functionName: "sellExactIn", args: [c.token, got / 2n, 1n, me.address, dl()], gas: 1_500_000n });
    const sGot = (await pc.readContract({ address: S, abi: erc20, functionName: "balanceOf", args: [me.address] })) - s0;
    const ru = await send("router buyWithUsdg", { address: ROUTER, abi: rt, functionName: "buyWithUsdg", args: [c.token, parseEther("20"), 1n, dl()], gas: 2_000_000n });
    const rsu = await send("router sellToUsdg", { address: ROUTER, abi: rt, functionName: "sellToUsdg", args: [c.token, got / 4n, 1n, dl()], gas: 2_000_000n });
    c.postGrad = { buyExactInTx: rb.transactionHash, strategyIn: "10000", tokensOut: formatEther(got), sellExactInTx: rs.transactionHash, tokensSold: formatEther(got / 2n), strategyOut: formatEther(sGot), buyWithUsdgTx: ru.transactionHash, sellToUsdgTx: rsu.transactionHash };
    save();
  }
}
for (const [k, c] of Object.entries(st.coins)) { c.progressBps = await rd(c.curve, "progressBps"); c.graduated = await rd(c.curve, "graduated"); c.mcapUsd = formatEther(await rd(c.curve, "mcapNow")); }
st.ethSpent = (st.ethSpent ? Number(st.ethSpent) : 0) + Number(formatEther(bal0 - (await pc.getBalance({ address: me.address }))));
save(); console.log(JSON.stringify(Object.fromEntries(Object.entries(st.coins).map(([k, c]) => [k, [c.token, c.progressBps, c.graduated, c.mcapUsd]])), (k, v) => (typeof v === "bigint" ? v.toString() : v)), "ethSpent", st.ethSpent);
