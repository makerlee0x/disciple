import "server-only";
/** Loads a pilot's rocket logbook (lib/logbook.ts) from the indexed trades, the home coin list and their crew. */
import { logbookEntry, logRecord, sortLog, type LogCoin, type LogEntry, type LogFill, type LogRecord, type StoryEvent } from "@/lib/logbook";
import { playerUsd, type Fill } from "@/lib/trades";
import type { Guild } from "@/lib/guilds";
import { getHomeData } from "./home";
import { guilds } from "./guilds";
import { coinsOf, tradesOf } from "./trades";

/** rockets read per logbook (newest activity first after sorting); the rest are counted, not shown */
export const LOGBOOK_MAX_COINS = 60;
const COIN_FILLS = 2000;

const toLog = (f: Fill): LogFill => ({ ts: f.ts, block: f.block, logIndex: f.logIndex, trader: f.trader, side: f.side, tokens: f.tokens, usd: playerUsd(f), mcapUsd: f.mcapUsd, priceUsd: f.priceUsd, impactBps: typeof f.impactBps === "number" ? Math.abs(f.impactBps) : undefined });

export async function coinMetas(): Promise<Map<string, LogCoin>> {
  const h = await getHomeData();
  return new Map(h.coins.map((c) => [c.token, { token: c.token, name: c.name, ticker: c.ticker, creator: c.creatorAddr ?? "", graduated: c.graduated, mode: c.mode ?? undefined, mcapUsd: c.mcapUsd }]));
}

/** The pilot's crew and its members (them excluded), or none. */
export async function crewOf(wallet: string): Promise<{ guild: Guild | null; members: Set<string> }> {
  try {
    const g = await guilds().guildOf(wallet);
    if (!g) return { guild: null, members: new Set() };
    const m = await guilds().membersOf(g.id);
    return { guild: g, members: new Set(m.filter((x) => x !== wallet.toLowerCase())) };
  } catch { return { guild: null, members: new Set() }; }
}

/** One rocket, merged: the wallet's whole history on it + the rocket's newest fills. */
async function coinFillsFor(wallet: string, coin: string): Promise<LogFill[]> {
  const [mine, recent] = await Promise.all([tradesOf(coin, wallet, 5000, "asc"), tradesOf(coin, null, COIN_FILLS, "desc")]);
  const seen = new Set<string>(), out: LogFill[] = [];
  for (const f of [...mine, ...recent]) { if (seen.has(f.id)) continue; seen.add(f.id); out.push(toLog(f)); }
  return out;
}

export type Logbook = { entries: LogEntry[]; record: LogRecord; total: number; crew: { tag: string; name: string } | null };

export async function logbookFor(walletIn: string, now = Date.now()): Promise<Logbook> {
  const w = walletIn.toLowerCase();
  const [coins, metas, crew] = await Promise.all([coinsOf(w), coinMetas(), crewOf(w)]);
  const known = coins.map((c) => c.toLowerCase()).filter((c) => metas.has(c)).slice(0, LOGBOOK_MAX_COINS);
  const entries = (await Promise.all(known.map(async (c) => {
    const r = logbookEntry({ wallet: w, coin: metas.get(c)!, fills: await coinFillsFor(w, c).catch(() => []), crew: crew.members, now });
    return r?.entry ?? null;
  }))).filter((e): e is LogEntry => !!e);
  sortLog(entries);
  return { entries, record: logRecord(entries), total: coins.length, crew: crew.guild ? { tag: crew.guild.tag, name: crew.guild.name } : null };
}

export type RocketStory = { entry: LogEntry; story: StoryEvent[]; index: number; total: number; host: string | null };

export async function rocketStoryFor(walletIn: string, coinIn: string, now = Date.now()): Promise<RocketStory | null> {
  const w = walletIn.toLowerCase(), coin = coinIn.toLowerCase();
  const [metas, crew, coins] = await Promise.all([coinMetas(), crewOf(w), coinsOf(w)]);
  const meta = metas.get(coin);
  if (!meta) return null;
  const r = logbookEntry({ wallet: w, coin: meta, fills: await coinFillsFor(w, coin), crew: crew.members, now });
  if (!r) return null;
  const list = coins.map((c) => c.toLowerCase()).filter((c) => metas.has(c));
  return { ...r, index: Math.max(1, list.indexOf(coin) + 1), total: list.length, host: meta.creator || null };
}
