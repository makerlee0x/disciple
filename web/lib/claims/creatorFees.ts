/**
 * Creator dashboard data + claim calls (v4 FeeRouter, generated ABI lib/abi/FeeRouter.ts):
 *   quote side  creatorAccrued(token, creator) / claimCreatorFees(token)           → CreatorFeesClaimed(token, creator, amount)
 *   token side  creatorTokenAccrued(token, creator) / claimCreatorTokenFees(token) → CreatorTokenFeesClaimed(token, creator, amount)
 *               (post-graduation buys pay the creator share in the launch token)
 *   history     TradeFeeRouted(token, feeToken, trader, feeIsQuote, creator, creatorShare, creatorTaxAmount, …)
 *   pseudonymous AnonLauncher.pending(token) → (quote, quoteAmt, tokenAmt) / claimMany(tokens, to) — only the stealth owner
 * Claims go through lib/wallet.execCalls (smart account userOp, owner-signed; or the legacy EOA path), the same sender
 * the trade flow uses. Balances are always read live on-chain.
 */
import { decodeEventLog, encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { anonLauncherAbi, bondingCurveAbi, feeRouterAbi, launchpadAbi, tokenAbi } from "../abi";
import { deployment } from "../chains";
import type { Call } from "../aa/core";
import { execCalls } from "../wallet";
import { anonLauncherAddr, type Caps } from "./capabilities";
import { assetMeta, lc, type Asset } from "./common";

const ZERO = BigInt(0);
export type Accrual = { amount: bigint; trader: Address; tx: Hex; block: bigint; ts?: number; side: "quote" | "token" };
export type CreatorRocket = {
  token: Address; name: string; ticker: string; quote: Asset;
  claimable: bigint; claimed: bigint; lifetime: bigint;
  recent: Accrual[];
  /** launch-token share (post-grad). null when the cap is off. */
  tokenSide: { asset: Asset; claimable: bigint; claimed: bigint } | null;
  /** pseudonymous launch: claimed through AnonLauncher.claimMany by the stealth owner */
  anon?: boolean;
};

type Launch = { token: Address; name: string; ticker: string; quote: Address; block: bigint };

/** Rockets launched by `me` (Launched.creator is indexed), newest first. Current creatorOf must still be `me`. */
export async function createdRockets(pc: PublicClient, me: Address): Promise<Launch[]> {
  const d = deployment();
  const logs = await pc.getContractEvents({ address: d.launchpad, abi: launchpadAbi, eventName: "Launched", args: { creator: me }, fromBlock: d.fromBlock, toBlock: "latest" });
  const out = (logs as unknown as { args: Record<string, unknown>; blockNumber: bigint }[]).map((l) => ({
    token: l.args.token as Address, name: String(l.args.name), ticker: String(l.args.ticker), quote: l.args.quote as Address, block: l.blockNumber,
  }));
  // creator rights can move (CreatorTransferred): keep only rockets `me` still controls
  const still = await Promise.all(out.map((r) => pc.readContract({ address: d.launchpad, abi: launchpadAbi, functionName: "creatorOf", args: [r.token] }).then((c) => lc(c as string) === lc(me)).catch(() => true)));
  return out.filter((_, i) => still[i]).sort((a, b) => (a.block > b.block ? -1 : 1));
}

/** Is `me` the creator of `token`? (coin page card) */
export async function isCreatorOf(pc: PublicClient, token: Address, me: Address): Promise<boolean> {
  const c = await pc.readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "creatorOf", args: [token] }).catch(() => null);
  return !!c && lc(c as string) === lc(me);
}

async function quoteOfToken(pc: PublicClient, token: Address): Promise<Address> {
  const curve = await pc.readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "curveOf", args: [token] });
  return pc.readContract({ address: curve as Address, abi: bondingCurveAbi, functionName: "quote" }) as Promise<Address>;
}

/** Live claimable creator fees for one rocket (quote raw). */
export function creatorClaimable(pc: PublicClient, token: Address, me: Address): Promise<bigint> {
  return pc.readContract({ address: deployment().feeRouter, abi: feeRouterAbi, functionName: "creatorAccrued", args: [token, me] }) as Promise<bigint>;
}
export function creatorTokenClaimable(pc: PublicClient, token: Address, me: Address): Promise<bigint> {
  return pc.readContract({ address: deployment().feeRouter, abi: feeRouterAbi, functionName: "creatorTokenAccrued", args: [token, me] }) as Promise<bigint>;
}

type ClaimLog = { args: { token: Address; amount: bigint } };
const sumFor = (logs: ClaimLog[], token: Address) => logs.filter((l) => lc(l.args.token) === lc(token)).reduce((a, l) => a + l.args.amount, ZERO);

