import { scanEventHistory } from "./eventHistory";
/**
 * Creator dashboard data + claim calls (v4 FeeRouter, generated ABI lib/abi/FeeRouter.ts):
 *   quote side  creatorAccrued(token, creator) / claimCreatorFees(token)           → CreatorFeesClaimed(token, creator, amount)
 *   token side  creatorTokenAccrued(token, creator) / claimCreatorTokenFees(token) → CreatorTokenFeesClaimed(token, creator, amount)
 *               (post-graduation buys pay the creator share in the launch token)
 *   history     TradeFeeRouted(token, feeToken, trader, feeIsQuote, creator, creatorShare, creatorTaxAmount, …)
 *   private      AnonLauncher.pending(token) → (quote, quoteAmt, tokenAmt) on the coin's OWN launcher (= Launchpad.creatorOf):
 *                v2 (default) or v1 (legacy). Owner = this account ⇒ claimMany(tokens, me); owner = one of our stealth
 *                addresses ⇒ claimManyBySig signed with the stealth key (lib/privateLaunch), paid to this account.
 *   lp-accrue    new curves (BondingCurve.feeVault() ≠ 0): curve-phase quote fees live in CurveFeeVault (lib/claims/vault.ts).
 *                Rows add vault.creatorClaimable (accrued + still owed on the curve) to the FeeRouter balance (post-grad
 *                and pre-lp-accrue fees); claims call each side that holds something. Private rockets: the vault books them
 *                under the launcher; the coin's owner (AnonLauncher.stealthOwnerOf) claims with claimManyAsStealthBySig.
 * Claims go through lib/wallet.execCalls (smart account userOp, owner-signed; or the legacy EOA path), the same sender
 * the trade flow uses. Balances are always read live on-chain.
 */
import { decodeEventLog, encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { anonLauncherAbi, bondingCurveAbi, feeRouterAbi, launchpadAbi, tokenAbi } from "../abi";
import { deployment } from "../chains";
import type { Call } from "../aa/core";
import { execCalls, gaslessSigner } from "../wallet";
import { clientGaslessMode } from "../aa/sponsorshipMode";
import { publicClient } from "../protocol-viem";
import type { LocalAccount } from "viem";
import { blockedCallsMessage, partitionRelayableCalls } from "../trade/gaslessAction";
import { sendGaslessAction } from "../trade/gaslessActionClient";
import { type Caps } from "./capabilities";
import { ACTIVE_CHAIN } from "../chains";
import { anonLaunchers, CLAIM_TYPES, claimDomain, isLegacyLauncher } from "../anon";
import { assetMeta, lc, type Asset } from "./common";
import { curveFeeVaultAbi, feeVaultOf, stackFeeVault, vaultClaimDomain, vaultCreatorClaimable } from "./vault";

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
  /** lp-accrue: the coin's CurveFeeVault (null / absent = pre-lp-accrue curve, FeeRouter only) */
  vault?: Address | null;
  /** lp-accrue: the part of `claimable` held by the vault (accrued + owed on the curve) */
  vaultClaimable?: bigint;
  /** the part of `claimable` in FeeRouter (wallet rockets) or AnonLauncher.pending quote side (private rockets).
   *  Absent ⇒ all of `claimable` (pre-lp-accrue rows). */
  baseClaimable?: bigint;
};

type Launch = { token: Address; name: string; ticker: string; quote: Address; block: bigint };

