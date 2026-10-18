// Read-only live checks of every claim read + claim simulation against the v4 stack (eth_call only, no txs).
//   npx tsx scripts/live-claims-v4.mts
import { createPublicClient, decodeErrorResult, encodeFunctionData, http, type Abi, type Address, type Hex } from "viem";
import { robinhoodTestnet } from "../lib/chains";
import { DEPLOYMENTS } from "../lib/chains";
import { anonLauncherAbi, bondingCurveAbi, feeRouterAbi, launchpadAbi, referralRegistryAbi, tokenAbi, usdgDepositNotifierAbi } from "../lib/abi";
import { ANON_ADDONS } from "../lib/anon";

const d = DEPLOYMENTS[robinhoodTestnet.id];
const AL = ANON_ADDONS[robinhoodTestnet.id].anonLauncher;
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http(process.env.NEXT_PUBLIC_RHT_RPC_URL || undefined) });
const ABIS = [feeRouterAbi, launchpadAbi, bondingCurveAbi, usdgDepositNotifierAbi, anonLauncherAbi, tokenAbi, referralRegistryAbi] as Abi[];
const errName = (e: unknown) => {
  for (let x = e as { data?: unknown; cause?: unknown } | undefined, i = 0; x && i < 10; x = x.cause as typeof x, i++) {
    const v = typeof x.data === "string" ? x.data : (x.data as { data?: unknown } | undefined)?.data;
    if (typeof v === "string" && v.startsWith("0x")) for (const abi of ABIS) { try { const r = decodeErrorResult({ abi, data: v as Hex }); return `${r.errorName}(${(r.args ?? []).join(",")})`; } catch { /* */ } }
  }
  return (e as Error).message.split("\n")[0].slice(0, 100);
};
const sim = async (label: string, from: Address, to: Address, data: Hex) => {
  try { const r = await pc.call({ account: from, to, data }); console.log(`  SIM ${label}: ok ${r.data?.slice(0, 66)}`); }
  catch (e) { console.log(`  SIM ${label}: revert ${errName(e)}`); }
};
const fmt = (v: bigint) => v.toString();

console.log("chain", robinhoodTestnet.id, "block", await pc.getBlockNumber());
console.log("launchpad", d.launchpad, "feeRouter", d.feeRouter, "notifier", d.usdgDepositNotifier, "anon", AL);

const logs = await pc.getContractEvents({ address: d.launchpad, abi: launchpadAbi, eventName: "Launched", fromBlock: d.fromBlock, toBlock: "latest" });
console.log("Launched events:", logs.length);
const coins = (logs as unknown as { args: { token: Address; curve: Address; creator: Address; quote: Address; ticker: string } }[]).slice(-12);
for (const l of coins) {
  const { token, creator, ticker } = l.args;
  const [curve, mode, creatorNow] = await Promise.all([
    pc.readContract({ address: d.launchpad, abi: launchpadAbi, functionName: "curveOf", args: [token] }),
    pc.readContract({ address: d.launchpad, abi: launchpadAbi, functionName: "modeOf", args: [token] }),
    pc.readContract({ address: d.launchpad, abi: launchpadAbi, functionName: "creatorOf", args: [token] }),
  ]);
  const [qa, ta, pr] = await Promise.all([
    pc.readContract({ address: d.feeRouter, abi: feeRouterAbi, functionName: "creatorAccrued", args: [token, creatorNow] }),
    pc.readContract({ address: d.feeRouter, abi: feeRouterAbi, functionName: "creatorTokenAccrued", args: [token, creatorNow] }),
    pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "pendingRewards", args: [creatorNow] }),
  ]);
  console.log(`$${ticker} ${token} mode=${mode} curve=${curve} creator=${creatorNow}${creatorNow.toLowerCase() === AL.toLowerCase() ? " (AnonLauncher)" : ""}`);
  console.log(`  creatorAccrued=${fmt(qa)} creatorTokenAccrued=${fmt(ta)} pendingRewards(creator)=${fmt(pr)}`);
  if (creatorNow.toLowerCase() === AL.toLowerCase()) {
    const so = await pc.readContract({ address: AL, abi: anonLauncherAbi, functionName: "stealthOwnerOf", args: [token] });
    const p = await pc.readContract({ address: AL, abi: anonLauncherAbi, functionName: "pending", args: [token] });
    console.log(`  anon stealthOwner=${so} pending=${p.map(String).join(",")}`);
    await sim("AnonLauncher.claimMany", so, AL, encodeFunctionData({ abi: anonLauncherAbi, functionName: "claimMany", args: [[token], so] }));
  } else {
    await sim("FeeRouter.claimCreatorFees", creatorNow, d.feeRouter, encodeFunctionData({ abi: feeRouterAbi, functionName: "claimCreatorFees", args: [token] }));
    await sim("FeeRouter.claimCreatorTokenFees", creatorNow, d.feeRouter, encodeFunctionData({ abi: feeRouterAbi, functionName: "claimCreatorTokenFees", args: [token] }));
  }
  if (Number(mode) === 1) await sim("Launchpad.claim (crew, as creator)", creatorNow, d.launchpad, encodeFunctionData({ abi: launchpadAbi, functionName: "claim", args: [token] }));
  void creator;
}

