// RH testnet: ONE buy ($5 USDG) + ONE 10% sell through the app's /api/bundler + /api/paymaster (this branch's mav2.ts).
// Counts UserOperationEvents for the fresh account: exactly one per send, no duplicates. Prints addresses / hashes only.
import { createPublicClient, encodeFunctionData, http, parseAbi, parseUnits, formatUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Mav2Account } from "../lib/aa/mav2";
import { routerBuyWithUsdgCalls, routerSellToUsdgCalls, toCalls, usdgRouteQuote } from "../lib/trade/usdgRouter";
import { applySlippage } from "../lib/curveMath";
const APP = process.env.APP!;
const { robinhoodTestnet, DEPLOYMENTS, TESTNET_COINS } = await import("../lib/chains");
const d = DEPLOYMENTS[46630]; const COIN = (process.env.COIN || TESTNET_COINS.graduated) as Address;
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const erc20 = parseAbi(["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"]);
const uoEv = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"]);
const bal = (t: Address, a: Address) => pc.readContract({ address: t, abi: erc20, functionName: "balanceOf", args: [a] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const owner = privateKeyToAccount(generatePrivateKey());
const boot = new Mav2Account({ chain: robinhoodTestnet, pc: pc as never, bundlerUrl: `${APP}/api/bundler` }, owner);
const sa = new Mav2Account({ chain: robinhoodTestnet, pc: pc as never, bundlerUrl: `${APP}/api/bundler`, usdgGas: { paymaster: d.paymaster, usdg: d.usdg, url: `${APP}/api/paymaster`, session: false } }, owner);
const me = await sa.address(); const from = await pc.getBlockNumber();
console.log("APP", APP, "\ncoin", COIN, "\naccount", me);
const drip = await fetch(`${APP}/api/drip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: me }) }).then((r) => r.json());
console.log("drip", drip.ok, drip.txHash ?? drip.reason); if (drip.txHash) await pc.waitForTransactionReceipt({ hash: drip.txHash });
for (let i = 0; i < 100 && (await pc.getBalance({ address: me })) === BigInt(0); i++) await sleep(200);
const m = await boot.sendCalls([{ to: d.usdg, data: encodeFunctionData({ abi: erc20, functionName: "mint", args: [me, parseUnits("50", 6)] }) }], "owner");
console.log("mint 50 USDG", m.txHash); await pc.waitForTransactionReceipt({ hash: m.txHash as Hex }); await sa.warm();
let usdg0 = BigInt(0); for (let i = 0; i < 50 && !usdg0; i++) { usdg0 = await bal(d.usdg, me); if (!usdg0) await sleep(300); }
const dl = () => BigInt(Math.floor(Date.now() / 1000) + 300);
const usdgIn = parseUnits("5", 6);
const qb = await usdgRouteQuote(pc as never, d.router, COIN, true, usdgIn, 0, me, true);
const buy = await sa.sendCalls(toCalls(routerBuyWithUsdgCalls({ router: d.router, usdg: d.usdg, token: COIN, usdgIn, minTokensOut: applySlippage(qb, 300), deadline: dl() })), "owner");
await pc.waitForTransactionReceipt({ hash: buy.txHash as Hex });
let tok = BigInt(0); for (let i = 0; i < 50 && tok === BigInt(0); i++) { tok = await bal(COIN, me); if (!tok) await sleep(300); }
const usdg1 = await bal(d.usdg, me);
console.log(`BUY  ${buy.txHash}  usdg -${formatUnits(usdg0 - usdg1, 6)} (incl gas)  tokens +${formatUnits(tok, 18)}`);
const sellAmt = tok / BigInt(10);
const qs = await usdgRouteQuote(pc as never, d.router, COIN, false, sellAmt, 0, me, true);
const sell = await sa.sendCalls(toCalls(routerSellToUsdgCalls({ router: d.router, token: COIN, tokensIn: sellAmt, minUsdgOut: applySlippage(qs, 300), deadline: dl() })), "owner");
await pc.waitForTransactionReceipt({ hash: sell.txHash as Hex });
let tok2 = tok; for (let i = 0; i < 50 && tok2 === tok; i++) { tok2 = await bal(COIN, me); if (tok2 === tok) await sleep(300); }
const usdg2 = await bal(d.usdg, me);
console.log(`SELL ${sell.txHash}  tokens -${formatUnits(tok - tok2, 18)} (${Number((tok - tok2) * BigInt(10000) / tok) / 100}% of bag)  usdg net +${formatUnits(usdg2 - usdg1, 6)}`);
await sleep(4000);
const ev = await pc.getLogs({ address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", event: uoEv[0], args: { sender: me }, fromBlock: from, toBlock: await pc.getBlockNumber() });
console.log("UserOperationEvents for account:", ev.length, "(expect 3: mint, buy, sell)", ev.map((e) => `${e.transactionHash.slice(0, 10)} ok=${e.args.success}`).join(" "));
const pass = ev.length === 3 && ev.every((e) => e.args.success) && tok - tok2 === sellAmt;
console.log(pass ? "PASS: one buy + one 10% sell, no duplicates" : "FAIL"); process.exit(pass ? 0 : 1);
