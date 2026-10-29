import "server-only";
/**
 * V1 achievements engine (SITE) over the KV trade index. Rules = lib/achievements.ts V1_RULES (GAME's data); pure
 * evaluator = lib/achievementsEval.ts. Run by GET /api/cron/achievements (Bearer CRON_SECRET); read by
 * GET /api/achievements and /api/achievements/feed. Keys: lib/server/achKeys.ts (chain-namespaced).
 *
 * No double-counting, by construction:
 *  - A dirty wallet is re-scored FROM SCRATCH over its full stored history (fills on every coin + Launched/GraduatedToV4
 *    of those coins). No running position is persisted, so re-runs, overlapping crons, backfills and re-indexed fills
 *    (reindex-trades: net usdIn, impactBps) all converge to the same result.
 *  - Each unlock is written once ever: SET NX `seen:<id>:<wallet>` guards the unlock zset, the feed and the counter.
 *    Unlocks are never revoked (a later rules change can only add).
 *  - Dirty members are `${wallet}|${fillId}` (unique per event): a fill stored while a wallet is being scored adds a NEW
 *    member, so it is never swallowed by the ZREM of the members this run read.
 *  - Fills dedupe by id (tradesOf); coin events are keyed by coin (one Launched, one GraduatedToV4 per coin).
 * Reorgs: RH testnet blocks are effectively final at our cadence; a reorged fill still in KV would stay counted (same as
 * /api/trades today). Revisit with the indexer's head−N guard before mainnet.
 */
import { decodeEventLog, getAbiItem, type Hex, type Log } from "viem";
import { bondingCurveAbi, launchpadAbi } from "@/lib/abi";
import { ACTIVE_CHAIN, deployment, ZERO } from "@/lib/chains";
import { anonLaunchers } from "@/lib/anon";
import { playerUsd, type Fill } from "@/lib/trades";
import { V1_RULES, V1_RULES_VERSION, type AchEvent, type AchEventRef, type AchievementRule, type AchievementUnlockRecord } from "@/lib/achievements";
import { evaluateWallet, ruleTarget, type EvalResult } from "@/lib/achievementsEval";
import { serverPc } from "./chat/identity";
import { kv, type Kv } from "./kv";
import { ACH } from "./achKeys";
import { coinsOf, tradesOf, TRADES_MAX_LIMIT } from "./trades";

const LAUNCHED = getAbiItem({ abi: launchpadAbi, name: "Launched" });
const GRADUATED = getAbiItem({ abi: bondingCurveAbi, name: "GraduatedToV4" });
const CHUNK = BigInt(Math.max(100, Number(process.env.ACH_CHUNK_BLOCKS) || 20_000));
/** Unlocks whose event is older than this when first recorded (backfill) are stored but NOT put on the toast feed. */
const FEED_FRESH_MS = 15 * 60_000;
const FEED_MAX = 500;
const TEN_YEARS = 10 * 365 * 86400;

export interface CoinMeta { creator: string; anon: boolean; curve: string; launch: AchEventRef; grad?: AchEventRef }

/* ------------------------------------------------ pure helpers (tests) ------------------------------------------------ */

/** Pure: stored fill → evaluator event (player $ = net usdIn / usdOut / usd). */
export function fillEvent(f: Fill): AchEvent {
  return {
    kind: "fill", id: f.id, tx: f.tx, block: f.block, logIndex: f.logIndex, ts: f.ts, coin: f.coin, wallet: f.trader,
    side: f.side, venue: f.venue, tokens: f.tokens, usd: playerUsd(f), impactBps: typeof f.impactBps === "number" ? Math.abs(f.impactBps) : undefined,
  };
}
/** Pure: coin metas → launch/graduation events. */
export function coinEvents(metas: Map<string, CoinMeta>): AchEvent[] {
  const out: AchEvent[] = [];
  for (const [coin, m] of Array.from(metas.entries())) {
    out.push({ kind: "launch", coin, creator: m.creator, anon: m.anon, ...m.launch });
    if (m.grad) out.push({ kind: "graduation", coin, ...m.grad });
  }
  return out;
}

/** API item for one rule (GET /api/achievements). */
export interface AchievementApiItem {
  id: string; name: string; rarity: string;
  /** ms (block time of the unlocking event) */
  unlockedAt?: number; tx?: string; block?: number; logIndex?: number; coin?: string;
  progress: number; target: number;
}
export function apiItems(rules: readonly AchievementRule[], unlocks: AchievementUnlockRecord[], progress: EvalResult["progress"] | undefined): AchievementApiItem[] {
  const byId = new Map(unlocks.map((u) => [u.id, u]));
  return rules.map((r) => {
    const u = byId.get(r.id), target = ruleTarget(r);
    const p = u ? target : Math.max(0, Math.min(target, progress?.[r.id]?.progress ?? 0));
    return { id: r.id, name: r.name, rarity: r.rarity, ...(u ? { unlockedAt: u.ts, tx: u.tx, block: u.block, logIndex: u.logIndex, coin: u.coin } : {}), progress: p, target };
  });
}

