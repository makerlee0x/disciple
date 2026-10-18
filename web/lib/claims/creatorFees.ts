/**
 * Creator dashboard data + claim calls (LIVE on v3: FeeRouter.creatorAccrued / claimCreatorFees, CreatorFeesClaimed,
 * TradeFeeRouted). The redeploy's post-graduation launch-token share (creatorTokenAccrued / claimCreatorTokenFees) slots
 * in behind caps.creatorTokenFees. Claims go through lib/wallet.execCalls (smart account userOp, owner-signed; or the
 * legacy EOA path), the same sender the trade flow uses.
 */
import { decodeEventLog, encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { bondingCurveAbi, feeRouterAbi, launchpadAbi } from "../abi";
import { feeRouterRedeployAbi } from "../abi/redeploy";
import { deployment } from "../chains";
import type { Call } from "../aa/core";
import { execCalls } from "../wallet";
import type { Caps } from "./capabilities";
import { assetMeta, indexerGet, lc, type Asset } from "./common";

export type Accrual = { amount: bigint; trader: Address; tx: Hex; block: bigint; ts?: number };
export type CreatorRocket = {
  token: Address; name: string; ticker: string; quote: Asset;
  claimable: bigint; claimed: bigint; lifetime: bigint;
  recent: Accrual[];
  /** redeploy: launch-token share (null on v3) */
  tokenSide: { asset: Asset; claimable: bigint; claimed: bigint } | null;
};

type Launch = { token: Address; curve: Address; name: string; ticker: string; quote: Address; block: bigint };

/** Rockets launched by `me` (Launched.creator is indexed), newest first. Current creatorOf must still be `me`. */
export async function createdRockets(pc: PublicClient, me: Address): Promise<Launch[]> {
  const d = deployment();
  const logs = await pc.getContractEvents({ address: d.launchpad, abi: launchpadAbi, eventName: "Launched", args: { creator: me }, fromBlock: d.fromBlock, toBlock: "latest" });
  const out = (logs as unknown as { args: Record<string, unknown>; blockNumber: bigint }[]).map((l) => ({
    token: l.args.token as Address, curve: l.args.curve as Address, name: String(l.args.name), ticker: String(l.args.ticker), quote: l.args.quote as Address, block: l.blockNumber,
  }));
  // creator rights can move (CreatorTransferred): keep only rockets `me` still controls
  const still = await Promise.all(out.map((r) => pc.readContract({ address: d.launchpad, abi: launchpadAbi, functionName: "creatorOf", args: [r.token] }).then((c) => lc(c as string) === lc(me)).catch(() => true)));
  return out.filter((_, i) => still[i]).sort((a, b) => (a.block > b.block ? -1 : 1));
}

/** Is `me` the creator of `token`? (coin page badge) */
export async function isCreatorOf(pc: PublicClient, token: Address, me: Address): Promise<boolean> {
  const c = await pc.readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "creatorOf", args: [token] }).catch(() => null);
  return !!c && lc(c as string) === lc(me);
}

/** Quote (fee) asset of a rocket: the curve's quote token. */
async function quoteOfToken(pc: PublicClient, token: Address): Promise<Address> {
  const curve = await pc.readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "curveOf", args: [token] });
  return pc.readContract({ address: curve as Address, abi: bondingCurveAbi, functionName: "quote" }) as Promise<Address>;
}

/** Live claimable creator fees for one rocket (quote raw). */
export async function creatorClaimable(pc: PublicClient, token: Address, me: Address): Promise<bigint> {
  return pc.readContract({ address: deployment().feeRouter, abi: feeRouterAbi, functionName: "creatorAccrued", args: [token, me] }) as Promise<bigint>;
}

type IdxCoin = { token: string; recent: { kind: string; trader: string; creatorShare: string; creatorTax: string | null; tx: string; block: number; ts: number }[]; claimed: string };

/** Full dashboard rows. History from the indexer when NEXT_PUBLIC_INDEXER_URL is set, else RPC logs. Balances always live. */
export async function creatorDashboard(pc: PublicClient, me: Address, caps: Caps, recentN = 6): Promise<CreatorRocket[]> {
  const d = deployment();
  const rockets = await createdRockets(pc, me);
  if (!rockets.length) return [];
  const idx = await indexerGet<{ coins: IdxCoin[] }>(`/creators/${me}/fees?recent=${recentN}`);
  const idxBy = new Map((idx?.coins ?? []).map((c) => [lc(c.token), c]));
  // RPC fallback: every CreatorFeesClaimed by me in one query
  const claimLogs = idx ? [] : ((await pc.getContractEvents({ address: d.feeRouter, abi: feeRouterAbi, eventName: "CreatorFeesClaimed", args: { creator: me }, fromBlock: d.fromBlock, toBlock: "latest" }).catch(() => [])) as unknown as { args: { token: Address; amount: bigint } }[]);
  const tokenClaimLogs = caps.creatorTokenFees
    ? ((await pc.getContractEvents({ address: d.feeRouter, abi: feeRouterRedeployAbi, eventName: "CreatorTokenFeesClaimed", args: { creator: me }, fromBlock: d.fromBlock, toBlock: "latest" }).catch(() => [])) as unknown as { args: { token: Address; amount: bigint } }[])
    : [];
  return Promise.all(rockets.map(async (r): Promise<CreatorRocket> => {
    const quote = await assetMeta(pc, r.quote || (await quoteOfToken(pc, r.token)));
    const ix = idxBy.get(lc(r.token));
    const [claimable, recent] = await Promise.all([
      creatorClaimable(pc, r.token, me).catch(() => BigInt(0)),
      ix ? Promise.resolve(ix.recent.filter((x) => x.kind === "TradeFeeRouted").map((x) => ({ amount: BigInt(x.creatorShare) + BigInt(x.creatorTax ?? 0), trader: x.trader as Address, tx: x.tx as Hex, block: BigInt(x.block), ts: x.ts })))
        : recentAccruals(pc, r.token, recentN),
    ]);
    const claimed = ix ? BigInt(ix.claimed) : claimLogs.filter((l) => lc(l.args.token) === lc(r.token)).reduce((a, l) => a + l.args.amount, BigInt(0));
    let tokenSide: CreatorRocket["tokenSide"] = null;
    if (caps.creatorTokenFees) {
      const asset = await assetMeta(pc, r.token);
      const tc = await (pc.readContract({ address: d.feeRouter, abi: feeRouterRedeployAbi, functionName: "creatorTokenAccrued", args: [r.token, me] }) as Promise<bigint>).catch(() => BigInt(0));
      tokenSide = { asset, claimable: tc, claimed: tokenClaimLogs.filter((l) => lc(l.args.token) === lc(r.token)).reduce((a, l) => a + l.args.amount, BigInt(0)) };
    }
    return { token: r.token, name: r.name, ticker: r.ticker, quote, claimable, claimed, lifetime: claimed + claimable, recent, tokenSide };
  }));
}