/** Full dashboard rows: wallet-created rockets + pseudonymous rockets this wallet is the stealth owner of. */
export async function creatorDashboard(pc: PublicClient, me: Address, caps: Caps, recentN = 6): Promise<CreatorRocket[]> {
  const d = deployment();
  const [rockets, anon] = await Promise.all([createdRockets(pc, me), caps.anonClaims ? anonRockets(pc, me).catch(() => []) : Promise.resolve([])]);
  if (!rockets.length && !anon.length) return [];
  const ev = (eventName: "CreatorFeesClaimed" | "CreatorTokenFeesClaimed") =>
    pc.getContractEvents({ address: d.feeRouter, abi: feeRouterAbi, eventName, args: { creator: me }, fromBlock: d.fromBlock, toBlock: "latest" }).catch(() => []) as Promise<unknown> as Promise<ClaimLog[]>;
  const [claimLogs, tokenClaimLogs] = await Promise.all([ev("CreatorFeesClaimed"), caps.creatorTokenFees ? ev("CreatorTokenFeesClaimed") : Promise.resolve([] as ClaimLog[])]);
  const own = await Promise.all(rockets.map(async (r): Promise<CreatorRocket> => {
    const quote = await assetMeta(pc, r.quote || (await quoteOfToken(pc, r.token)));
    const [claimable, recent] = await Promise.all([creatorClaimable(pc, r.token, me).catch(() => ZERO), recentAccruals(pc, r.token, recentN)]);
    const claimed = sumFor(claimLogs, r.token);
    let tokenSide: CreatorRocket["tokenSide"] = null;
    if (caps.creatorTokenFees) {
      const [asset, tc] = await Promise.all([assetMeta(pc, r.token), creatorTokenClaimable(pc, r.token, me).catch(() => ZERO)]);
      tokenSide = { asset, claimable: tc, claimed: sumFor(tokenClaimLogs, r.token) };
    }
    return { token: r.token, name: r.name, ticker: r.ticker, quote, claimable, claimed, lifetime: claimed + claimable, recent, tokenSide };
  }));
  return [...own, ...anon];
}

/** Last `n` creator accruals for a rocket from v4 TradeFeeRouted (creatorShare + creatorTaxAmount; feeIsQuote picks the unit). */
export async function recentAccruals(pc: PublicClient, token: Address, n = 6): Promise<Accrual[]> {
  const d = deployment();
  const logs = (await pc.getContractEvents({ address: d.feeRouter, abi: feeRouterAbi, eventName: "TradeFeeRouted", args: { token }, fromBlock: d.fromBlock, toBlock: "latest" }).catch(() => [])) as unknown as
    { args: { trader: Address; feeIsQuote: boolean; creatorShare: bigint; creatorTaxAmount: bigint }; transactionHash: Hex; blockNumber: bigint }[];
  return logs.filter((l) => l.args.creatorShare + l.args.creatorTaxAmount > ZERO).slice(-n).reverse().map((l) => ({
    amount: l.args.creatorShare + l.args.creatorTaxAmount, trader: l.args.trader, tx: l.transactionHash, block: l.blockNumber, side: l.args.feeIsQuote ? "quote" : "token",
  }));
}

/* ---------------- pseudonymous launches (AnonLauncher; stealth owner = msg.sender of claimMany) ---------------- */
/** Rockets whose AnonLauncher stealth owner is `me` right now, with live pending(token). */
export async function anonRockets(pc: PublicClient, me: Address): Promise<CreatorRocket[]> {
  const al = anonLauncherAddr();
  if (!al) return [];
  const d = deployment();
  const [launched, moved, claimedLogs] = await Promise.all([
    pc.getContractEvents({ address: al, abi: anonLauncherAbi, eventName: "AnonLaunched", args: { stealthOwner: me }, fromBlock: d.fromBlock, toBlock: "latest" }).catch(() => []),
    pc.getContractEvents({ address: al, abi: anonLauncherAbi, eventName: "StealthOwnerTransferred", args: { to: me }, fromBlock: d.fromBlock, toBlock: "latest" }).catch(() => []),
    pc.getContractEvents({ address: al, abi: anonLauncherAbi, eventName: "Claimed", args: { stealthOwner: me }, fromBlock: d.fromBlock, toBlock: "latest" }).catch(() => []),
  ]);
  const tokens = Array.from(new Set([...launched, ...moved].map((l) => lc((l as unknown as { args: { token: string } }).args.token)))) as Address[];
  const claims = claimedLogs as unknown as { args: { token: Address; asset: Address; amount: bigint } }[];
  const rows = await Promise.all(tokens.map(async (token): Promise<CreatorRocket | null> => {
    const owner = await pc.readContract({ address: al, abi: anonLauncherAbi, functionName: "stealthOwnerOf", args: [token] }).catch(() => null);
    if (!owner || lc(owner as string) !== lc(me)) return null;
    const [q, qAmt, tAmt] = (await pc.readContract({ address: al, abi: anonLauncherAbi, functionName: "pending", args: [token] })) as readonly [Address, bigint, bigint];
    const [quote, asset, name, ticker] = await Promise.all([
      assetMeta(pc, q), assetMeta(pc, token),
      pc.readContract({ address: token, abi: tokenAbi, functionName: "name" }).catch(() => "Rocket"),
      pc.readContract({ address: token, abi: tokenAbi, functionName: "symbol" }).catch(() => "?"),
    ]);
    const mine = claims.filter((c) => lc(c.args.token) === token);
    const cq = mine.filter((c) => lc(c.args.asset) === lc(q)).reduce((a, c) => a + c.args.amount, ZERO);
    const ct = mine.filter((c) => lc(c.args.asset) === token).reduce((a, c) => a + c.args.amount, ZERO);
    return { token, name: String(name), ticker: String(ticker), quote, claimable: qAmt, claimed: cq, lifetime: cq + qAmt, recent: [], tokenSide: { asset, claimable: tAmt, claimed: ct }, anon: true };
  }));
  return rows.filter((r): r is CreatorRocket => !!r);
}

