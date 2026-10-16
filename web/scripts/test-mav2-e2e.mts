/**
 * MAv2 owner flow on RH testnet against a running app (default http://localhost:3000):
 * derive the counterfactual MAv2 address for a fresh owner key (stand-in for the Privy embedded EOA — same viem
 * LocalAccount interface as toViemAccount), drip test ETH via /api/drip, then one self-paid userOp:
 * mint test STRATEGY + approve + DiscipleRouter.buyExactIn on the graduated smoke coin. Prints addresses/tx hashes only.
 *   APP=http://localhost:3000 npx tsx scripts/test-mav2-e2e.mts
 */
import { createPublicClient, encodeFunctionData, http, parseAbi, parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Mav2Account } from "../lib/aa/mav2";

const APP = process.env.APP || "http://localhost:3000";
const { robinhoodTestnet, DEPLOYMENTS, TESTNET_COINS } = await import("../lib/chains");
const d = DEPLOYMENTS[46630];
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const owner = privateKeyToAccount(generatePrivateKey());
const sa = new Mav2Account({ chain: robinhoodTestnet, pc: pc as never, bundlerUrl: `${APP}/api/bundler` }, owner);
const me = await sa.address();
const f = parseAbi(["function getAddressSemiModular(address owner, uint256 salt) view returns (address)"]);
const onchain = await pc.readContract({ address: "0x00000000000017c61b5bEe81050EC8eFc9c6fecd", abi: f, functionName: "getAddressSemiModular", args: [owner.address, BigInt(0)] });
console.log("owner", owner.address, "\nmav2", me, "\nfactory.getAddressSemiModular matches:", onchain.toLowerCase() === me.toLowerCase());
if (onchain.toLowerCase() !== me.toLowerCase()) process.exit(1);
if (process.env.DERIVE_ONLY === "1") process.exit(0);

const drip = await fetch(`${APP}/api/drip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: me }) }).then((r) => r.json());
console.log("drip", drip.ok ? (drip.txHash || drip.reason) : drip.reason);
if (drip.txHash) await pc.waitForTransactionReceipt({ hash: drip.txHash });
for (let i = 0; i < 20 && (await pc.getBalance({ address: me })) === BigInt(0); i++) await new Promise((r) => setTimeout(r, 1000));

const erc20 = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const router = parseAbi(["function buyExactIn(address token, uint256 quoteIn, uint256 minTokensOut, address recipient, uint256 deadline) returns (uint256)"]);
const coin = TESTNET_COINS.graduated as Address, amt = parseEther("10");
const r = await sa.sendCalls([
  { to: d.defaultQuote, data: encodeFunctionData({ abi: erc20, functionName: "mint", args: [me, parseEther("100")] }) },
  { to: d.defaultQuote, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [d.router, amt] }) },
  { to: d.router, data: encodeFunctionData({ abi: router, functionName: "buyExactIn", args: [coin, amt, BigInt(1), me, BigInt(Math.floor(Date.now() / 1000) + 600)] }) },
]);
const bal = await pc.readContract({ address: coin, abi: erc20, functionName: "balanceOf", args: [me] });
console.log("userOp", r.userOpHash, "\ntx", r.txHash, "\ncoin balance", bal.toString(), "\ndeployed", (await pc.getCode({ address: me }))?.length! > 2);
if (bal === BigInt(0)) process.exit(1);