/** Last `n` creator accruals for a rocket from v3 TradeFeeRouted (creatorShare + creatorTaxAmount). */
export async function recentAccruals(pc: PublicClient, token: Address, n = 6): Promise<Accrual[]> {
  const d = deployment();
  const logs = (await pc.getContractEvents({ address: d.feeRouter, abi: feeRouterAbi, eventName: "TradeFeeRouted", args: { token }, fromBlock: d.fromBlock, toBlock: "latest" }).catch(() => [])) as unknown as
    { args: { trader: Address; creatorShare: bigint; creatorTaxAmount: bigint }; transactionHash: Hex; blockNumber: bigint }[];
  return logs.slice(-n).reverse().map((l) => ({ amount: l.args.creatorShare + l.args.creatorTaxAmount, trader: l.args.trader, tx: l.transactionHash, block: l.blockNumber }));
}

/** Calls for claiming `rows` (quote side; token side too when the redeploy cap is on). Skips zero balances. */
export function creatorClaimCalls(rows: Pick<CreatorRocket, "token" | "claimable" | "tokenSide">[], caps: Caps): Call[] {
  const fr = deployment().feeRouter;
  const calls: Call[] = [];
  for (const r of rows) {
    if (caps.creatorFees && r.claimable > BigInt(0)) calls.push({ to: fr, data: encodeFunctionData({ abi: feeRouterAbi, functionName: "claimCreatorFees", args: [r.token] }) });
    if (caps.creatorTokenFees && r.tokenSide && r.tokenSide.claimable > BigInt(0)) calls.push({ to: fr, data: encodeFunctionData({ abi: feeRouterRedeployAbi, functionName: "claimCreatorTokenFees", args: [r.token] }) });
  }
  return calls;
}

export type ClaimReceipt = { txHash: Hex; claimed: { token: Address; amount: bigint; side: "quote" | "token" }[] };
/** Send claims (one userOp for Claim all) and read the amounts back from CreatorFeesClaimed / CreatorTokenFeesClaimed. */
export async function sendCreatorClaims(calls: Call[]): Promise<ClaimReceipt> {
  if (!calls.length) throw new Error("Nothing to claim yet.");
  const r = await execCalls(calls);
  const fr = lc(deployment().feeRouter);
  const claimed: ClaimReceipt["claimed"] = [];
  for (const l of r.logs) {
    if (lc(l.address) !== fr) continue;
    for (const [abi, side] of [[feeRouterAbi, "quote"], [feeRouterRedeployAbi, "token"]] as const) {
      try {
        const ev = decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as { eventName: string; args: { token: Address; amount: bigint } };
        if (ev.eventName === "CreatorFeesClaimed" || ev.eventName === "CreatorTokenFeesClaimed") { claimed.push({ token: ev.args.token, amount: ev.args.amount, side }); break; }
      } catch { /* other event */ }
    }
  }
  return { txHash: r.txHash, claimed };
}

/* ---------------- referral rewards (LIVE on v3: referrerAccrued(referrer, quote) — referrer FIRST) ---------------- */
export type ReferralBalance = { asset: Asset; claimable: bigint };
/** Referral balances across the quote assets in use (default quote, USDG, plus any extra quotes passed in). */
export async function referralBalances(pc: PublicClient, me: Address, extraQuotes: Address[] = []): Promise<ReferralBalance[]> {
  const d = deployment();
  const qs = Array.from(new Set([d.defaultQuote, d.usdg, ...extraQuotes].filter((a) => a && !/^0x0{40}$/i.test(a)).map(lc))) as Address[];
  const rows = await Promise.all(qs.map(async (q) => ({
    asset: await assetMeta(pc, q),
    claimable: await (pc.readContract({ address: d.feeRouter, abi: feeRouterAbi, functionName: "referrerAccrued", args: [me, q] }) as Promise<bigint>).catch(() => BigInt(0)),
  })));
  return rows;
}
export function referralClaimCalls(rows: ReferralBalance[]): Call[] {
  const fr = deployment().feeRouter;
  return rows.filter((r) => r.claimable > BigInt(0)).map((r) => ({ to: fr, data: encodeFunctionData({ abi: feeRouterAbi, functionName: "claimReferrerFees", args: [r.asset.address] }) }));
}
