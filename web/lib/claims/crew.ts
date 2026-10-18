/**
 * CREW rewards — REDEPLOY ONLY (PVE mode). 0.777% profit tax on DUMPs feeds a holder pool on the curve:
 *   view  BondingCurve.pendingRewards(holder) (quote raw; curve = Launchpad.curveOf(token))
 *   claim Launchpad.claim(token)
 *   feed  ProfitTaxCharged(token, seller, tax, grossQuote, costBasis) → "crew earned X from this DUMP"
 * Every entry point is behind caps.crew (lib/claims/capabilities); callers must not render anything when it is false.
 */
import { withBase } from "../base-path";
import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { Mode, curveRedeployAbi, launchpadRedeployAbi } from "../abi/redeploy";
import { deployment } from "../chains";
import type { Call } from "../aa/core";
import { execCalls } from "../wallet";
import { assetMeta, indexerGet, lc, type Asset } from "./common";
import { coinFacts, curveOf } from "../protocol-viem";

const modeCache = new Map<string, number>();
/** Launchpad.modeOf(token) (mode is fixed at launch ⇒ cached). */
export async function coinMode(pc: PublicClient, token: Address): Promise<number> {
  const k = lc(token);
  if (modeCache.has(k)) return modeCache.get(k)!;
  const m = Number(await pc.readContract({ address: deployment().launchpad, abi: launchpadRedeployAbi, functionName: "modeOf", args: [token] }));
  modeCache.set(k, m);
  return m;
}
export const isPve = (mode: number) => mode === Mode.PVE;

export type CrewPosition = { token: Address; quote: Asset; pending: bigint };
/** Pending crew rewards of `holder` on a PVE rocket, or null when the rocket isn't PVE. */
export async function crewPending(pc: PublicClient, token: Address, holder: Address): Promise<CrewPosition | null> {
  if (!isPve(await coinMode(pc, token))) return null;
  const [curve, facts] = await Promise.all([curveOf(pc, token), coinFacts(pc, token)]);
  const pending = (await pc.readContract({ address: curve, abi: curveRedeployAbi, functionName: "pendingRewards", args: [holder] })) as bigint;
  return { token, quote: await assetMeta(pc, facts.quote), pending };
}

/** Crew positions across rockets the holder touched (indexer /users/:addr/crew, else the site trade index). */
export async function crewPositions(pc: PublicClient, holder: Address): Promise<(CrewPosition & { name?: string; ticker?: string })[]> {
  const idx = await indexerGet<{ coins: { token: string; name: string; ticker: string }[] }>(`/users/${holder}/crew`);
  let tokens: { token: string; name?: string; ticker?: string }[] = idx?.coins ?? [];
  if (!idx) {
    const r = await fetch(withBase(`/api/trades?wallet=${holder}`)).then((x) => (x.ok ? x.json() : { coins: [] })).catch(() => ({ coins: [] }));
    tokens = ((r.coins ?? []) as string[]).map((t) => ({ token: t }));
  }
  const rows = await Promise.all(tokens.slice(0, 60).map(async (t) => {
    const p = await crewPending(pc, t.token as Address, holder).catch(() => null);
    return p ? { ...p, name: t.name, ticker: t.ticker } : null;
  }));
  return rows.filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => (a.pending > b.pending ? -1 : 1));
}

export const crewClaimCall = (token: Address): Call => ({ to: deployment().launchpad, data: encodeFunctionData({ abi: launchpadRedeployAbi, functionName: "claim", args: [token] }) });
export async function claimCrew(tokens: Address[]) {
  if (!tokens.length) throw new Error("Nothing to claim yet.");
  return execCalls(tokens.map(crewClaimCall));
}

export type CrewFeedRow = { seller: Address; tax: bigint; grossQuote: bigint; tx: Hex; block: bigint; ts?: number };
/** Latest profit-tax events for a rocket (indexer /coins/:token/crew, else curve logs). */
export async function crewFeed(pc: PublicClient, token: Address, n = 8): Promise<CrewFeedRow[]> {
  const idx = await indexerGet<{ feed: { seller: string; tax: string; grossQuote: string; tx: string; block: number; ts: number }[] }>(`/coins/${token}/crew?limit=${n}`);
  if (idx) return idx.feed.map((r) => ({ seller: r.seller as Address, tax: BigInt(r.tax), grossQuote: BigInt(r.grossQuote), tx: r.tx as Hex, block: BigInt(r.block), ts: r.ts }));
  const curve = await curveOf(pc, token);
  const logs = (await pc.getContractEvents({ address: curve, abi: curveRedeployAbi, eventName: "ProfitTaxCharged", fromBlock: deployment().fromBlock, toBlock: "latest" }).catch(() => [])) as unknown as
    { args: { seller: Address; tax: bigint; grossQuote: bigint }; transactionHash: Hex; blockNumber: bigint }[];
  return logs.slice(-n).reverse().map((l) => ({ seller: l.args.seller, tax: l.args.tax, grossQuote: l.args.grossQuote, tx: l.transactionHash, block: l.blockNumber }));
}

