// Read-only smoke test of the site against the LIVE v4 stack on RH testnet (no keys, no txs: eth_call only).
//   DEPLOYMENT_JSON=../contracts/deployments/rh-testnet-46630.json npx tsx --conditions=react-server scripts/smoke-v4.mts
// 1) every chains.ts / anon.ts default == deployment json  2) read coins (TRENCH/PVP/PVE)  3) quotes (curve, trader-
// specific, USDG route)  4) launchWithMode encode + eth_call for TRENCH/PVP/PVE  5) LoginGate EIP-712 digest parity +
// attest simulation with the attester slot overridden  6) QuotePricer.poke simulation  7) KV trade indexer over v4.
import fs from "node:fs";
import { createPublicClient, decodeFunctionResult, encodeFunctionData, hashTypedData, http, keccak256, pad, parseAbi, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";

const { DEPLOYMENTS, TESTNET_COINS, robinhoodTestnet } = await import("../lib/chains");
const { ANON_ADDONS } = await import("../lib/anon");
const { launchpadAbi, bondingCurveAbi, loginGateAbi, quotePricerAbi } = await import("../lib/abi");
const { readCurveState, readQuote, coinFacts, readAmountOut } = await import("../lib/protocol-viem");
const { encodeLaunchCall, LaunchMode, LAUNCH_ABI_SHAPE } = await import("../lib/launchAbi");
const { usdgRouteQuote } = await import("../lib/trade/usdgRouter");
const { attesterAccount, signLoginAttestation, LOGIN_TYPES } = await import("../lib/pveAttest");

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const dep = JSON.parse(fs.readFileSync(process.env.DEPLOYMENT_JSON || "../contracts/deployments/rh-testnet-46630.json", "utf8"));
const D = DEPLOYMENTS[46630];
const lc = (a: string) => a.toLowerCase();

// 1) addresses
const want: Record<string, string> = {
  launchpad: dep.contracts.Launchpad, hook: dep.contracts.AscensionHook, router: dep.contracts.DiscipleRouter, feeRouter: dep.contracts.FeeRouter,
  referralRegistry: dep.contracts.ReferralRegistry, lockedLP: dep.contracts.LockedLP, quotePricer: dep.contracts.QuotePricer, quoteProbe: dep.contracts.QuoteProbe,
  migration: dep.contracts.Migration, antiSnipe: dep.contracts.AntiSnipe, trampWallManager: dep.contracts.TrampWallManager, marketLens: dep.contracts.MarketLens,
  loginGate: dep.contracts.LoginGate, usdgDepositNotifier: dep.contracts.UsdgDepositNotifier,
  poolManager: dep.uniswapV4.PoolManager, v4Quoter: dep.uniswapV4.V4Quoter, stateView: dep.uniswapV4.StateView, universalRouter: dep.uniswapV4.UniversalRouter, permit2: dep.uniswapV4.Permit2,
  defaultQuote: dep.tokens.STRATEGY.address, usdg: dep.tokens.USDG.address,
};
for (const [k, v] of Object.entries(want)) ok(lc((D as never as Record<string, string>)[k]) === lc(v), `chains.ts ${k} ${(D as never as Record<string, string>)[k]} == json ${v}`);
ok(D.fromBlock === BigInt(dep.startBlock), `fromBlock ${D.fromBlock} == startBlock ${dep.startBlock}`);
ok(lc(ANON_ADDONS[46630].anonLauncher) === lc(dep.contracts.AnonLauncher) && lc(ANON_ADDONS[46630].marketLens) === lc(dep.contracts.MarketLens), "anon.ts AnonLauncher/MarketLens == json");
ok(lc(String(await pc.readContract({ address: D.launchpad, abi: launchpadAbi, functionName: "loginGate" }))) === lc(D.loginGate), "Launchpad.loginGate() == chains loginGate");
const sp = dep.addons.DiscipleSessionPolicy.address as Address;
const mid = await pc.readContract({ address: sp, abi: parseAbi(["function moduleId() pure returns (string)"]), functionName: "moduleId" });
console.log(`     session policy ${sp} moduleId ${mid} (Vercel NEXT_PUBLIC_SESSION_POLICY / _VERSION must match)`);

// 2) read coins
const coins = { TRENCH: TESTNET_COINS.trench, PVE: TESTNET_COINS.pve, PVP: TESTNET_COINS.pvp } as Record<string, Address>;
for (const [m, t] of Object.entries(coins)) {
  const f = await coinFacts(pc as never, t);
  const st = await readCurveState(pc as never, t);
  ok(f.mode === (LaunchMode as Record<string, number>)[m === "TRENCH" ? "TRENCH_WARFARE" : m], `${m} ${t} curve.mode()=${f.mode}; mcap $${st.mcapUsd.toFixed(2)} progress ${st.curveProgressPct}% graduated=${st.graduated}`);
}
// 3) quotes
const buyIn = 10n * 10n ** 18n; // 10 STRATEGY
const qT = await readQuote(pc as never, coins.TRENCH, "buy", buyIn);
ok(qT.amountOut > 0n && qT.venue === "curve", `TRENCH quoteBuy 10 STRATEGY → ${Number(qT.amountOut) / 1e18} tokens, impact ${qT.impactBps}bps, mcapAfter $${qT.mcapAfterUsd.toFixed(2)}`);
const someone = "0x000000000000000000000000000000000000bEEF" as Address;
const qP = await readAmountOut(pc as never, coins.PVP, "buy", buyIn, someone);
ok(qP > 0n, `PVP quoteBuyFor(trader) → ${Number(qP) / 1e18} tokens`);
try { await pc.readContract({ address: (await coinFacts(pc as never, coins.PVE)).curve, abi: bondingCurveAbi, functionName: "quoteBuyFor", args: [someone, buyIn] }); ok(false, "PVE quoteBuyFor(unverified) should revert NotVerified"); }
catch (e) { ok(/NotVerified/.test(String((e as Error).message)), "PVE quoteBuyFor(unverified) reverts NotVerified (attestation required)"); }
const qPveFallback = await readAmountOut(pc as never, coins.PVE, "buy", buyIn, someone);
ok(qPveFallback > 0n, `PVE trade quote falls back to quoteBuy before the attest lands → ${Number(qPveFallback) / 1e18}`);
const sellIn = 1000n * 10n ** 18n;
const pveCurve = (await coinFacts(pc as never, coins.PVE)).curve;
const qs = await pc.readContract({ address: pveCurve, abi: bondingCurveAbi, functionName: "quoteSellFor", args: [dep.deployer, sellIn] }).catch((e) => e as Error);
console.log(`     PVE quoteSellFor(deployer, 1000) → ${qs instanceof Error ? qs.message.split("\n")[0] : `quoteOut ${qs.quoteOut} profitTax ${qs.profitTax}`}`);
const ru = await usdgRouteQuote(pc as never, D.router, coins.TRENCH, true, 10n ** 18n, 0, someone);
ok(ru > 0n, `USDG route quoteUsdgRouteFor(trader) 1 mUSDG → ${Number(ru) / 1e18} TRENCH tokens (NEXT_PUBLIC_PAY_USDG unset ⇒ UI uses native quote unless enabled)`);

// 4) launch encode + eth_call
ok(LAUNCH_ABI_SHAPE === "modes", `launch ABI shape = ${LAUNCH_ABI_SHAPE}`);
const params = { name: "Smoke", ticker: "SMK", imageURI: "https://example.com/i.png", description: "", socialsURI: "", quote: "0x0000000000000000000000000000000000000000" as Address, creatorTaxBps: 0n, creatorBuyQuoteIn: 0n, creatorBuyMinTokensOut: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
for (const [name, mode] of [["TRENCH", 0], ["PVE", 1], ["PVP", 2]] as const) {
  const data = encodeLaunchCall(params, mode);
  ok(data.startsWith(encodeFunctionData({ abi: launchpadAbi, functionName: "launchWithMode", args: [params, mode] }).slice(0, 10)), `${name} encodes launchWithMode(…, ${mode})`);
  try {
    const r = await pc.call({ account: someone, to: D.launchpad, data });
    const res = decodeFunctionResult({ abi: launchpadAbi, functionName: "launchWithMode", data: r.data! }) as { token: Address; curve: Address };
    ok(!!res.token, `${name} launch eth_call OK → token ${res.token} curve ${res.curve}`);
  } catch (e) { ok(false, `${name} launch eth_call: ${String((e as Error).message).split("\n")[0]}`); }
}
try { encodeLaunchCall(params, 3); ok(false, "mode 3 must throw"); } catch { ok(true, "mode 3 rejected client-side (BadMode)"); }

// 5) LoginGate: digest parity + attest simulation with the attester slot overridden to a throwaway key
const acct = attesterAccount({ PVE_ATTESTER_PRIVATE_KEY: generatePrivateKey() })!;
const wallet = someone, expiry = Math.floor(Date.now() / 1000) + 3600, coin = "0x0000000000000000000000000000000000000000" as Address;
const onchainDigest = await pc.readContract({ address: D.loginGate, abi: loginGateAbi, functionName: "digest", args: [wallet, BigInt(expiry), coin] });
const ours = hashTypedData({ domain: { name: "DisciplePVE", version: "1", chainId: 46630, verifyingContract: D.loginGate }, types: LOGIN_TYPES, primaryType: "LoginAttestation", message: { wallet, expiry: BigInt(expiry), coin } });
ok(onchainDigest === ours, `LoginGate.digest == our EIP-712 hash (${ours.slice(0, 18)}…)`);
const slot2 = await pc.getStorageAt({ address: D.loginGate, slot: toHex(2, { size: 32 }) });
ok(lc(`0x${slot2!.slice(26)}`) === lc(dep.deployer), "LoginGate storage: owner @ slot 2 (attester @ slot 3)");
const sig = await signLoginAttestation(acct, { wallet, expiry, coin, chainId: 46630, loginGate: D.loginGate });
const attestData = encodeFunctionData({ abi: loginGateAbi, functionName: "attest", args: [wallet, BigInt(expiry), coin, sig] });
try { await pc.call({ account: someone, to: D.loginGate, data: attestData }); ok(false, "attest without registered attester should revert"); }
catch (e) { ok(/BadSignature|revert/i.test(String((e as Error).message)), "attest reverts BadSignature while LoginGate.attester == 0 (owner must setAttester)"); }
try {
  await pc.call({ account: someone, to: D.loginGate, data: attestData, stateOverride: [{ address: D.loginGate, stateDiff: [{ slot: toHex(3, { size: 32 }), value: pad(acct.address, { size: 32 }) }] }] });
  ok(true, "attest succeeds once attester == our key (state-override simulation)");
} catch (e) { ok(false, `attest with overridden attester: ${String((e as Error).message).split("\n")[0]}`); }

// 6) keeper
try { await pc.simulateContract({ account: someone, address: D.quotePricer, abi: quotePricerAbi, functionName: "poke", args: [D.defaultQuote] }); ok(true, "QuotePricer.poke(STRATEGY) simulates OK (permissionless)"); }
catch (e) { ok(false, `poke: ${String((e as Error).message).split("\n")[0]}`); }

// 7) KV trade indexer (local KV fallback) over the v4 range
process.env.KV_LOCAL_FILE = `/tmp/smoke-kv-${Date.now()}.json`;
const { indexTrades, tradesOf } = await import("../lib/server/trades");
let r = await indexTrades(60_000), passes = 1;
while (BigInt(r.cursor || "0") < BigInt(r.latest || "0") && passes < 10) { r = await indexTrades(60_000); passes++; }
const tf = await tradesOf(coins.TRENCH, null, 100);
ok(tf.length >= 2 && tf.every((f) => f.venue === "curve" && f.mcapUsd > 0), `KV indexer v4: ${tf.length} TRENCH fills (curve Trade decoded), first $${tf[0]?.usd.toFixed(2)} mcap $${tf[0]?.mcapUsd.toFixed(0)}; cursor ${r.cursor}/${r.latest}`);
const pf = await tradesOf(coins.PVP, null, 100);
ok(pf.length >= 1, `KV indexer v4: ${pf.length} PVP fill(s)`);

console.log(fails ? `\n${fails} FAILED` : "\nall smoke checks passed");
process.exit(fails ? 1 : 0);
