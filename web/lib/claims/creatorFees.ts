/**
 * Creator dashboard data + claim calls (v4 FeeRouter, generated ABI lib/abi/FeeRouter.ts):
 *   quote side  creatorAccrued(token, creator) / claimCreatorFees(token)           → CreatorFeesClaimed(token, creator, amount)
 *   token side  creatorTokenAccrued(token, creator) / claimCreatorTokenFees(token) → CreatorTokenFeesClaimed(token, creator, amount)
 *               (post-graduation buys pay the creator share in the launch token)
 *   history     TradeFeeRouted(token, feeToken, trader, feeIsQuote, creator, creatorShare, creatorTaxAmount, …)
 *   private      AnonLauncher.pending(token) → (quote, quoteAmt, tokenAmt) on the coin's OWN launcher (= Launchpad.creatorOf):
 *                v2 (default) or v1 (legacy). Owner = this account ⇒ claimMany(tokens, me); owner = one of our stealth
 *                addresses ⇒ claimManyBySig signed with the stealth key (lib/privateLaunch), paid to this account.
 * Claims go through lib/wallet.execCalls (smart account userOp, owner-signed; or the legacy EOA path), the same sender
 * the trade flow uses. Balances are always read live on-chain.
 */
import { decodeEventLog, encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { anonLauncherAbi, bondingCurveAbi, feeRouterAbi, launchpadAbi, tokenAbi } from "../abi";
import { deployment } from "../chains";
import type { Call } from "../aa/core";
import { execCalls } from "../wallet";
import { type Caps } from "./capabilities";
import { ACTIVE_CHAIN } from "../chains";
import { anonLaunchers, CLAIM_TYPES, claimDomain, isLegacyLauncher } from "../anon";
import { assetMeta, lc, type Asset } from "./common";

const ZERO = BigInt(0);
export type Accrual = { amount: bigint; trader: Address; tx: Hex; block: bigint; ts?: number; side: "quote" | "token" };
export type CreatorRocket = {
  token: Address; name: string; ticker: string; quote: Asset;
  claimable: bigint; claimed: bigint; lifetime: bigint;
  recent: Accrual[];
  /** launch-token share (post-grad). null when the cap is off. */
  tokenSide: { asset: Asset; claimable: bigint; claimed: bigint } | null;
  /** private launch: claimed through the coin's AnonLauncher (claimMany / claimManyBySig) */
  anon?: boolean;
  /** private only: the coin's launcher (Launchpad.creatorOf) — every pending/claim/signature goes here */
  launcher?: Address;
  /** private only: stealth owner is one of our derived stealth addresses (claim by EIP-712 signature) */
  stealth?: { owner: Address; ephemeralPubKey: Hex } | null;
  /** private, legacy (v1) launcher only: post-grad token share stuck in FeeRouter (creatorTokenAccrued[token][v1]).
   *  v1 has no path to claim it ⇒ read-only "Unclaimable (legacy launcher)". */
  tokenUnclaimable?: { asset: Asset; raw: bigint } | null;
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

/** Full dashboard rows: wallet-created rockets + private rockets this account (or one of its stealth addresses) owns. */
export async function creatorDashboard(pc: PublicClient, me: Address, caps: Caps, recentN = 6, stealth: Parameters<typeof anonRockets>[2] = []): Promise<CreatorRocket[]> {
  const d = deployment();
  const [rockets, anon] = await Promise.all([createdRockets(pc, me), caps.anonClaims ? anonRockets(pc, me, stealth).catch(() => []) : Promise.resolve([])]);
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

/* ---------------- private launches (AnonLauncher v2 default + v1 legacy) ---------------- */
type AnonCand = { token: Address; stealth?: { owner: Address; ephemeralPubKey: Hex } };
/**
 * Private rockets of this account, with live pending(token) read on each coin's own launcher.
 * Candidates: AnonLaunched / StealthOwnerTransferred to `me` on BOTH launchers (owner = this account) plus `stealth`
 * (coins announced to our stealth keys, from lib/privateLaunch.myStealthCoins).
 */
export async function anonRockets(pc: PublicClient, me: Address, stealth: { token: Address; stealthAddress: Address; ephemeralPubKey: Hex }[] = []): Promise<CreatorRocket[]> {
  const d = deployment();
  const launchers = anonLaunchers(ACTIVE_CHAIN.id);
  if (!launchers.length) return [];
  const direct = await Promise.all(launchers.map((al) => Promise.all([
    pc.getContractEvents({ address: al, abi: anonLauncherAbi, eventName: "AnonLaunched", args: { stealthOwner: me }, fromBlock: d.fromBlock, toBlock: "latest" }).catch(() => []),
    pc.getContractEvents({ address: al, abi: anonLauncherAbi, eventName: "StealthOwnerTransferred", args: { to: me }, fromBlock: d.fromBlock, toBlock: "latest" }).catch(() => []),
  ])));
  const cands = new Map<string, AnonCand>();
  for (const [l1, l2] of direct) for (const l of [...l1, ...l2]) { const t = lc((l as unknown as { args: { token: string } }).args.token) as Address; if (!cands.has(t)) cands.set(t, { token: t }); }
  for (const s of stealth) cands.set(lc(s.token), { token: lc(s.token) as Address, stealth: { owner: s.stealthAddress, ephemeralPubKey: s.ephemeralPubKey } });
  const ownersOf = (c: AnonCand) => [lc(me), ...(c.stealth ? [lc(c.stealth.owner)] : [])];
  const rows = await Promise.all(Array.from(cands.values()).map(async (c): Promise<CreatorRocket | null> => {
    // the coin's launcher is its on-chain creator: v1 coins MUST be read/claimed on v1 (v2 reverts NotStealthOwner)
    const al = lc(String(await pc.readContract({ address: d.launchpad, abi: launchpadAbi, functionName: "creatorOf", args: [c.token] }).catch(() => ""))) as Address;
    if (!launchers.some((x) => lc(x) === al)) return null;
    const owner = lc(String(await pc.readContract({ address: al, abi: anonLauncherAbi, functionName: "stealthOwnerOf", args: [c.token] }).catch(() => "")));
    if (!ownersOf(c).includes(owner)) return null;
    const legacy = isLegacyLauncher(ACTIVE_CHAIN.id, al);
    const [[q, qAmt, tAmt], stuck, claimedLogs] = await Promise.all([
      pc.readContract({ address: al, abi: anonLauncherAbi, functionName: "pending", args: [c.token] }) as Promise<readonly [Address, bigint, bigint]>,
      // v2 pending() already includes FeeRouter.creatorTokenAccrued[token][v2]; on v1 that share is unclaimable
      legacy ? (pc.readContract({ address: d.feeRouter, abi: feeRouterAbi, functionName: "creatorTokenAccrued", args: [c.token, al] }) as Promise<bigint>).catch(() => ZERO) : Promise.resolve(ZERO),
      pc.getContractEvents({ address: al, abi: anonLauncherAbi, eventName: "Claimed", args: { token: c.token }, fromBlock: d.fromBlock, toBlock: "latest" }).catch(() => []),
    ]);
    const [quote, asset, name, ticker] = await Promise.all([
      assetMeta(pc, q), assetMeta(pc, c.token),
      pc.readContract({ address: c.token, abi: tokenAbi, functionName: "name" }).catch(() => "Rocket"),
      pc.readContract({ address: c.token, abi: tokenAbi, functionName: "symbol" }).catch(() => "?"),
    ]);
    const claims = (claimedLogs as unknown as { args: { token: Address; asset: Address; amount: bigint } }[]);
    const cq = claims.filter((x) => lc(x.args.asset) === lc(q)).reduce((a, x) => a + x.args.amount, ZERO);
    const ct = claims.filter((x) => lc(x.args.asset) === lc(c.token)).reduce((a, x) => a + x.args.amount, ZERO);
    const viaSig = !!c.stealth && owner === lc(c.stealth.owner);
    return { token: c.token, name: String(name), ticker: String(ticker), quote, claimable: qAmt, claimed: cq, lifetime: cq + qAmt, recent: [],
      tokenSide: { asset, claimable: tAmt, claimed: ct }, anon: true, launcher: al, stealth: viaSig ? c.stealth : null,
      tokenUnclaimable: legacy && stuck > ZERO ? { asset, raw: stuck } : null };
  }));
  return rows.filter((r): r is CreatorRocket => !!r);
}

type ClaimRow = Pick<CreatorRocket, "token" | "claimable" | "tokenSide" | "anon" | "launcher" | "stealth">;
const anonHasSomething = (r: ClaimRow) => r.claimable > ZERO || (!!r.tokenSide && r.tokenSide.claimable > ZERO);

/**
 * Calls for claiming `rows`. Wallet rockets: FeeRouter (quote + token side). Private rockets owned by this account:
 * one claimMany per launcher. Stealth-owned private rockets need signatures: see anonSigClaimCalls. Skips zeros.
 */
export function creatorClaimCalls(rows: ClaimRow[], caps: Caps, me?: Address): Call[] {
  const fr = deployment().feeRouter;
  const calls: Call[] = [];
  const byLauncher = new Map<Address, Address[]>();
  for (const r of rows) {
    const hasTok = !!r.tokenSide && r.tokenSide.claimable > ZERO;
    if (r.anon) { if (!r.stealth && r.launcher && anonHasSomething(r)) byLauncher.set(r.launcher, [...(byLauncher.get(r.launcher) ?? []), r.token]); continue; }
    if (caps.creatorFees && r.claimable > ZERO) calls.push({ to: fr, data: encodeFunctionData({ abi: feeRouterAbi, functionName: "claimCreatorFees", args: [r.token] }) });
    if (caps.creatorTokenFees && hasTok) calls.push({ to: fr, data: encodeFunctionData({ abi: feeRouterAbi, functionName: "claimCreatorTokenFees", args: [r.token] }) });
  }
  if (caps.anonClaims && me) for (const [al, tokens] of Array.from(byLauncher.entries()))
    calls.push({ to: al, data: encodeFunctionData({ abi: anonLauncherAbi, functionName: "claimMany", args: [tokens, me] }) });
  return calls;
}

/**
 * Stealth-owned private rockets: one claimManyBySig per (launcher, stealth owner), signed with that coin's stealth key
 * (EIP-712 "DISCIPLE AnonLauncher" v1, verifyingContract = the coin's launcher), relayerFeeBps 0, paid to `me`.
 * `keyFor(ephemeralPubKey)` returns the stealth private key (lib/privateLaunch.stealthKeyFor).
 */
export async function anonSigClaimCalls(pc: PublicClient, rows: ClaimRow[], me: Address, keyFor: (eph: Hex) => Hex): Promise<Call[]> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const groups = new Map<string, { launcher: Address; owner: Address; eph: Hex; tokens: Address[] }>();
  for (const r of rows) {
    if (!r.anon || !r.stealth || !r.launcher || !anonHasSomething(r)) continue;
    const k = `${lc(r.launcher)}:${lc(r.stealth.owner)}`;
    const g = groups.get(k) ?? { launcher: r.launcher, owner: r.stealth.owner, eph: r.stealth.ephemeralPubKey, tokens: [] };
    g.tokens.push(r.token); groups.set(k, g);
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const calls: Call[] = [];
  for (const g of Array.from(groups.values())) {
    const acct = privateKeyToAccount(keyFor(g.eph));
    if (lc(acct.address) !== lc(g.owner)) continue;   // wrong key: never send a claim that would revert
    const nonce = await pc.readContract({ address: g.launcher, abi: anonLauncherAbi, functionName: "nonces", args: [g.owner] }) as bigint;
    const sig = await acct.signTypedData({ domain: claimDomain(ACTIVE_CHAIN.id, g.launcher), types: CLAIM_TYPES, primaryType: "Claim",
      message: { owner: g.owner, tokens: g.tokens, to: me, relayerFeeBps: ZERO, nonce, deadline } });
    calls.push({ to: g.launcher, data: encodeFunctionData({ abi: anonLauncherAbi, functionName: "claimManyBySig", args: [{ owner: g.owner, tokens: g.tokens, to: me, relayerFeeBps: ZERO, deadline, sig }] }) });
  }
  return calls;
}

export type ClaimReceipt = { txHash: Hex; claimed: { token: Address; amount: bigint; side: "quote" | "token" }[] };
/** Send claims (one userOp for Claim all) and read the amounts back from the claim events (FeeRouter + both launchers). */
export async function sendCreatorClaims(calls: Call[]): Promise<ClaimReceipt> {
  if (!calls.length) throw new Error("Nothing to claim yet.");
  const r = await execCalls(calls);
  const fr = lc(deployment().feeRouter), als = anonLaunchers(ACTIVE_CHAIN.id).map(lc);
  const claimed: ClaimReceipt["claimed"] = [];
  for (const l of r.logs) {
    const topics = l.topics as [Hex, ...Hex[]];
    try {
      if (lc(l.address) === fr) {
        const ev = decodeEventLog({ abi: feeRouterAbi, data: l.data, topics }) as { eventName: string; args: { token: Address; amount: bigint } };
        if (ev.eventName === "CreatorFeesClaimed") claimed.push({ token: ev.args.token, amount: ev.args.amount, side: "quote" });
        if (ev.eventName === "CreatorTokenFeesClaimed") claimed.push({ token: ev.args.token, amount: ev.args.amount, side: "token" });
      } else if (als.includes(lc(l.address))) {
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