/** Rockets launched by `me` (Launched.creator is indexed), newest first. Current creatorOf must still be `me`. */
export async function createdRockets(pc: PublicClient, me: Address): Promise<Launch[]> {
  const d = deployment();
  const logs = await scanEventHistory(pc, (fromBlock, toBlock) => pc.getContractEvents({ address: d.launchpad, abi: launchpadAbi, eventName: "Launched", args: { creator: me }, fromBlock, toBlock }), d.fromBlock);
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

/** Live claimable creator fees for one rocket (quote raw): FeeRouter + the coin's CurveFeeVault (lp-accrue). */
export async function creatorClaimable(pc: PublicClient, token: Address, me: Address): Promise<bigint> {
  return (await creatorQuoteSplit(pc, token, me)).claimable;
}
export type CreatorSplit = Required<Pick<CreatorRocket, "claimable" | "vault" | "vaultClaimable" | "baseClaimable">>;
/** Quote-side creator balance split by where it sits (FeeRouter vs CurveFeeVault), so the claim calls hit each side. */
export async function creatorQuoteSplit(pc: PublicClient, token: Address, me: Address): Promise<CreatorSplit> {
  const vault = await feeVaultOf(pc, token);
  const [base, inVault] = await Promise.all([
    pc.readContract({ address: deployment().feeRouter, abi: feeRouterAbi, functionName: "creatorAccrued", args: [token, me] }) as Promise<bigint>,
    vaultCreatorClaimable(pc, vault, token, me),
  ]);
  return { claimable: base + inVault, vault, vaultClaimable: inVault, baseClaimable: base };
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
    scanEventHistory(pc, (fromBlock, toBlock) => pc.getContractEvents({ address: d.feeRouter, abi: feeRouterAbi, eventName, args: { creator: me }, fromBlock, toBlock }), d.fromBlock).catch(() => []) as Promise<unknown> as Promise<ClaimLog[]>;
  const vaults = await Promise.all(rockets.map((r) => feeVaultOf(pc, r.token)));
  const vaultAddrs = uniqAddrs(vaults);
  const [claimLogs, tokenClaimLogs, vaultClaimLogs] = await Promise.all([
    ev("CreatorFeesClaimed"),
    caps.creatorTokenFees ? ev("CreatorTokenFeesClaimed") : Promise.resolve([] as ClaimLog[]),
    vaultAddrs.length ? (scanEventHistory(pc, (fromBlock, toBlock) => pc.getContractEvents({ address: vaultAddrs, abi: curveFeeVaultAbi, eventName: "CreatorFeesClaimed", args: { creator: me }, fromBlock, toBlock }), d.fromBlock).catch(() => []) as Promise<unknown> as Promise<ClaimLog[]>) : Promise.resolve([] as ClaimLog[]),
  ]);
  const own = await Promise.all(rockets.map(async (r): Promise<CreatorRocket> => {
    const quote = await assetMeta(pc, r.quote || (await quoteOfToken(pc, r.token)));
    const [split, recent] = await Promise.all([
      creatorQuoteSplit(pc, r.token, me).catch(() => ({ claimable: ZERO, vault: null, vaultClaimable: ZERO, baseClaimable: ZERO })),
      recentAccruals(pc, r.token, recentN),
    ]);
    const claimable = split.claimable;
    const claimed = sumFor(claimLogs, r.token) + sumFor(vaultClaimLogs, r.token);
    let tokenSide: CreatorRocket["tokenSide"] = null;
    if (caps.creatorTokenFees) {
      const [asset, tc] = await Promise.all([assetMeta(pc, r.token), creatorTokenClaimable(pc, r.token, me).catch(() => ZERO)]);
      tokenSide = { asset, claimable: tc, claimed: sumFor(tokenClaimLogs, r.token) };
    }
    return { token: r.token, name: r.name, ticker: r.ticker, quote, claimable, claimed, lifetime: claimed + claimable, recent, tokenSide,
      vault: split.vault, vaultClaimable: split.vaultClaimable, baseClaimable: split.baseClaimable };
  }));
  return [...own, ...anon];
}

const uniqAddrs = (xs: (Address | null | undefined)[]) => Array.from(new Set(xs.filter((x): x is Address => !!x).map(lc))) as Address[];

/**
 * Last `n` creator accruals for a rocket: v4 TradeFeeRouted (creatorShare + creatorTaxAmount; feeIsQuote picks the unit)
 * plus, on lp-accrue curves, CurveFeeVault.CurveFeeSettled (quote side; trader 0 = a batch settle of unreferred trades).
 */
export async function recentAccruals(pc: PublicClient, token: Address, n = 6): Promise<Accrual[]> {
  const d = deployment();
  type L = { args: { trader: Address; feeIsQuote?: boolean; creatorShare: bigint; creatorTaxAmount: bigint }; transactionHash: Hex; blockNumber: bigint; logIndex?: number };
  const vault = await feeVaultOf(pc, token);
  const [fr, vs] = await Promise.all([
    scanEventHistory(pc, (fromBlock, toBlock) => pc.getContractEvents({ address: d.feeRouter, abi: feeRouterAbi, eventName: "TradeFeeRouted", args: { token }, fromBlock, toBlock }), d.fromBlock).catch(() => []),
    vault ? scanEventHistory(pc, (fromBlock, toBlock) => pc.getContractEvents({ address: vault, abi: curveFeeVaultAbi, eventName: "CurveFeeSettled", args: { token }, fromBlock, toBlock }), d.fromBlock).catch(() => []) : Promise.resolve([]),
  ]);
  const logs = ([...(fr as unknown as L[]), ...(vs as unknown as L[]).map((l) => ({ ...l, args: { ...l.args, feeIsQuote: true } }))])
    .sort((a, b) => (a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : a.blockNumber < b.blockNumber ? -1 : 1));
  return logs.filter((l) => l.args.creatorShare + l.args.creatorTaxAmount > ZERO).slice(-n).reverse().map((l) => ({
    amount: l.args.creatorShare + l.args.creatorTaxAmount, trader: l.args.trader, tx: l.transactionHash, block: l.blockNumber, side: l.args.feeIsQuote === false ? "token" : "quote",
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
    scanEventHistory(pc, (fromBlock, toBlock) => pc.getContractEvents({ address: al, abi: anonLauncherAbi, eventName: "AnonLaunched", args: { stealthOwner: me }, fromBlock, toBlock }), d.fromBlock).catch(() => []),
    scanEventHistory(pc, (fromBlock, toBlock) => pc.getContractEvents({ address: al, abi: anonLauncherAbi, eventName: "StealthOwnerTransferred", args: { to: me }, fromBlock, toBlock }), d.fromBlock).catch(() => []),
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
    // lp-accrue: the coin's vault books its curve-phase fees under the launcher; only the vault's own anonLauncher
    // can be claimed through it (claimCreatorFeesAsStealth checks creatorOf == vault.anonLauncher)
    const vault = await feeVaultOf(pc, c.token);
    const vaultAl = vault ? lc(String(await pc.readContract({ address: vault, abi: curveFeeVaultAbi, functionName: "anonLauncher" }).catch(() => ""))) : "";
    const useVault = !!vault && vaultAl === al;
    const [[q, qAmt, tAmt], stuck, claimedLogs, vQ, vaultClaimed] = await Promise.all([
      pc.readContract({ address: al, abi: anonLauncherAbi, functionName: "pending", args: [c.token] }) as Promise<readonly [Address, bigint, bigint]>,
      // v2 pending() already includes FeeRouter.creatorTokenAccrued[token][v2]; on v1 that share is unclaimable
      legacy ? (pc.readContract({ address: d.feeRouter, abi: feeRouterAbi, functionName: "creatorTokenAccrued", args: [c.token, al] }) as Promise<bigint>).catch(() => ZERO) : Promise.resolve(ZERO),
      scanEventHistory(pc, (fromBlock, toBlock) => pc.getContractEvents({ address: al, abi: anonLauncherAbi, eventName: "Claimed", args: { token: c.token }, fromBlock, toBlock }), d.fromBlock).catch(() => []),
      useVault ? vaultCreatorClaimable(pc, vault, c.token, al) : Promise.resolve(ZERO),
      useVault ? scanEventHistory(pc, (fromBlock, toBlock) => pc.getContractEvents({ address: vault!, abi: curveFeeVaultAbi, eventName: "StealthCreatorFeesClaimed", args: { token: c.token }, fromBlock, toBlock }), d.fromBlock).catch(() => []) : Promise.resolve([]),
    ]);
    const [quote, asset, name, ticker] = await Promise.all([
      assetMeta(pc, q), assetMeta(pc, c.token),
      pc.readContract({ address: c.token, abi: tokenAbi, functionName: "name" }).catch(() => "Rocket"),
      pc.readContract({ address: c.token, abi: tokenAbi, functionName: "symbol" }).catch(() => "?"),
    ]);
    const claims = ([...claimedLogs, ...vaultClaimed] as unknown as { args: { token: Address; asset: Address; amount: bigint } }[]);
    const cq = claims.filter((x) => lc(x.args.asset) === lc(q)).reduce((a, x) => a + x.args.amount, ZERO);
    const ct = claims.filter((x) => lc(x.args.asset) === lc(c.token)).reduce((a, x) => a + x.args.amount, ZERO);
    const viaSig = !!c.stealth && owner === lc(c.stealth.owner);
    return { token: c.token, name: String(name), ticker: String(ticker), quote, claimable: qAmt + vQ, claimed: cq, lifetime: cq + qAmt + vQ, recent: [],
      tokenSide: { asset, claimable: tAmt, claimed: ct }, anon: true, launcher: al, stealth: viaSig ? c.stealth : null,
      tokenUnclaimable: legacy && stuck > ZERO ? { asset, raw: stuck } : null,
      vault: useVault ? vault : null, vaultClaimable: vQ, baseClaimable: qAmt };
  }));
  return rows.filter((r): r is CreatorRocket => !!r);
}

export type ClaimRow = Pick<CreatorRocket, "token" | "claimable" | "tokenSide" | "anon" | "launcher" | "stealth" | "vault" | "vaultClaimable" | "baseClaimable">;
/** FeeRouter / AnonLauncher quote part (pre-lp-accrue rows carry no split: all of `claimable`). */
const baseOf = (r: ClaimRow) => r.baseClaimable ?? r.claimable;
const vaultPart = (r: ClaimRow) => (r.vault ? r.vaultClaimable ?? ZERO : ZERO);
/** AnonLauncher.claimMany / BySig only when the launcher holds something on either side (skip a call that would pay 0). */
const anonHasSomething = (r: ClaimRow) => baseOf(r) > ZERO || (!!r.tokenSide && r.tokenSide.claimable > ZERO);

/**
 * Calls for claiming `rows`. Wallet rockets: FeeRouter (quote + token side) and, on lp-accrue curves, the coin's
 * CurveFeeVault.claimCreatorFees. Private rockets (wallet- or stealth-owned) are skipped here: they are claimed by
 * signature (AnonLauncher.claimManyBySig + CurveFeeVault.claimManyAsStealthBySig), see anonSigClaimCalls.
 * Skips zeros.
 */
export function creatorClaimCalls(rows: ClaimRow[], caps: Caps, me?: Address): Call[] {
  const fr = deployment().feeRouter;
  const calls: Call[] = [];
  const byLauncher = new Map<Address, Address[]>();
  for (const r of rows) {
    const hasTok = !!r.tokenSide && r.tokenSide.claimable > ZERO;
    // AnonLauncher and CurveFeeVault claims for private rockets go through claimManyBySig / claimManyAsStealthBySig
    // (anonSigClaimCalls), which the gasless relayer can submit
    if (r.anon) continue;
    if (caps.creatorFees && baseOf(r) > ZERO) calls.push({ to: fr, data: encodeFunctionData({ abi: feeRouterAbi, functionName: "claimCreatorFees", args: [r.token] }) });
    if (vaultPart(r) > ZERO) calls.push({ to: r.vault!, data: encodeFunctionData({ abi: curveFeeVaultAbi, functionName: "claimCreatorFees", args: [r.token] }) });
    if (caps.creatorTokenFees && hasTok) calls.push({ to: fr, data: encodeFunctionData({ abi: feeRouterAbi, functionName: "claimCreatorTokenFees", args: [r.token] }) });
  }
  if (caps.anonClaims && me) for (const [al, tokens] of Array.from(byLauncher.entries()))
    calls.push({ to: al, data: encodeFunctionData({ abi: anonLauncherAbi, functionName: "claimMany", args: [tokens, me] }) });
  return calls;
}

/**
 * Stealth-owned private rockets: one claimManyBySig per (launcher, stealth owner), signed with that coin's stealth key
 * (EIP-712 "DISCIPLE AnonLauncher" v1, verifyingContract = the coin's launcher), relayerFeeBps 0, paid to `me`.
 * lp-accrue coins add one CurveFeeVault.claimManyAsStealthBySig per (vault, stealth owner): same Claim struct, domain
 * "DISCIPLE CurveFeeVault" v1 at the vault, nonce = vault.sigNonces(owner). The stealth key never needs gas.
 * `keyFor(ephemeralPubKey)` returns the stealth private key (lib/privateLaunch.stealthKeyFor).
 */
export async function anonSigClaimCalls(pc: PublicClient, rows: ClaimRow[], me: Address, keyFor?: (eph: Hex) => Hex, walletOwner?: LocalAccount | null): Promise<Call[]> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const groups = new Map<string, { launcher: Address; owner: Address; eph: Hex | null; tokens: Address[] }>();
  for (const r of rows) {
    if (!r.anon || !r.launcher || !anonHasSomething(r)) continue;
    if (r.stealth) {
      if (!keyFor) continue;
      const k = `${lc(r.launcher)}:${lc(r.stealth.owner)}`;
      const g = groups.get(k) ?? { launcher: r.launcher, owner: r.stealth.owner, eph: r.stealth.ephemeralPubKey, tokens: [] };
      g.tokens.push(r.token); groups.set(k, g);
    } else if (walletOwner) {
      const k = `${lc(r.launcher)}:${lc(me)}`;
      const g = groups.get(k) ?? { launcher: r.launcher, owner: me, eph: null, tokens: [] };
      g.tokens.push(r.token); groups.set(k, g);
    }
  }
  // lp-accrue: the vault part of a private rocket, signed by the same owner (stealth key, or the wallet itself for a
  // wallet-owned private launch, e.g. launchAnonWithUsdg for a named player)
  const vgroups = new Map<string, { vault: Address; owner: Address; eph: Hex | null; tokens: Address[] }>();
  for (const r of rows) {
    if (!r.anon || vaultPart(r) <= ZERO) continue;
    if (r.stealth) {
      if (!keyFor) continue;
      const k = `${lc(r.vault!)}:${lc(r.stealth.owner)}`;
      const g = vgroups.get(k) ?? { vault: r.vault!, owner: r.stealth.owner, eph: r.stealth.ephemeralPubKey, tokens: [] };
      g.tokens.push(r.token); vgroups.set(k, g);
    } else if (walletOwner) {
      const k = `${lc(r.vault!)}:${lc(me)}`;
      const g = vgroups.get(k) ?? { vault: r.vault!, owner: me, eph: null, tokens: [] };
      g.tokens.push(r.token); vgroups.set(k, g);
    }
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const calls: Call[] = [];
  for (const g of Array.from(groups.values())) {
    const acct = g.eph ? privateKeyToAccount(keyFor!(g.eph)) : walletOwner!;
    if (lc(acct.address) !== lc(g.owner)) continue;   // wrong key: never send a claim that would revert
    const nonce = await pc.readContract({ address: g.launcher, abi: anonLauncherAbi, functionName: "nonces", args: [g.owner] }) as bigint;
    const sig = await acct.signTypedData({ domain: claimDomain(ACTIVE_CHAIN.id, g.launcher), types: CLAIM_TYPES, primaryType: "Claim",
      message: { owner: g.owner, tokens: g.tokens, to: me, relayerFeeBps: ZERO, nonce, deadline } });
    calls.push({ to: g.launcher, data: encodeFunctionData({ abi: anonLauncherAbi, functionName: "claimManyBySig", args: [{ owner: g.owner, tokens: g.tokens, to: me, relayerFeeBps: ZERO, deadline, sig }] }) });
  }
  for (const g of Array.from(vgroups.values())) {
    const acct = g.eph ? privateKeyToAccount(keyFor!(g.eph)) : walletOwner!;
    if (lc(acct.address) !== lc(g.owner)) continue;
    const nonce = await pc.readContract({ address: g.vault, abi: curveFeeVaultAbi, functionName: "sigNonces", args: [g.owner] }) as bigint;
    const sig = await acct.signTypedData({ domain: vaultClaimDomain(ACTIVE_CHAIN.id, g.vault), types: CLAIM_TYPES, primaryType: "Claim",
      message: { owner: g.owner, tokens: g.tokens, to: me, relayerFeeBps: ZERO, nonce, deadline } });
    calls.push({ to: g.vault, data: encodeFunctionData({ abi: curveFeeVaultAbi, functionName: "claimManyAsStealthBySig", args: [{ owner: g.owner, tokens: g.tokens, to: me, relayerFeeBps: ZERO, deadline, sig }] }) });
  }
  return calls;
}


/** Sign every AnonLauncher claim (wallet-owned and stealth-owned) as claimManyBySig so the gasless relayer can submit it. */
export async function signedAnonClaimCalls(pc: PublicClient, rows: ClaimRow[], me: Address): Promise<Call[]> {
  let keyFor: ((eph: Hex) => Hex) | undefined;
  if (rows.some((r) => r.anon && r.stealth)) {
    const { myStealthKeys, stealthKeyFor } = await import("../privateLaunch");
    const k = await myStealthKeys();
    keyFor = (eph) => stealthKeyFor(k, eph);
  }
  return anonSigClaimCalls(pc, rows, me, keyFor, gaslessSigner());
}

export type ClaimReceipt = { txHash: Hex; claimed: { token: Address; amount: bigint; side: "quote" | "token" }[] };
/** Send claims (one userOp for Claim all) and read the amounts back from the claim events (FeeRouter, both launchers, CurveFeeVault). */
export async function sendCreatorClaims(calls: Call[]): Promise<ClaimReceipt> {
  if (!calls.length) throw new Error("Nothing to claim yet.");
  let r: { txHash: Hex; logs: { address: Address; data: Hex; topics: Hex[] }[] };
  if (clientGaslessMode()) {
    const { relayable, blocked } = partitionRelayableCalls("anonClaim", calls.map((c) => ({ to: c.to, data: c.data })));
    if (!relayable.length) throw new Error(blockedCallsMessage(blocked.length ? blocked : calls.map((c) => ({ to: c.to, data: c.data }))));
    if (blocked.length) console.warn("[disciple] claims: skipped msg.sender-only calls (no on-behalf variant)", blocked.length);
    const g = await sendGaslessAction("anonClaim", relayable, publicClient() as never);
    r = { txHash: g.txHash, logs: g.logs };
  } else {
    r = await execCalls(calls);
  }
  const fr = lc(deployment().feeRouter), als = anonLaunchers(ACTIVE_CHAIN.id).map(lc);
  const vaults = new Set(calls.map((c) => lc(c.to)).filter((a) => a !== fr && !als.includes(a)));
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
      } else if (vaults.has(lc(l.address))) {
        const ev = decodeEventLog({ abi: curveFeeVaultAbi, data: l.data, topics }) as { eventName: string; args: { token: Address; creator?: Address; amount: bigint } };
        // a stealth claim also emits CreatorFeesClaimed(token, launcher, gross): count StealthCreatorFeesClaimed (net) only
        if (ev.eventName === "CreatorFeesClaimed" && !als.includes(lc(ev.args.creator!))) claimed.push({ token: ev.args.token, amount: ev.args.amount, side: "quote" });
        if (ev.eventName === "StealthCreatorFeesClaimed") claimed.push({ token: ev.args.token, amount: ev.args.amount, side: "quote" });
      }
    } catch { /* other event */ }
  }
  return { txHash: r.txHash, claimed };
}

