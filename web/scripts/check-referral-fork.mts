/**
 * Referral attribution check on a LOCAL anvil fork of RH testnet 46630 (funnel-and-referral-attribution plan, "Trade check").
 * Nothing here sends to the real chain: it only reads it through the fork. Throwaway random keys, no owner key, no flags.
 *   anvil --fork-url https://rpc.testnet.chain.robinhood.com --port 8546 --chain-id 46630 &
 *   npx tsx scripts/check-referral-fork.mts [coin]
 * Steps: Bob tryAttribute(Bob, Alice) → pending; first touch kept; buy; $10 UsdgDepositNotifier.deposit → referrerOf(Bob)=Alice;
 * buy → TradeFeeRouted.referralPayee; later link cannot replace; a wallet with no link → referral share to treasury.
 */
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, decodeEventLog, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const RPC = process.env.FORK_RPC || "http://127.0.0.1:8546";
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(RPC)) throw new Error("fork RPC only (local anvil)");
const chain = { id: 46630, name: "fork", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pc = createPublicClient({ chain, transport: http(RPC) });
const tc = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
// fresh random throwaway keys, fork only (funded with anvil_setBalance below)
const K = [0, 1, 2, 3].map(() => generatePrivateKey());
const [alice, bob, dave, carol] = K.map((k) => privateKeyToAccount(k));
const REG = "0xfe529086b25c4e0724b88780e5ba9b4ace785aaf" as Address, NOTIFIER = "0xf7b3c09cae8c914530424c5882a24a4160013e9c" as Address;
const USDG = "0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D" as Address, ROUTER = "0x688160633b22012717661545df6299d3d3174ad2" as Address, FEE = "0xa5aaddd75f1bc3b8fb3ecc8845eab0cfa5faed8c" as Address;
const COIN = (process.argv[2] || "0x443cbf068a02809cbcbd76d91a898e423a8eb1e9") as Address;
const reg = parseAbi(["function tryAttribute(address,address) returns (bool)","function referrerOf(address) view returns (address)","function pendingReferrer(address) view returns (address)","function usdgDeposited(address) view returns (uint256)","error AlreadyAttributed()","error SelfReferral()","error NotWalletOrAttestor()"]);
const erc = parseAbi(["function approve(address,uint256) returns (bool)","function balanceOf(address) view returns (uint256)"]);
const noti = parseAbi(["function deposit(address wallet, uint256 amount) returns (uint256)"]);
const rtr = parseAbi(["function buyWithUsdg(address token, uint256 usdgIn, uint256 minTokensOut, uint256 deadline)","function quoteBuyWithUsdg(address token, uint256 usdgIn) returns (uint256)"]);
const fr = parseAbi(["event TradeFeeRouted(address indexed token, address indexed feeToken, address indexed trader, bool feeIsQuote, address creator, uint256 creatorShare, uint256 creatorTaxAmount, uint256 lpShare, uint256 treasuryShare, address referralPayee, uint256 referralShare, address kolPayee, uint256 kolShare)","function tokenLaunchKol(address) view returns (address)","function referralSink() view returns (address)","function treasury() view returns (address)"]);
const wc = (a: typeof bob) => createWalletClient({ account: a, chain, transport: http(RPC) });
const send = async (a: typeof bob, address: Address, abi: any, functionName: string, args: any[]) => {
  try { const { request } = await pc.simulateContract({ account: a, address, abi, functionName, args } as any); const h = await wc(a).writeContract(request as any); const rc = await pc.waitForTransactionReceipt({ hash: h }); return { ok: rc.status === "success", rc, h }; }
  catch (e: any) { return { ok: false, err: e.cause?.data?.errorName ?? e.shortMessage?.slice(0, 120) }; }
};
const view = (f: string, w: Address) => pc.readContract({ address: REG, abi: reg, functionName: f as any, args: [w] });
const who = (a: string) => ({ [alice.address.toLowerCase()]: "Alice", [bob.address.toLowerCase()]: "Bob", [carol.address.toLowerCase()]: "Carol", [dave.address.toLowerCase()]: "Dave" } as Record<string, string>)[a.toLowerCase()] ?? a;
console.log("fork block", await pc.getBlockNumber(), "coin", COIN, "tokenLaunchKol", await pc.readContract({ address: FEE, abi: fr, functionName: "tokenLaunchKol", args: [COIN] }));
console.log("referralSink", await pc.readContract({ address: FEE, abi: fr, functionName: "referralSink" }), "treasury", await pc.readContract({ address: FEE, abi: fr, functionName: "treasury" }));
for (const a of [alice, bob, dave, carol]) await tc.setBalance({ address: a.address, value: 10n ** 18n }); // fork-only gas
const mintAbi = parseAbi(["function mint(address,uint256)"]);
for (const a of [bob, dave]) await send(a, USDG, mintAbi, "mint", [a.address, 100_000_000n]); // open test-USDG mint (what /api/test-cash uses), fork only
console.log("Bob USDG", await pc.readContract({ address: USDG, abi: erc, functionName: "balanceOf", args: [bob.address] }));
const buy = async (a: typeof bob, label: string) => {
  const ap: any = await send(a, USDG, erc, "approve", [ROUTER, 5_000_000n]); if (!ap.ok) console.log(label, "approve failed", ap.err);
  const q = (await pc.simulateContract({ account: a, address: ROUTER, abi: rtr, functionName: "quoteBuyWithUsdg", args: [COIN, 5_000_000n] })).result as bigint;
  const r: any = await send(a, ROUTER, rtr, "buyWithUsdg", [COIN, 5_000_000n, (q * 80n) / 100n, BigInt(Math.floor(Date.now() / 1000) + 3600)]);
  if (!r.ok) return console.log(label, "buy failed:", r.err);
  for (const l of r.rc.logs) if (l.address.toLowerCase() === FEE) { try { const d: any = decodeEventLog({ abi: fr, data: l.data, topics: l.topics }); if (d.eventName === "TradeFeeRouted") console.log(label, "TradeFeeRouted trader", who(d.args.trader), "referralPayee", who(d.args.referralPayee), "referralShare", d.args.referralShare, "treasuryShare", d.args.treasuryShare, "kolPayee", d.args.kolPayee); } catch {} }
};
console.log("1 Bob tryAttribute(Bob, Alice):", (await send(bob, REG, reg, "tryAttribute", [bob.address, alice.address])).ok, "pending", who(await view("pendingReferrer", bob.address) as string), "referrerOf", who(await view("referrerOf", bob.address) as string));
console.log("1b Bob tryAttribute(Bob, Carol) before deposit (first touch):", (await send(bob, REG, reg, "tryAttribute", [bob.address, carol.address])).ok, "pending still", who(await view("pendingReferrer", bob.address) as string));
await buy(bob, "2 Bob buy BEFORE deposit:");
await send(bob, USDG, erc, "approve", [NOTIFIER, 10_000_000n]);
const dep: any = await send(bob, NOTIFIER, noti, "deposit", [bob.address, 10_000_000n]);
console.log("3 Bob notifier.deposit($10):", dep.ok, dep.err ?? "", "usdgDeposited", await view("usdgDeposited", bob.address), "referrerOf", who(await view("referrerOf", bob.address) as string));
await buy(bob, "4 Bob buy AFTER lock:");
const late: any = await send(bob, REG, reg, "tryAttribute", [bob.address, carol.address]);
console.log("5 later link Carol → tryAttribute(Bob, Carol):", late.ok ? "ok" : "revert " + late.err, "referrerOf still", who(await view("referrerOf", bob.address) as string));
await buy(dave, "6 Dave (never opened a link) buy:");
