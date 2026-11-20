import "server-only";
/**
 * Server side of /admin/stats (Team only). Reads what the site already has; adds no tracking:
 *  - Privy users: GET https://api.privy.io/v1/users (Basic appId:PRIVY_APP_SECRET), paged, cached 5 min in-process
 *  - launches: lib/events listLaunches + each launch block's timestamp (cached forever, blocks don't move)
 *  - trades: the KV trade index (tradesOf per coin, newest 5000 each)
 *  - usernames: search:users zset size; funnel counters (lib/funnel keys); duel rooms (duel:rooms zset)
 *  - Lighter: the integrator (fee) account's collateral, when LIGHTER_INTEGRATOR_INDEX is set
 * Each part fails on its own: a slow Privy or RPC leaves that card empty with a note, never the whole page.
 * Known test coins (lib/home/hiddenCoins) are left out, same as the home feed.
 */
import type { PublicClient } from "viem";
import { ACTIVE_CHAIN, isDeployed } from "@/lib/chains";
import { anonLaunchers } from "@/lib/anon";
import { listLaunches } from "@/lib/events";
import { isHiddenCoin } from "@/lib/home/hiddenCoins";
import { FUNNEL_STEPS, dayKey, funnelNet, lastDays, totalKey } from "@/lib/funnel";
import { launchStats, tradeStats, userStats, type StatFill, type StatLaunch, type StatUser } from "@/lib/adminStats";
import { serverPc } from "./chat/identity";
import { kv } from "./kv";
import { privyEnv, type PrivyEnv } from "./privyAuth";
import { USERS_Z } from "./searchIndex";
import { indexTrades, tradesOf } from "./trades";
import { usernameOf } from "./usernames";
import { lighterConfig } from "./lighter/config";
import { account } from "./lighter/rest";

const DAYS = 14;
const MAX_USER_PAGES = 100; // 10,000 users at 100 a page
const settle = async <T,>(p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; error: string }> =>
  p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, error: String((e as Error)?.message || e).slice(0, 160) }));