/* ---------------- referral rewards (v4: referrerAccrued(referrer, quote) — referrer FIRST) ---------------- */
/** `claimable` = FeeRouter + CurveFeeVault (lp-accrue, `vault` set); `vaultClaimable` is the vault part. */
export type ReferralBalance = { asset: Asset; claimable: bigint; vault?: Address | null; vaultClaimable?: bigint };
/**
 * Referral balances across the quote assets in use (default quote, USDG, plus any extra quotes passed in). lp-accrue:
 * the stack CurveFeeVault (lib/claims/vault.stackFeeVault) holds curve-phase referral / KOL shares. A launch-KOL's 1%
 * from unreferred trades is booked when the coin settles (any claim or trade by a referred trader settles it).
 */
export async function referralBalances(pc: PublicClient, me: Address, extraQuotes: Address[] = []): Promise<ReferralBalance[]> {
  const d = deployment();
  const vault = stackFeeVault();
  const qs = Array.from(new Set([d.defaultQuote, d.usdg, ...extraQuotes].filter((a) => a && !/^0x0{40}$/i.test(a)).map(lc))) as Address[];
  return Promise.all(qs.map(async (q) => {
    const [asset, base, inVault] = await Promise.all([
      assetMeta(pc, q),
      (pc.readContract({ address: d.feeRouter, abi: feeRouterAbi, functionName: "referrerAccrued", args: [me, q] }) as Promise<bigint>).catch(() => ZERO),
      vault ? (pc.readContract({ address: vault, abi: curveFeeVaultAbi, functionName: "referrerAccrued", args: [me, q] }) as Promise<bigint>).catch(() => ZERO) : Promise.resolve(ZERO),
    ]);
    return { asset, claimable: base + inVault, vault, vaultClaimable: inVault };
  }));
}
/**
 * FeeRouter.referralSink(): zero = referral shares route to referrers as today. Non-zero = new referral shares go to
 * the sink, so referrer balances stop growing (what has accrued stays claimable via claimReferrerFees).
 * null when the deployed FeeRouter predates the sink (ABI or read fails) or the sink is unset.
 */
export async function referralSink(pc: PublicClient): Promise<Address | null> {
  if (!(feeRouterAbi as readonly { type?: string; name?: string }[]).some((x) => x.type === "function" && x.name === "referralSink")) return null;
  const a = await (pc.readContract({ address: deployment().feeRouter, abi: feeRouterAbi, functionName: "referralSink" }) as Promise<Address>).catch(() => null);
  return a && !/^0x0{40}$/i.test(a) ? a : null;
}
export function referralClaimCalls(rows: ReferralBalance[]): Call[] {
  const fr = deployment().feeRouter;
  const calls: Call[] = [];
  for (const r of rows) {
    const inVault = r.vault ? r.vaultClaimable ?? ZERO : ZERO;
    if (r.claimable - inVault > ZERO) calls.push({ to: fr, data: encodeFunctionData({ abi: feeRouterAbi, functionName: "claimReferrerFees", args: [r.asset.address] }) });
    if (inVault > ZERO) calls.push({ to: r.vault!, data: encodeFunctionData({ abi: curveFeeVaultAbi, functionName: "claimReferrerFees", args: [r.asset.address, []] }) });
  }
  return calls;
}