// PVE crew: find a seller-taxed coin + a holder with pending rewards
const pve = [];
for (const l of logs as unknown as { args: { token: Address; curve: Address } }[]) {
  const m = await pc.readContract({ address: d.launchpad, abi: launchpadAbi, functionName: "modeOf", args: [l.args.token] });
  if (Number(m) === 1) pve.push(l.args);
}
console.log("PVE coins:", pve.length);
for (const c of pve.slice(-5)) {
  const tax = await pc.getContractEvents({ address: c.curve, abi: bondingCurveAbi, eventName: "ProfitTaxCharged", fromBlock: d.fromBlock, toBlock: "latest" });
  const cl = await pc.getContractEvents({ address: c.curve, abi: bondingCurveAbi, eventName: "HolderRewardsClaimed", fromBlock: d.fromBlock, toBlock: "latest" });
  const held = await pc.readContract({ address: c.curve, abi: bondingCurveAbi, functionName: "rewardsHeld" });
  console.log(`  PVE ${c.token}: ProfitTaxCharged=${tax.length} HolderRewardsClaimed=${cl.length} rewardsHeld=${held}`);
  const buys = await pc.getContractEvents({ address: c.curve, abi: bondingCurveAbi, eventName: "Trade", fromBlock: d.fromBlock, toBlock: "latest" }).catch(() => []);
  const traders = Array.from(new Set((buys as unknown as { args: { trader?: Address } }[]).map((b) => b.args.trader).filter(Boolean))) as Address[];
  for (const t of traders.slice(0, 4)) {
    const p = await pc.readContract({ address: c.curve, abi: bondingCurveAbi, functionName: "pendingRewards", args: [t] });
    console.log(`    holder ${t} pendingRewards=${p}`);
    await sim("Launchpad.claim", t, d.launchpad, encodeFunctionData({ abi: launchpadAbi, functionName: "claim", args: [c.token] }));
  }
}

// Referral: referrerAccrued(referrer, quote) for the referrers seen on-chain
const att = await pc.getContractEvents({ address: d.referralRegistry, abi: referralRegistryAbi, eventName: "ReferrerAttributed", fromBlock: d.fromBlock, toBlock: "latest" });
const pend = await pc.getContractEvents({ address: d.referralRegistry, abi: referralRegistryAbi, eventName: "ReferrerPending", fromBlock: d.fromBlock, toBlock: "latest" });
console.log(`ReferrerAttributed=${att.length} ReferrerPending=${pend.length} usdgGate=${await pc.readContract({ address: d.referralRegistry, abi: referralRegistryAbi, functionName: "usdgGate" })}`);
const refs = Array.from(new Set([...att, ...pend].map((l) => (l as unknown as { args: { referrer: Address } }).args.referrer))).slice(0, 4);
const probeRef = refs[0] ?? coins[0]?.args.creator;
for (const r of [probeRef].concat(refs.slice(1))) {
  if (!r) continue;
  for (const q of [d.defaultQuote, d.usdg]) {
    const v = await pc.readContract({ address: d.feeRouter, abi: feeRouterAbi, functionName: "referrerAccrued", args: [r, q] });
    console.log(`  referrerAccrued(${r}, ${q})=${v}`);
    await sim("FeeRouter.claimReferrerFees", r, d.feeRouter, encodeFunctionData({ abi: feeRouterAbi, functionName: "claimReferrerFees", args: [q] }));
  }
}

// Deposit notifier
const N = d.usdgDepositNotifier;
const [min, lock, usdg] = await Promise.all([
  pc.readContract({ address: N, abi: usdgDepositNotifierAbi, functionName: "minDeposit" }),
  pc.readContract({ address: N, abi: usdgDepositNotifierAbi, functionName: "LOCK_PERIOD" }),
  pc.readContract({ address: N, abi: usdgDepositNotifierAbi, functionName: "usdg" }),
]);
const [sym, dec] = await Promise.all([pc.readContract({ address: usdg, abi: tokenAbi, functionName: "symbol" }), pc.readContract({ address: usdg, abi: tokenAbi, functionName: "decimals" })]);
console.log(`notifier minDeposit=${min} (${Number(min) / 10 ** Number(dec)} ${sym}) LOCK_PERIOD=${lock}s usdg=${usdg} (deployment usdg=${d.usdg})`);
const esc = await pc.getContractEvents({ address: N, abi: usdgDepositNotifierAbi, eventName: "Escrowed", fromBlock: d.fromBlock, toBlock: "latest" });
console.log("Escrowed events:", esc.length);
const w = (esc[0] as unknown as { args: { wallet: Address } } | undefined)?.args.wallet ?? coins[0]?.args.creator;
if (w) {
  const n = await pc.readContract({ address: N, abi: usdgDepositNotifierAbi, functionName: "escrowCount", args: [w] });
  console.log(`  escrowCount(${w})=${n} escrowedOf=${await pc.readContract({ address: N, abi: usdgDepositNotifierAbi, functionName: "escrowedOf", args: [w] })}`);
  for (let i = BigInt(0); i < n && i < BigInt(3); i++) {
    const [amt, at] = await pc.readContract({ address: N, abi: usdgDepositNotifierAbi, functionName: "escrowOf", args: [w, i] });
    console.log(`  escrowOf(${i}) amount=${amt} unlockAt=${new Date(Number(at) * 1000).toISOString()}`);
  }
  await sim("withdraw([0])", w, N, encodeFunctionData({ abi: usdgDepositNotifierAbi, functionName: "withdraw", args: [[BigInt(0)]] }));
  await sim("deposit(w, min-1)", w, N, encodeFunctionData({ abi: usdgDepositNotifierAbi, functionName: "deposit", args: [w, min - BigInt(1)] }));
  await sim("deposit(w, min) w/o approve", w, N, encodeFunctionData({ abi: usdgDepositNotifierAbi, functionName: "deposit", args: [w, min] }));
}