/** Calls for claiming `rows`. Wallet rockets: FeeRouter (quote + token side). Pseudonymous: one AnonLauncher.claimMany. Skips zeros. */
export function creatorClaimCalls(rows: Pick<CreatorRocket, "token" | "claimable" | "tokenSide" | "anon">[], caps: Caps, me?: Address): Call[] {
  const fr = deployment().feeRouter;
  const calls: Call[] = [];
  const anon: Address[] = [];
  for (const r of rows) {
    const hasTok = !!r.tokenSide && r.tokenSide.claimable > ZERO;
    if (r.anon) { if (r.claimable > ZERO || hasTok) anon.push(r.token); continue; }
    if (caps.creatorFees && r.claimable > ZERO) calls.push({ to: fr, data: encodeFunctionData({ abi: feeRouterAbi, functionName: "claimCreatorFees", args: [r.token] }) });
    if (caps.creatorTokenFees && hasTok) calls.push({ to: fr, data: encodeFunctionData({ abi: feeRouterAbi, functionName: "claimCreatorTokenFees", args: [r.token] }) });
  }
  const al = anonLauncherAddr();
  if (anon.length && caps.anonClaims && al && me) calls.push({ to: al, data: encodeFunctionData({ abi: anonLauncherAbi, functionName: "claimMany", args: [anon, me] }) });
  return calls;
}

export type ClaimReceipt = { txHash: Hex; claimed: { token: Address; amount: bigint; side: "quote" | "token" }[] };
/** Send claims (one userOp for Claim all) and read the amounts back from the claim events. */
export async function sendCreatorClaims(calls: Call[]): Promise<ClaimReceipt> {
  if (!calls.length) throw new Error("Nothing to claim yet.");
  const r = await execCalls(calls);
  const fr = lc(deployment().feeRouter), al = lc(anonLauncherAddr() ?? "");
  const claimed: ClaimReceipt["claimed"] = [];
  for (const l of r.logs) {
    const topics = l.topics as [Hex, ...Hex[]];
    try {
      if (lc(l.address) === fr) {
        const ev = decodeEventLog({ abi: feeRouterAbi, data: l.data, topics }) as { eventName: string; args: { token: Address; amount: bigint } };
        if (ev.eventName === "CreatorFeesClaimed") claimed.push({ token: ev.args.token, amount: ev.args.amount, side: "quote" });
        if (ev.eventName === "CreatorTokenFeesClaimed") claimed.push({ token: ev.args.token, amount: ev.args.amount, side: "token" });
      } else if (al && lc(l.address) === al) {
        const ev = decodeEventLog({ abi: anonLauncherAbi, data: l.data, topics }) as { eventName: string; args: { token: Address; asset: Address; amount: bigint } };
        if (ev.eventName === "Claimed") claimed.push({ token: ev.args.token, amount: ev.args.amount, side: lc(ev.args.asset) === lc(ev.args.token) ? "token" : "quote" });
      }
    } catch { /* other event */ }
  }
  return { txHash: r.txHash, claimed };
}

/* ---------------- referral rewards (v4: referrerAccrued(referrer, quote) — referrer FIRST) ---------------- */
export type ReferralBalance = { asset: Asset; claimable: bigint };
/** Referral balances across the quote assets in use (default quote, USDG, plus any extra quotes passed in). */
export async function referralBalances(pc: PublicClient, me: Address, extraQuotes: Address[] = []): Promise<ReferralBalance[]> {
  const d = deployment();
  const qs = Array.from(new Set([d.defaultQuote, d.usdg, ...extraQuotes].filter((a) => a && !/^0x0{40}$/i.test(a)).map(lc))) as Address[];
  return Promise.all(qs.map(async (q) => ({
    asset: await assetMeta(pc, q),
    claimable: await (pc.readContract({ address: d.feeRouter, abi: feeRouterAbi, functionName: "referrerAccrued", args: [me, q] }) as Promise<bigint>).catch(() => ZERO),
  })));
}
export function referralClaimCalls(rows: ReferralBalance[]): Call[] {
  const fr = deployment().feeRouter;
  return rows.filter((r) => r.claimable > ZERO).map((r) => ({ to: fr, data: encodeFunctionData({ abi: feeRouterAbi, functionName: "claimReferrerFees", args: [r.asset.address] }) }));
}