/* ------------------------------------------------------- reads ------------------------------------------------------- */

const parse = <T>(s: string | null): T | null => { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } };

export async function unlocksOf(wallet: string, s: Kv = kv()): Promise<AchievementUnlockRecord[]> {
  const seen = new Set<string>();
  return (await s.zrange(ACH.unlocks(wallet), 1000)).map((m) => parse<AchievementUnlockRecord>(m)).filter((u): u is AchievementUnlockRecord => !!u && !seen.has(u.id) && (seen.add(u.id), true));
}

/** GET /api/achievements body. Reads KV only (no RPC, no scoring). */
export async function achievementsOf(wallet: string): Promise<{ wallet: string; chainId: number; rulesVersion: number; evaluatedAt: number | null; items: AchievementApiItem[] }> {
  const s = kv(), w = wallet.toLowerCase();
  const [unlocks, p] = await Promise.all([unlocksOf(w, s), s.get(ACH.progress(w)).then((x) => parse<{ v: number; at: number; progress: EvalResult["progress"] }>(x))]);
  return { wallet: w, chainId: ACTIVE_CHAIN.id, rulesVersion: V1_RULES_VERSION, evaluatedAt: p?.at ?? null, items: apiItems(V1_RULES, unlocks, p?.progress) };
}

export interface FeedRow { wallet: string; id: string; name: string; rarity: string; unlockedAt: number; tx: string; recordedAt: number }
/** GET /api/achievements/feed: live unlocks RECORDED after `since` (ms), oldest first; optional wallet filter. */
export async function feedSince(since: number, wallet?: string | null, limit = 100): Promise<FeedRow[]> {
  const rows = (await kv().zrange(ACH.feed(), FEED_MAX, true)).map((m) => parse<FeedRow>(m)).filter((r): r is FeedRow => !!r);
  const w = wallet?.toLowerCase();
  return rows.filter((r) => r.recordedAt > since && (!w || r.wallet === w)).sort((a, b) => a.recordedAt - b.recordedAt).slice(0, limit);
}

/* ----------------------------------------------------- coin events ---------------------------------------------------- */

async function coinMetas(coins: string[], s: Kv): Promise<Map<string, CoinMeta>> {
  const m = new Map<string, CoinMeta>();
  if (!coins.length) return m;
  const vals = await s.mget(coins.map((c) => ACH.coin(c)));
  coins.forEach((c, i) => { const v = parse<CoinMeta>(vals[i]); if (v) m.set(c.toLowerCase(), v); });
  return m;
}

const blockTs = new Map<bigint, number>();
async function tsOf(bn: bigint): Promise<number> {
  const hit = blockTs.get(bn); if (hit) return hit;
  const t = Number((await serverPc().getBlock({ blockNumber: bn })).timestamp) * 1000; blockTs.set(bn, t); return t;
}
const refOf = async (l: Log): Promise<AchEventRef> => ({ tx: String(l.transactionHash), block: Number(l.blockNumber), logIndex: Number(l.logIndex), ts: await tsOf(l.blockNumber ?? BigInt(0)) });

/**
 * Scan Launched (launchpad) + GraduatedToV4 (any emitter; kept only when emitter = that coin's curve from its Launched)
 * from the cursor. Marks dirty: the creator on a launch; every trader of the coin on a graduation.
 */
