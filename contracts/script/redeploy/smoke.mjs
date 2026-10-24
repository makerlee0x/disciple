// Post-redeploy smoke for the single DISCIPLE redeploy (RH testnet 46630 or a local anvil fork of it).
// Checks: 6-dec USDG, referralSink default, SEC-01, 7s per-second sniper tax → snipeEscrow (no 70/30 routing), graduation at
// $33,333 with the 16-band USDG-only floor (~$1,201) and the sniper escrow in the compound bucket; AUDIT fixes (launch-fee
// cap at USDG decimals, claim-router allowlist, graduating-buy gas <= 3.0M).
// Env:
//   PRIVATE_KEY   buyer/launcher key (fork: anvil account 0 by default; never printed)
//   RPC_URL       default https://rpc.testnet.chain.robinhood.com (FORK=1 → http://127.0.0.1:8545)
//   FORK=1        local anvil fork: reads deployments/fork/web-bundle, pins the snipe buy to launch+1s (25%) and uses evm_increaseTime to skip the 7s window
//   BUNDLE        web-bundle dir (default deployments/web-bundle, or deployments/fork/web-bundle with FORK=1)
//   QUOTE         quote token for the smoke coin (default the bundle's USDG; the floor is USDG-only)
//   GRADUATE=1    buy through graduation (default on with FORK=1)
//   EXPECT_REFERRAL_SINK  default 0x000…000 (today's routing)
// ABIs come from the bundle (forge artifacts), so AUDIT's contract fixes need no change here unless an API changes.
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, decodeEventLog, maxUint256, zeroAddress, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const FORK = process.env.FORK === "1";
const BUNDLE = path.resolve(root, process.env.BUNDLE ?? (FORK ? "deployments/fork/web-bundle" : "deployments/web-bundle"));
const bundle = JSON.parse(fs.readFileSync(path.join(BUNDLE, "addresses.json"), "utf8"));
const B = bundle.contracts;
const abi = (n) => JSON.parse(fs.readFileSync(path.join(BUNDLE, "abi", `${n}.json`), "utf8"));
const [lpAbi, curveAbi, llAbi, frAbi] = ["Launchpad", "BondingCurve", "LockedLP", "FeeRouter"].map(abi);
const RPC = process.env.RPC_URL ?? (FORK ? "http://127.0.0.1:8545" : "https://rpc.testnet.chain.robinhood.com");
const chain = { id: 46630, name: "rh-testnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pc = createPublicClient({ chain, transport: http(RPC) });
const me = privateKeyToAccount(process.env.PRIVATE_KEY ?? (FORK ? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" : undefined));
const wc = createWalletClient({ chain, transport: http(RPC), account: me });
const USDG = getAddress(bundle.tokens.USDG.address);
const Q = getAddress(process.env.QUOTE ?? USDG);
const GRADUATE = process.env.GRADUATE ? process.env.GRADUATE === "1" : FORK;
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function mint(address,uint256)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)"]);

const res = { rpc: FORK ? "local anvil fork" : RPC, checks: {}, info: {} };
let fails = 0;
const info = (k, v) => { res.info[k] = v; console.log("  ", k, typeof v === "bigint" ? v.toString() : v); };
const check = (k, pass, detail = "") => { res.checks[k] = { pass, detail }; if (!pass) fails++; console.log(pass ? "PASS" : "FAIL", k, detail); };
const near = (a, b, bps) => (a > b ? a - b : b - a) * 10000n <= b * BigInt(bps);
const rd = (address, a, functionName, args = []) => pc.readContract({ address, abi: a, functionName, args });
const send = async (k, p) => {
  const h = await wc.writeContract({ ...p, account: me });
  const r = await pc.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(k + " reverted " + h);
  info(k + " gasUsed", r.gasUsed);
  return r;
};
const decodeAll = (logs, abis) => logs.flatMap((l) => abis.flatMap((a) => { try { return [{ ...decodeEventLog({ abi: a, ...l }), address: l.address }]; } catch { return []; } }));
const now = async () => (await pc.getBlock()).timestamp;

// 1. config
const dec = await rd(USDG, erc20, "decimals");
check("USDG decimals == 6", dec === 6, `USDG ${USDG} decimals ${dec}`);
const qDec = await rd(Q, erc20, "decimals");
const U = (x) => BigInt(Math.round(x * 1e6)) * 10n ** BigInt(qDec) / 1_000_000n; // human → quote raw
const fmt = (x) => formatUnits(x, qDec);
const sinkWant = getAddress(process.env.EXPECT_REFERRAL_SINK ?? zeroAddress);
const sink = await rd(B.FeeRouter, frAbi, "referralSink");
check("FeeRouter.referralSink default", sink === sinkWant, `${sink} (expected ${sinkWant}; 0 = referrer/launch-KOL routing)`);
const rv = await rd(B.FeeRouter, frAbi, "rewardsVault");
check("FeeRouter.rewardsVault set", rv !== zeroAddress && (!B.RewardsVault || rv === getAddress(B.RewardsVault)), rv);
// AUDIT fixes (contracts/docs/redeploy-runbook.md §11)
const alAbi = abi("AnonLauncher");
const maxFee = await rd(B.AnonLauncher, alAbi, "MAX_LAUNCH_FEE");
check("AnonLauncher.MAX_LAUNCH_FEE == 5 * 10**usdg.decimals()", maxFee === 5n * 10n ** BigInt(dec), `${maxFee} (want ${5n * 10n ** BigInt(dec)}; #115 b6a9117)`);
const lf = await rd(B.AnonLauncher, alAbi, "launchFee");
check("AnonLauncher.launchFee <= MAX_LAUNCH_FEE", lf <= maxFee, `${formatUnits(lf, dec)} USDG`);
check("FeeRouter.isClaimRouter(DiscipleRouter)", (await rd(B.FeeRouter, frAbi, "isClaimRouter", [B.DiscipleRouter])) === true, B.DiscipleRouter);
const rvAbi = abi("RewardsVault");
info("RewardsVault owner / pendingOwner", `${await rd(rv, rvAbi, "owner")} / ${await rd(rv, rvAbi, "pendingOwner")} (Owned2Step: REWARDS_VAULT_OWNER must acceptOwnership)`);

// 2. launch (TRENCH; 10-quote creator buy, which is sniper-exempt)
const ensure = async (amt) => { if ((await rd(Q, erc20, "balanceOf", [me.address])) < amt) await send("mint", { address: Q, abi: erc20, functionName: "mint", args: [me.address, amt * 2n] }); };
await ensure(U(30000));
await send("approveLaunchpad", { address: Q, abi: erc20, functionName: "approve", args: [B.Launchpad, maxUint256] });
const dl = (await now()) + 3600n;
const P = { name: "Smoke " + (Date.now() % 1e5), ticker: "SMK", imageURI: "ipfs://smoke", description: "redeploy smoke", socialsURI: "", quote: Q, creatorTaxBps: 0n, creatorBuyQuoteIn: U(10), creatorBuyMinTokensOut: 0n, deadline: dl };
const sim = await pc.simulateContract({ account: me, address: B.Launchpad, abi: lpAbi, functionName: "launch", args: [P] });
await send("launch", sim.request);
const { token, curve } = sim.result;
info("token", token); info("curve", curve);
const SUPPLY = await rd(token, erc20, "totalSupply");

// 3. SEC-01
try { await pc.simulateContract({ account: me, address: B.LockedLP, abi: llAbi, functionName: "addLockedLiquidity", args: [token, Q, 1n, 1n] }); check("SEC-01 addLockedLiquidity from EOA rejected", false, "UNEXPECTEDLY ALLOWED"); }
catch (e) { check("SEC-01 addLockedLiquidity from EOA rejected", true, e.cause?.data?.errorName ?? e.shortMessage); }

// 4. sniper tax inside the 7s window → snipeEscrow (replaces the old 70/30 SnipeFeeRouted split check).
//    Per-second table (Constants.ANTI_SNIPE_TABLE / FeeMath.snipeBps): 99% · 25% · 3% · 1% · 0.3% · 0.1% · 0.03%, 0 from 7s.
const SNIPE_BPS = [9900n, 2500n, 300n, 100n, 30n, 10n, 3n];
const launchTime = await rd(curve, curveAbi, "launchTime");
const bq = (a) => rd(Q, erc20, "balanceOf", [a]);
const [rv0, esc0] = [await bq(rv), await rd(curve, curveAbi, "snipeEscrow")];
check("First BOOST (creator launch buy) is sniper-exempt", esc0 === 0n, `snipeEscrow after launch ${fmt(esc0)}`);
await send("approveCurve", { address: Q, abi: erc20, functionName: "approve", args: [curve, maxUint256] });
const snipeIn = U(10);
let pinned = false;
if (FORK && (await now()) <= launchTime + 1n) { await pc.request({ method: "evm_setNextBlockTimestamp", params: [Number(launchTime + 1n)] }); pinned = true; }
const r2 = await send("snipeBuy", { address: curve, abi: curveAbi, functionName: "buy", args: [snipeIn, 0n, dl] });
const snipeAt = (await pc.getBlock({ blockNumber: r2.blockNumber })).timestamp - launchTime;
const esc1 = await rd(curve, curveAbi, "snipeEscrow");
const snipeTaken = esc1 - esc0;
const wantBps = snipeAt < 7n ? SNIPE_BPS[Number(snipeAt)] : 0n;
info("snipe buy elapsed since launch (s) / table bps", `${snipeAt} / ${wantBps}${pinned ? " (fork: pinned to launch+1s)" : ""}`);
check("sniper tax inside 7s = table value at the buy's second (mid-window)", snipeAt < 7n && snipeTaken === (snipeIn * wantBps) / 10000n && (!pinned || wantBps === 2500n),
  `${fmt(snipeTaken)} of ${fmt(snipeIn)} at t=${snipeAt}s (want ${wantBps} bps = ${fmt((snipeIn * wantBps) / 10000n)})`);
const routed = decodeAll(r2.logs, [frAbi]).filter((e) => e.eventName === "SnipeFeeRouted");
check("no 70/30 SnipeFeeRouted on a v2 curve", routed.length === 0, `${routed.length} events`);
check("RewardsVault gets nothing at buy time", (await bq(rv)) === rv0, `delta ${fmt((await bq(rv)) - rv0)}`);

// 5. from 7s: tax 0
if (FORK) { await pc.request({ method: "evm_increaseTime", params: [8] }); await pc.request({ method: "evm_mine", params: [] }); }
else { for (let i = 0; i < 6 && (await now()) < launchTime + 7n; i++) await new Promise((r) => setTimeout(r, 2000)); }
check("sniper tax 0 from 7s", (await now()) >= launchTime + 7n && (await rd(curve, curveAbi, "currentSnipeFeeBps")) === 0n, `t=${(await now()) - launchTime}s`);

// 6. graduation
const mcap = async () => rd(curve, curveAbi, "mcapNow");
info("pre-grad mcapNow USD", formatUnits(await mcap(), 18));
if (GRADUATE) {
  const escPre = await rd(curve, curveAbi, "snipeEscrow");
  const amt = U(Number(process.env.GRAD_BUY ?? 9000));
  const gq = await rd(curve, curveAbi, "quoteBuy", [amt]);
  check("quoteBuy(grad size) graduates", gq.graduates === true, `in ${fmt(amt)}, refund ${fmt(gq.refund)}, mcapAfterUsd ${formatUnits(gq.mcapAfterUsd, 18)}`);
  await ensure(amt);
  const r3 = await send("graduationBuy", { address: curve, abi: curveAbi, functionName: "buy", args: [amt, 0n, dl] });
  res.info.graduationGas = r3.gasUsed.toString();
  // tx gasUsed (execution + 21k intrinsic + calldata); AUDIT measured ≈ 2.764M execution at 6-dec USDG. Same 3.0M ceiling as forge FloorSeedGas.
  check("graduating buy gas <= 3.0M (6-dec USDG, ≈2.76M expected)", r3.gasUsed <= 3_000_000n, r3.gasUsed.toString());
  const ev = decodeAll(r3.logs, [curveAbi, llAbi]);
  const g = ev.find((e) => e.eventName === "GraduatedToV4");
  check("graduated (GraduatedToV4 + graduated())", !!g && (await rd(curve, curveAbi, "graduated")), g ? `poolId ${g.args.poolId} tokenLiq ${formatUnits(g.args.tokenLiq, 18)} quoteLiq ${fmt(g.args.quoteLiq)}` : "no event");
  const sold = await rd(curve, curveAbi, "tokensSold");
  check("tokens sold at graduation = 84.24% of supply", near(sold, SUPPLY * 8424n / 10000n, 1), `${formatUnits(sold, 18)} / ${formatUnits(SUPPLY, 18)}`);
  const m = await mcap();
  check("graduation mcap = $33,333 (v4 pool spot, ±0.1%)", near(m, 33333n * 10n ** 18n, 10), `$${formatUnits(m, 18)} (quote-time $${formatUnits(gq.mcapAfterUsd, 18)})`);
  const fs1 = ev.find((e) => e.eventName === "FloorSeeded");
  const [baseTick, bands, quoteSeeded] = await rd(B.LockedLP, llAbi, "floorInfo", [token]);
  check("FloorSeeded event, 16 bands", !!fs1 && Number(fs1.args.bands) === 16 && bands === 16, `event bands ${fs1?.args.bands}, floorInfo bands ${bands}, baseTick ${baseTick}`);
  check("floor quote ≈ $1,201.27 (±1%)", Q === USDG && near(quoteSeeded, U(1201.27), 100), `${fmt(quoteSeeded)} USDG seeded, dust→bucket ${fs1 ? fmt(fs1.args.dustToBucket) : "?"}`);
  const fb = await rd(B.LockedLP, llAbi, "floorBands", [token]);
  const sumQ = fb.reduce((a, b) => a + b.quoteAmount, 0n);
  check("floorBands: 16, USDG-only (tokenAmount 0, quote > 0)", fb.length === 16 && fb.every((b) => b.tokenAmount === 0n && b.quoteAmount > 0n && b.liquidity > 0n), `quote per band ${fb.map((b) => fmt(b.quoteAmount)).join(", ")}`);
  check("floorBands sum ≈ quoteSeeded (±0.01%)", near(sumQ, quoteSeeded, 1), `${fmt(sumQ)} vs ${fmt(quoteSeeded)}`);
  const se = ev.find((e) => e.eventName === "SnipeEscrowToLP");
  const [, bucketQ] = await rd(B.LockedLP, llAbi, "compoundBucket", [token]);
  check("sniper escrow → compound bucket", !!se && se.args.amount === escPre && (await rd(curve, curveAbi, "snipeEscrow")) === 0n && bucketQ >= escPre,
    `escrow ${fmt(escPre)}, SnipeEscrowToLP ${se ? fmt(se.args.amount) : "none"}, bucket quote ${fmt(bucketQ)}`);
  check("progressBps = 10000", (await rd(curve, curveAbi, "progressBps")) === 10000n);
}
res.result = fails === 0 ? "PASS" : `FAIL (${fails})`;
console.log(res.result);
const outDir = path.join(root, "deployments", FORK ? "fork" : "");
fs.writeFileSync(path.join(outDir, "rh-testnet-46630.smoke.json"), JSON.stringify(res, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
process.exit(fails ? 1 : 0);
