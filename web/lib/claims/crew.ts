/**
 * CREW rewards (v4, PVE coins only — mode TRENCH=0, PVE=1, PVP=2). A 0.777% profit tax on DUMPs feeds a holder pool:
 *   mode  Launchpad.modeOf(token)
 *   view  BondingCurve.pendingRewards(holder) (quote raw; curve = Launchpad.curveOf(token)) — always read on-chain
 *   claim Launchpad.claim(token) → BondingCurve.claimFor(msg.sender); reverts ZeroAmount when nothing is pending
 *   feed  ProfitTaxCharged(token, seller, tax, grossQuote, costBasis); claims emit HolderRewardsClaimed
 * Production has no SQLite indexer (KV only), so positions come from the KV trade index (/api/trades?wallet=) unless
 * NEXT_PUBLIC_INDEXER_URL points at indexer/ (#100: /users/:addr/rewards, /coins/:token/profit-tax).
 */
import { withBase } from "../base-path";
import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { bondingCurveAbi, launchpadAbi } from "../abi";
import { deployment } from "../chains";
import type { Call } from "../aa/core";
import { execCalls } from "../wallet";
import { assetMeta, indexerGet, lc, type Asset } from "./common";
import { coinFacts, curveOf, MODE } from "../protocol-viem";

const modeCache = new Map<string, number>();
/** Launchpad.modeOf(token) (fixed at launch ⇒ cached). */
export async function coinMode(pc: PublicClient, token: Address): Promise<number> {
  const k = lc(token);
  if (modeCache.has(k)) return modeCache.get(k)!;
  const m = Number(await pc.readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "modeOf", args: [token] }));
  modeCache.set(k, m);
  return m;
}
export const isPve = (mode: number) => mode === MODE.PVE;

export type CrewPosition = { token: Address; quote: Asset; pending: bigint };
/** Pending crew rewards of `holder` on a PVE rocket, or null when the rocket isn't PVE. */
export async function crewPending(pc: PublicClient, token: Address, holder: Address): Promise<CrewPosition | null> {
  if (!isPve(await coinMode(pc, token))) return null;
  const [curve, facts] = await Promise.all([curveOf(pc, token), coinFacts(pc, token)]);
  const pending = (await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "pendingRewards", args: [holder] })) as bigint;
  return { token, quote: await assetMeta(pc, facts.quote), pending };
}

/** Crew positions across rockets the holder touched (indexer /users/:addr/rewards, else the KV trade index). */
export async function crewPositions(pc: PublicClient, holder: Address): Promise<(CrewPosition & { name?: string; ticker?: string })[]> {
  const idx = await indexerGet<{ holderRewards: { pending: { token: string; ticker: string }[]; claimed: { token: string; ticker: string }[] } }>(`/users/${holder}/rewards`);
  let tokens: { token: string; ticker?: string }[] = idx ? [...idx.holderRewards.pending, ...idx.holderRewards.claimed] : [];
  if (!idx) {
    const r = await fetch(withBase(`/api/trades?wallet=${holder}`)).then((x) => (x.ok ? x.json() : { coins: [] })).catch(() => ({ coins: [] }));
    tokens = ((r.coins ?? []) as string[]).map((t) => ({ token: t }));
  }
  const uniq = Array.from(new Map(tokens.map((t) => [lc(t.token), t])).values());
  const rows = await Promise.all(uniq.slice(0, 60).map(async (t) => {
    const p = await crewPending(pc, t.token as Address, holder).catch(() => null);
    return p ? { ...p, ticker: t.ticker } : null;
  }));
  return rows.filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => (a.pending > b.pending ? -1 : 1));
}

export const crewClaimCall = (token: Address): Call => ({ to: deployment().launchpad, data: encodeFunctionData({ abi: launchpadAbi, functionName: "claim", args: [token] }) });
export async function claimCrew(tokens: Address[]) {
  if (!tokens.length) throw new Error("Nothing to claim yet.");
  return execCalls(tokens.map(crewClaimCall));
}

export type CrewFeedRow = { seller: Address; tax: bigint; grossQuote: bigint; tx: Hex; block: bigint; ts?: number };
/** Latest profit-tax events for a rocket (indexer /coins/:token/profit-tax, else curve logs). */
export async function crewFeed(pc: PublicClient, token: Address, n = 8): Promise<CrewFeedRow[]> {
  const idx = await indexerGet<{ events: { seller: string; tax: string; gross: string; tx: string; block: number; ts: number }[] }>(`/coins/${token}/profit-tax?limit=${n}`);
  if (idx) return idx.events.map((r) => ({ seller: r.seller as Address, tax: BigInt(r.tax), grossQuote: BigInt(r.gross), tx: r.tx as Hex, block: BigInt(r.block), ts: r.ts }));
  const curve = await curveOf(pc, token);
  const logs = (await pc.getContractEvents({ address: curve, abi: bondingCurveAbi, eventName: "ProfitTaxCharged", fromBlock: deployment().fromBlock, toBlock: "latest" }).catch(() => [])) as unknown as
    { args: { seller: Address; tax: bigint; grossQuote: bigint }; transactionHash: Hex; blockNumber: bigint }[];
  return logs.slice(-n).reverse().map((l) => ({ seller: l.args.seller, tax: l.args.tax, grossQuote: l.args.grossQuote, tx: l.transactionHash, block: l.blockNumber }));
}