/* ---------- Privy users ---------- */
let usersCache: { at: number; app: string; rows: StatUser[] } | null = null;
export async function privyUsers(pe: PrivyEnv = privyEnv(), now = Date.now()): Promise<StatUser[]> {
  if (!pe.appId || !pe.appSecret) throw new Error("PRIVY_APP_SECRET is not set");
  if (usersCache && usersCache.app === pe.appId && now - usersCache.at < 5 * 60_000) return usersCache.rows;
  const auth = "Basic " + Buffer.from(`${pe.appId}:${pe.appSecret}`).toString("base64");
  const rows: StatUser[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_USER_PAGES; page++) {
    const u = new URL("https://api.privy.io/v1/users");
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    const r = await fetch(u, { headers: { authorization: auth, "privy-app-id": pe.appId }, signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!r.ok) throw new Error(`Privy answered ${r.status}`);
    const j = (await r.json()) as { data?: { id: string; created_at: number; is_guest?: boolean; linked_accounts?: { type: string }[] }[]; next_cursor?: string | null };
    for (const x of j.data ?? []) rows.push({ id: x.id, createdMs: Number(x.created_at) * 1000, guest: !!x.is_guest, logins: (x.linked_accounts ?? []).map((a) => a.type) });
    cursor = j.next_cursor ?? null;
    if (!cursor) break;
  }
  usersCache = { at: now, app: pe.appId, rows };
  return rows;
}

/* ---------- launches ---------- */
const blockTs = new Map<string, number>();
async function blockTimes(pc: PublicClient, blocks: bigint[]): Promise<Map<string, number>> {
  const todo = [...new Set(blocks.map(String))].filter((b) => !blockTs.has(b));
  for (let i = 0; i < todo.length; i += 20) {
    await Promise.all(todo.slice(i, i + 20).map(async (b) => {
      const blk = await pc.getBlock({ blockNumber: BigInt(b) }).catch(() => null);
      if (blk) blockTs.set(b, Number(blk.timestamp) * 1000);
    }));
  }
  return blockTs;
}

async function launches(): Promise<StatLaunch[]> {
  if (!isDeployed()) return [];
  const pc = serverPc() as unknown as PublicClient;
  const all = (await listLaunches(pc, async () => new Map())).filter((c) => !isHiddenCoin(c.token));
  const ts = await blockTimes(pc, all.map((c) => c.block));
  const anon = new Set(anonLaunchers(ACTIVE_CHAIN.id).map((a) => a.toLowerCase()));
  return all.map((c) => ({
    token: c.token, name: c.name, ticker: c.ticker, creator: c.creator, ts: ts.get(String(c.block)) ?? 0,
    mcapUsd: c.mcapUsd, graduated: c.graduated, anon: anon.has(c.creator.toLowerCase()),
  }));
}

/* ---------- small KV reads ---------- */
async function funnel(now: number) {
  const net = funnelNet(ACTIVE_CHAIN.id, process.env.VERCEL_ENV);
  const days = lastDays(now, 7);
  const s = kv();
  const [tot, wk] = await Promise.all([
    s.mget(FUNNEL_STEPS.map((st) => totalKey(net, st))),
    s.mget(days.flatMap((d) => FUNNEL_STEPS.map((st) => dayKey(net, st, d)))),
  ]);
  const n = (v: string | null | undefined) => Number(v) || 0;
  return FUNNEL_STEPS.map((step, j) => ({
    step,
    today: n(wk[(days.length - 1) * FUNNEL_STEPS.length + j]),
    d7: days.reduce((a, _, i) => a + n(wk[i * FUNNEL_STEPS.length + j]), 0),
    total: n(tot[j]),
  }));
}

async function duels(now: number) {
  const s = kv();
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  const [total, t, d7] = await Promise.all([s.zcard("duel:rooms"), s.zcountAbove("duel:rooms", today), s.zcountAbove("duel:rooms", today - 6 * 86400_000)]);
  return { today: t, d7, total };
}

async function lighterFees() {
  const cfg = lighterConfig();
  if (!cfg.enabled || !cfg.integratorIndex) return { enabled: cfg.enabled, network: cfg.network, account: cfg.integratorIndex || null, collateral: null as number | null };
  const a = await account(cfg, cfg.integratorIndex);
  return { enabled: true, network: cfg.network, account: cfg.integratorIndex, collateral: a ? Number(a.collateral) : null };
}

/** Wallet → @username for the top lists (one KV read each, at most ~40). */
async function names(wallets: string[]): Promise<Record<string, string>> {
  const uniq = [...new Set(wallets.map((w) => w.toLowerCase()))];
  const got = await Promise.all(uniq.map((w) => usernameOf(w).catch(() => null)));
  return Object.fromEntries(uniq.flatMap((w, i) => (got[i] ? [[w, got[i] as string]] : [])));
}

let cache: { at: number; data: AdminStats } | null = null;
export type AdminStats = Awaited<ReturnType<typeof build>>;

async function build(now: number) {
  const [users, coins, usernames, fun, duel, lighter] = await Promise.all([
    settle(privyUsers(privyEnv(), now)),
    settle(launches()),
    settle(kv().zcard(USERS_Z)),
    settle(funnel(now)),
    settle(duels(now)),
    settle(lighterFees()),
  ]);
  let trades: ReturnType<typeof tradeStats> | null = null, tradeErr: string | undefined;
  if (coins.ok) {
    await indexTrades(4_000).catch(() => null);
    const per = await Promise.all(coins.v.map((c) => tradesOf(c.token, null, 5000, "desc").catch(() => [])));
    const fills: StatFill[] = per.flat();
    trades = tradeStats(fills, now, DAYS);
  } else tradeErr = coins.error;
  const launch = coins.ok ? launchStats(coins.v, now, DAYS) : null;
  const who = await names([...(launch?.top.map((x) => x.wallet) ?? []), ...(launch?.recent.map((x) => x.creator) ?? []), ...(trades?.top.map((x) => x.wallet) ?? [])]);
  const coinName = Object.fromEntries((coins.ok ? coins.v : []).map((c) => [c.token.toLowerCase(), c.ticker]));
  return {
    at: now,
    chainId: ACTIVE_CHAIN.id,
    names: who,
    coinNames: coinName,
    users: users.ok ? userStats(users.v, now, DAYS) : null,
    usersError: users.ok ? undefined : users.error,
    usernames: usernames.ok ? usernames.v : null,
    launches: launch,
    launchesError: coins.ok ? undefined : coins.error,
    trades,
    tradesError: tradeErr,
    funnel: fun.ok ? fun.v : null,
    duels: duel.ok ? duel.v : null,
    lighter: lighter.ok ? lighter.v : null,
    lighterError: lighter.ok ? undefined : lighter.error,
  };
}

/** Cached 60 s; `fresh` skips the cache (the page's refresh button). */
export async function adminStats(fresh = false, now = Date.now()): Promise<AdminStats> {
  if (!fresh && cache && now - cache.at < 60_000) return cache.data;
  const data = await build(now);
  cache = { at: now, data };
  return data;
}
