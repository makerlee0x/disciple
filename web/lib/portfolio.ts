/**
 * Header portfolio (WalletButton): "cash" = the account's USDG (shown as dollars, never as "USDG"), plus the market value
 * of every DISCIPLE coin the account holds at the current price, and the 24h $ change.
 * 24h change: there is no stored portfolio history, so it is computed for the CURRENT holdings from each coin's price
 * 24h ago (last indexed fill at/before now−24h, /api/trades; a coin younger than 24h uses its launch price) vs now.
 * Cash is treated as flat ($1 USDG). Deposits/withdrawals and trades inside the window are therefore not "PnL" here.
 */
import { parseAbi, type Address, type PublicClient } from "viem";
import { bondingCurveAbi, tokenAbi } from "./abi";
import { deployment } from "./chains";
import { CURVE } from "./config";
import { TOTAL_SUPPLY_TOKENS, type Fill } from "./trades";
import { coinFacts, decimalsOf, readMarket } from "./protocol-viem";

export type Holding = { coin: Address; tokens: number; priceNow: number; price24h: number };
export type Portfolio = { cashUsd: number; holdingsUsd: number; totalUsd: number; change24hUsd: number; holdings: Holding[]; at: number };

const DAY = 24 * 60 * 60 * 1000;

/** Pure: price of a coin 24h ago from its fills (ascending or not), or the launch price when it's younger than 24h. */
export function price24hAgo(fills: Pick<Fill, "ts" | "priceUsd">[], now = Date.now(), launchPrice = CURVE.startMcap / TOTAL_SUPPLY_TOKENS): number {
  const cut = now - DAY;
  let best: { ts: number; priceUsd: number } | null = null;
  for (const f of fills) if (f.ts <= cut && f.priceUsd > 0 && (!best || f.ts > best.ts)) best = f;
  return best ? best.priceUsd : launchPrice;
}

/** Pure: totals. */
export function summarize(cashUsd: number, holdings: Holding[], at = Date.now()): Portfolio {
  const held = holdings.filter((h) => h.tokens > 0);
  const holdingsUsd = held.reduce((s, h) => s + h.tokens * h.priceNow, 0);
  const change24hUsd = held.reduce((s, h) => s + h.tokens * (h.priceNow - h.price24h), 0);
  return { cashUsd, holdingsUsd, totalUsd: cashUsd + holdingsUsd, change24hUsd, holdings: held, at };
}

const fillsCache = new Map<string, { at: number; p: Promise<number> }>();
function cachedPrice24h(coin: Address): Promise<number> {
  const k = coin.toLowerCase(), hit = fillsCache.get(k);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.p;
  const p = fetch(`/api/trades?coin=${coin}&order=desc&limit=2000`).then((r) => r.json()).then((j: { fills?: Fill[] }) => price24hAgo(j.fills ?? []))
    .catch(() => CURVE.startMcap / TOTAL_SUPPLY_TOKENS);
  fillsCache.set(k, { at: Date.now(), p });
  return p;
}
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
async function priceNow(pc: PublicClient, coin: Address): Promise<number> {
  const f = await coinFacts(pc, coin);
  if (f.graduated) { const m = await readMarket(pc, coin); if (m && m.mcapUsd > 0) return m.mcapUsd / TOTAL_SUPPLY_TOKENS; }
  const mcap = await pc.readContract({ address: f.curve, abi: bondingCurveAbi, functionName: "marketCapUsd" }) as bigint;
  return Number(mcap) / 1e18 / TOTAL_SUPPLY_TOKENS;
}

/** Coins the account ever traded (indexer) + extra (e.g. the coin on this page). */
async function coinsOf(account: Address, extra: Address[]): Promise<Address[]> {
  const j = await fetch(`/api/trades?wallet=${account}`).then((r) => r.json()).catch(() => ({})) as { coins?: string[] };
  const set = new Map<string, Address>();
  for (const c of [...(j.coins ?? []), ...extra]) if (/^0x[0-9a-fA-F]{40}$/.test(c)) set.set(c.toLowerCase(), c as Address);
  return [...set.values()];
}

export async function loadPortfolio(pc: PublicClient, account: Address, extra: Address[] = []): Promise<Portfolio> {
  const usdg = deployment().usdg;
  const [cashRaw, dec, coins] = await Promise.all([
    pc.readContract({ address: usdg, abi: tokenAbi, functionName: "balanceOf", args: [account] }) as Promise<bigint>,
    decimalsOf(pc, usdg),
    coinsOf(account, extra),
  ]);
  const holdings = (await Promise.all(coins.map(async (coin): Promise<Holding | null> => {
    try {
      const bal = await pc.readContract({ address: coin, abi: erc20, functionName: "balanceOf", args: [account] });
      if (bal === BigInt(0)) return null;
      const [pn, p24] = await Promise.all([priceNow(pc, coin), cachedPrice24h(coin)]);
      return { coin, tokens: Number(bal) / 1e18, priceNow: pn, price24h: p24 };
    } catch { return null; }
  }))).filter((h): h is Holding => !!h);
  return summarize(Number(cashRaw) / 10 ** dec, holdings);
}
