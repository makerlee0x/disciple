// Optional: push a smoke coin's curve to graduation and re-check mcapNow on the v4 pool. Env: PRIVATE_KEY, CURVE, TOKEN.
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, formatEther, maxUint256 } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import fs from "node:fs";
const B = JSON.parse(fs.readFileSync(new URL("../../deployments/web-bundle/addresses.json", import.meta.url))).contracts;
const RPC = "https://rpc.testnet.chain.robinhood.com";
const chain = { id: 46630, name: "rh", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pc = createPublicClient({ chain, transport: http(RPC) });
const me = privateKeyToAccount(process.env.PRIVATE_KEY);
const wc = createWalletClient({ chain, transport: http(RPC), account: me });
const Q = "0xd4d0eB01960AACE441bFcb323Bfaf7c3d8b555a3", curve = process.env.CURVE, token = process.env.TOKEN;
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function mint(address,uint256)"]);
const c = parseAbi(["function buy(uint256,uint256,uint256) returns (uint256)", "function buy(uint256,uint256,uint256,address) returns (uint256)", "function mcapNow() view returns (uint256)", "function priceNow() view returns (uint256)", "function graduated() view returns (bool)", "function progressBps() view returns (uint256)", "function quotePriceUsd() view returns (uint256)"]);
const lens = parseAbi(["function mcapNow(address) view returns (uint256)", "function market(address) view returns (uint256,uint256,uint256)"]);
const pricer = parseAbi(["function pricer() view returns (address)"]);
const bal0 = await pc.getBalance({ address: me.address });
const dl = BigInt(Math.floor(Date.now() / 1000) + 900);
const rd = (f) => pc.readContract({ address: curve, abi: c, functionName: f });
// 7% per-wallet cap (WALLET_CAP_BPS): spread buys over throwaway recipient addresses.
let amt = parseEther(process.env.AMT ?? "20000");
let rcpt = privateKeyToAccount(generatePrivateKey()).address;
for (let i = 0; i < 40 && !(await rd("graduated")); i++) {
  if ((await pc.readContract({ address: Q, abi: erc20, functionName: "balanceOf", args: [me.address] })) < amt) {
    const h = await wc.writeContract({ address: Q, abi: erc20, functionName: "mint", args: [me.address, amt * 2n] }); await pc.waitForTransactionReceipt({ hash: h });
  }
  try { await pc.simulateContract({ account: me, address: curve, abi: c, functionName: "buy", args: [amt, 0n, dl, rcpt] }); }
  catch (e) { console.log("sim fail at", formatEther(amt), (e.cause?.signature ?? e.shortMessage)); amt /= 2n; continue; }
  const h = await wc.writeContract({ address: curve, abi: c, functionName: "buy", args: [amt, 0n, dl, rcpt], gas: 8_000_000n });
  const r = await pc.waitForTransactionReceipt({ hash: h });
  rcpt = privateKeyToAccount(generatePrivateKey()).address;
  console.log("buy", formatEther(amt), r.status, h, "gas", r.gasUsed, "progressBps", await rd("progressBps"));
}
const g = await rd("graduated"); console.log("graduated", g);
if (g) {
  const [m, p] = [await rd("mcapNow"), await rd("priceNow")];
  console.log("post-grad mcapNow curve $" + formatEther(m), "lens $" + formatEther(await pc.readContract({ address: B.MarketLens, abi: lens, functionName: "mcapNow", args: [token] })), "priceNow(v4 slot0)", formatEther(p));
}
console.log("ethSpent", formatEther(bal0 - (await pc.getBalance({ address: me.address }))));