export async function scanCoinEvents(budgetMs = 15_000, s: Kv = kv()): Promise<{ launches: number; graduations: number; cursor: string; latest: string; done: boolean }> {
  const d = deployment(), pc = serverPc(), t0 = Date.now();
  const out = { launches: 0, graduations: 0, cursor: "", latest: "", done: true };
  if (d.launchpad === ZERO) return out;
  const ck = ACH.cursor(d.launchpad);
  const latest = await pc.getBlockNumber();
  let cur = BigInt((await s.get(ck)) ?? (d.fromBlock - BigInt(1)).toString());
  const anon = new Set(anonLaunchers(ACTIVE_CHAIN.id).map((a) => a.toLowerCase()));
  let chunk = CHUNK;
  while (cur < latest) {
    if (Date.now() - t0 > budgetMs) { out.done = false; break; }
    const from = cur + BigInt(1), to = from + chunk - BigInt(1) > latest ? latest : from + chunk - BigInt(1);
    let launches: Log[], grads: Log[];
    try {
      [launches, grads] = await Promise.all([
        pc.getLogs({ address: d.launchpad, event: LAUNCHED, fromBlock: from, toBlock: to }) as Promise<Log[]>,
        pc.getLogs({ event: GRADUATED, fromBlock: from, toBlock: to }) as Promise<Log[]>,
      ]);
    } catch (e) { if (chunk > BigInt(200)) { chunk = chunk / BigInt(4); continue; } throw e; }
    for (const l of launches) {
      const a = (decodeEventLog({ abi: [LAUNCHED], data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as { args: { token: string; curve: string; creator: string } }).args;
      const coin = a.token.toLowerCase(), creator = a.creator.toLowerCase();
      if (await s.get(ACH.coin(coin))) continue;
      const meta: CoinMeta = { creator, anon: anon.has(creator), curve: a.curve.toLowerCase(), launch: await refOf(l) };
      await s.set(ACH.coin(coin), JSON.stringify(meta));
      await s.sadd(ACH.coins(), coin);
      // creator (launch rules) + anyone whose fills were indexed before this meta existed (fills only count on coins
      // with a meta in this chain's namespace — see scoreWallet)
      const ws = await tradersOf(coin, s);
      if (!meta.anon) ws.add(creator);
      if (ws.size) await s.zadd(ACH.dirty(), Array.from(ws).map((w) => ({ score: Date.now(), member: `${w}|launch:${coin}` })));
      out.launches++;
    }
    for (const l of grads) {
      let a: { token: string };
      try { a = (decodeEventLog({ abi: [GRADUATED], data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as { args: { token: string } }).args; } catch { continue; }
      const coin = a.token.toLowerCase();
      const meta = parse<CoinMeta>(await s.get(ACH.coin(coin)));
      if (!meta || meta.curve !== l.address.toLowerCase() || meta.grad) continue;   // spoofed / foreign / already recorded
      meta.grad = await refOf(l);
      await s.set(ACH.coin(coin), JSON.stringify(meta));
      const traders = await tradersOf(coin, s);
      if (!meta.anon) traders.add(meta.creator);
      if (traders.size) await s.zadd(ACH.dirty(), Array.from(traders).map((w) => ({ score: Date.now(), member: `${w}|grad:${coin}` })));
      out.graduations++;
    }
    cur = to;
    await s.set(ck, cur.toString());
  }
  out.cursor = cur.toString(); out.latest = latest.toString();
  return out;
}

async function tradersOf(coin: string, s: Kv): Promise<Set<string>> {
  const set = new Set<string>();
  for (const m of await s.zrange(`trades:${coin.toLowerCase()}`, 1_000_000)) { const f = parse<Fill>(m); if (f?.trader) set.add(f.trader.toLowerCase()); }
  return set;
}

/* ------------------------------------------------------- scoring ------------------------------------------------------ */

/** Re-score one wallet from scratch and persist new unlocks (SET NX guarded). dryRun ⇒ compute only. */
export async function scoreWallet(walletIn: string, o: { dryRun?: boolean; s?: Kv; now?: number } = {}): Promise<{ wallet: string; unlocks: AchievementUnlockRecord[]; fresh: string[]; fills: number }> {
  const s = o.s ?? kv(), w = walletIn.toLowerCase(), now = o.now ?? Date.now();
  const coins = await coinsOf(w);
  const fills: Fill[] = [];
  for (const c of coins) fills.push(...(await tradesOf(c, w, TRADES_MAX_LIMIT)));
  const launched = (await s.smembers(ACH.coins())).length ? await launchedBy(w, s) : [];
  const metas = await coinMetas(Array.from(new Set([...coins, ...launched])), s);
  // Chain isolation (lee 9:24 AM CDT, Oct 26: "achievements reset at mainnet"): fill keys (`trades:*`) are per coin
  // address, not per chain, so only fills on coins launched by THIS chain's launchpad (meta under ach:<chainId>:coin:)
  // count. A shared Upstash DB can never leak testnet fills into mainnet unlocks.
  const onChain = fills.filter((f) => metas.has(f.coin.toLowerCase()));
  const r = evaluateWallet(w, [...onChain.map((f) => fillEvent(f)), ...coinEvents(metas)], V1_RULES);
  const fresh: string[] = [];
  if (!o.dryRun) {
    for (const u of r.unlocks) {
      if (!(await s.setNX(ACH.seen(u.id, w), String(u.ts)))) continue;
      fresh.push(u.id);
      await s.zadd(ACH.unlocks(w), [{ score: u.ts, member: JSON.stringify(u) }]);
      await s.incrEx(ACH.count(u.id), TEN_YEARS);
      if (now - u.ts <= FEED_FRESH_MS) {
        const rule = V1_RULES.find((x) => x.id === u.id)!;
        const row: FeedRow = { wallet: w, id: u.id, name: rule.name, rarity: rule.rarity, unlockedAt: u.ts, tx: u.tx, recordedAt: now };
        await s.zadd(ACH.feed(), [{ score: now, member: JSON.stringify(row) }]);
      }
    }
    await s.set(ACH.progress(w), JSON.stringify({ v: V1_RULES_VERSION, at: now, progress: r.progress }));
  }
  return { wallet: w, unlocks: r.unlocks, fresh, fills: fills.length };
}

/** Coins this wallet launched (public), from the coin metas. Small set on testnet; index by creator if it grows. */
async function launchedBy(w: string, s: Kv): Promise<string[]> {
  const coins = await s.smembers(ACH.coins());
  const metas = await coinMetas(coins, s);
  return Array.from(metas.entries()).filter(([, m]) => m.creator === w && !m.anon).map(([c]) => c);
}

/**
 * Seed every known trader + creator as dirty once per rules version (first run = full backfill; V1_RULES_VERSION bump =
 * re-score). Resumable: progress index in `seed:<v>`; `ver` is set only when every coin is done.
 */
export async function seedIfNeeded(budgetMs = 10_000, s: Kv = kv()): Promise<{ seeded: number; done: boolean; skipped?: boolean }> {
  if (Number(await s.get(ACH.ver())) === V1_RULES_VERSION) return { seeded: 0, done: true, skipped: true };
  const t0 = Date.now();
  const coins = (await s.smembers(ACH.coins())).sort();
  let i = Number(await s.get(ACH.seed(V1_RULES_VERSION))) || 0, n = 0;
  for (; i < coins.length; i++) {
    if (Date.now() - t0 > budgetMs) { await s.set(ACH.seed(V1_RULES_VERSION), String(i)); return { seeded: n, done: false }; }
    const ws = await tradersOf(coins[i], s);
    const m = parse<CoinMeta>(await s.get(ACH.coin(coins[i])));
    if (m && !m.anon) ws.add(m.creator);
    if (ws.size) await s.zadd(ACH.dirty(), Array.from(ws).map((w) => ({ score: Date.now(), member: `${w}|seed:${V1_RULES_VERSION}` })));
    n += ws.size;
  }
  await s.set(ACH.seed(V1_RULES_VERSION), String(i));
  await s.set(ACH.ver(), String(V1_RULES_VERSION));
  return { seeded: n, done: true };
}

/** Score dirty wallets (oldest first) under a budget; ZREM exactly the members read. */
export async function processDirty(budgetMs = 20_000, o: { dryRun?: boolean; s?: Kv } = {}): Promise<{ wallets: number; fresh: number; remaining: boolean; unlocked: { wallet: string; id: string }[] }> {
  const s = o.s ?? kv(), t0 = Date.now();
  const out = { wallets: 0, fresh: 0, remaining: false, unlocked: [] as { wallet: string; id: string }[] };
  const members = await s.zrange(ACH.dirty(), 2000);
  const byWallet = new Map<string, string[]>();
  for (const m of members) { const w = m.split("|")[0]; if (/^0x[0-9a-f]{40}$/.test(w)) (byWallet.get(w) ?? byWallet.set(w, []).get(w)!).push(m); else if (!o.dryRun) await s.zrem(ACH.dirty(), m); }
  for (const [w, ms] of Array.from(byWallet.entries())) {
    if (Date.now() - t0 > budgetMs) { out.remaining = true; break; }
    const r = await scoreWallet(w, { dryRun: o.dryRun, s });
    out.wallets++; out.fresh += r.fresh.length;
    for (const id of o.dryRun ? r.unlocks.map((u) => u.id) : r.fresh) if (out.unlocked.length < 50) out.unlocked.push({ wallet: w, id });
    if (!o.dryRun) await s.zrem(ACH.dirty(), ...ms);
  }
  if (members.length >= 2000) out.remaining = true;
  return out;
}

/** One cron tick: coin events → seeding (first run / rules bump) → dirty wallets. Run lock so ticks never overlap. */
export async function runAchievements(o: { budgetMs?: number; dryRun?: boolean } = {}) {
  const s = kv(), budget = o.budgetMs ?? 45_000, t0 = Date.now();
  if (!o.dryRun && !(await s.setNX(ACH.lock(), "1", 60))) return { ok: true, skipped: "locked" as const };
  try {
    // dry run: no writes at all (coin events are not scanned; scoring uses what is stored)
    const events = o.dryRun ? { launches: 0, graduations: 0, cursor: "", latest: "", done: true } : await scanCoinEvents(Math.min(15_000, budget / 3), s);
    const seed = o.dryRun ? { seeded: 0, done: true, skipped: true } : await seedIfNeeded(Math.min(10_000, budget / 4), s);
    const dirty = await processDirty(Math.max(5_000, budget - (Date.now() - t0)), { dryRun: o.dryRun, s });
    return { ok: true, events, seed, dirty, done: events.done && seed.done && !dirty.remaining };
  } finally {
    if (!o.dryRun) await s.del(ACH.lock()).catch(() => {});
  }
}
