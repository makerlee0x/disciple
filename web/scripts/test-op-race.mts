/** On-chain: N concurrent sendCalls from ONE MAv2 account through APP/api/bundler (default localhost:3001) — all must mine.  pnpm test:op-race */
import { createPublicClient, encodeFunctionData, http, parseAbi, parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Mav2Account } from "../lib/aa/mav2";
const { robinhoodTestnet, DEPLOYMENTS } = await import("../lib/chains");
const d = DEPLOYMENTS[46630]; const APP = process.env.APP || "http://localhost:3001";
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const erc20 = parseAbi(["function mint(address,uint256)"]);
const sa = new Mav2Account({ chain: robinhoodTestnet, pc: pc as never, bundlerUrl: `${APP}/api/bundler` }, privateKeyToAccount(generatePrivateKey()));
const me = await sa.address(); console.log("account", me);
await fetch(`${APP}/api/drip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: me }) });
for (let i = 0; i < 100 && (await pc.getBalance({ address: me })) === BigInt(0); i++) await new Promise((r) => setTimeout(r, 200)); // drip mined
console.log("deploy", (await sa.sendCalls([{ to: d.defaultQuote, data: encodeFunctionData({ abi: erc20, functionName: "mint", args: [me, parseEther("1")] }) }])).txHash);
const N = +(process.env.N || 3);
const rs = await Promise.allSettled(Array.from({ length: N }, () => sa.sendCalls([{ to: d.defaultQuote, data: encodeFunctionData({ abi: erc20, functionName: "mint", args: [me, parseEther("1")] }) }])));
rs.forEach((r, i) => console.log(`op${i}`, r.status === "fulfilled" ? "OK " + r.value.txHash : "FAIL " + String((r.reason as Error).message).slice(0, 160)));
if (rs.some((r) => r.status === "rejected")) { console.log("FAIL"); process.exit(1); }
console.log(`ALL OK (${N} concurrent ops)`);
