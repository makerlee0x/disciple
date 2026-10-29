import "server-only";
/**
 * Public profile stats, computed on the server from the KV trade index (lib/server/trades): the same fills for
 * every visitor, so a pilot's PnL / win rate / bombs dropped on /u/<name> match what they see on /profile.
 * Coin symbol / name come from the token contract (ERC-20 reads); a failed read falls back to a short address.
 */
import { parseAbi, type Address } from "viem";
import { publicClient } from "@/lib/protocol-viem";
import type { Fill } from "@/lib/trades";
import type { StatsTrade } from "@/lib/stats";
import { publicSummaryOf, statsTradeOf, type PublicProfileSummary } from "@/lib/profileStatsCore";
import { coinsOf, indexTrades, tradesOf, TRADES_MAX_LIMIT } from "./trades";

const MAX_COINS = 40;
const isAddr = (a: string | null | undefined): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
const erc20 = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)"]);

export interface ServerProfileStats { wallet: string; summary: PublicProfileSummary; trades: StatsTrade[]; coins: number; truncated: boolean }

async function coinMeta(coin: string): Promise<{ ticker: string; name: string }> {
  const pc = publicClient();
  const [sym, nm] = await Promise.all([
    pc.readContract({ address: coin as Address, abi: erc20, functionName: "symbol" }).catch(() => ""),
    pc.readContract({ address: coin as Address, abi: erc20, functionName: "name" }).catch(() => ""),
  ]);
  const ticker = String(sym || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || coin.slice(2, 6).toUpperCase();
  return { ticker, name: String(nm || "").slice(0, 40) || `${coin.slice(0, 6)}…${coin.slice(-4)}` };
}

export async function serverProfileStats(wallet: string): Promise<ServerProfileStats> {
  const w = wallet.toLowerCase();
  await indexTrades(5_000).catch((e) => console.warn("[disciple] profile stats: trade index catch-up failed", (e as Error).message));
  const all = (await coinsOf(w)).filter(isAddr);
  const coins = all.slice(0, MAX_COINS);
  const per = await Promise.all(coins.map(async (c) => {
    const [fills, meta] = await Promise.all([tradesOf(c, w, TRADES_MAX_LIMIT, "asc"), coinMeta(c)]);
    return { fills, trades: fills.map((f) => statsTradeOf(f, meta)) };
  }));
  const fills: Fill[] = per.flatMap((p) => p.fills);
  const trades = per.flatMap((p) => p.trades);
  return { wallet: w, summary: publicSummaryOf(trades, fills), trades, coins: coins.length, truncated: all.length > coins.length };
}
