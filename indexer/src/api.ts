import http from "node:http";
import type { Address, PublicClient } from "viem";
import { READS } from "./abi.js";
import type { Config, Stack } from "./config.js";
import { dataVersion, type DB } from "./db.js";
import { candles, mcapUsdFromSqrt, mcapUsdWad, priceWadFromSqrt, TOTAL_SUPPLY, virtualQuoteReserve, wad } from "./math.js";

/**
 * Quote-amount sums are scaled by each coin's coins.quote_decimals (USDG 6 / 18), never a blanket 1e18; coin-token
 * amounts stay /1e18 (DISCIPLE launch tokens are fixed 18-dec). Keeper tips map order → coin for the quote decimals.
 */
const KEEPER_QD = "(SELECT c.quote_decimals FROM orders o JOIN coins c ON c.token=o.token WHERE o.stack=k.stack AND o.id=k.order_id)";

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const INTERVALS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
export const BIG_TRAMP_USD = 1000;
/** Candle range: default window and max span, in candles of the requested interval (5m → ~25h default, ~7d max). */
export const CANDLE_DEFAULT_BARS = 300;
export const CANDLE_MAX_BARS = 2000;
/** List endpoints are cached in-process for LIST_CACHE_MS (and sent with Cache-Control s-maxage for a CDN in front). */
export const LIST_CACHE_MS = Number(process.env.LIST_CACHE_MS ?? 5000);
const LIST_PATHS = new Set(["coins", "leaderboard", "tier-breaks", "orders"]);
const isListPath = (p: string[]) => LIST_PATHS.has(p[0]) && (p[0] !== "coins" || p.length === 1);

/** Integer query param: parseInt with a default, clamped to [min, max], never NaN. */
export function intParam(q: URLSearchParams, name: string, def: number, min: number, max: number): number {
  const n = Number.parseInt(q.get(name) ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

type Live = {
  /** quote raw × 1e18 / token raw — FLOORED (single digits at 6-dec USDG): display/debug only, use priceUsd / mcapUsd. */
  priceWad: string;
  /** $ per token = mcapUsd / total supply (full precision at any quote decimals). */
  priceUsd: number;
  mcapUsd: number; quoteUsd: number; mcapSource: string; liquidityUsd: number; curveMcapNowUsd?: number;
};

/** A coin's total supply (raw) — coins.total_supply when indexed, else the fixed 7B × 1e18. */
const supplyOf = (coin: any): bigint => (coin?.total_supply ? BigInt(coin.total_supply) : TOTAL_SUPPLY);
const supplyTokens = (coin: any) => Number(supplyOf(coin)) / 1e18;

export class Api {
  private cache = new Map<string, { at: number; v: any }>();
  constructor(private db: DB, private client: PublicClient | null, private cfg: Config) {}

  stackOf(id: string): Stack | undefined {
    return this.cfg.stacks.find((s) => s.id === id);
  }

  private async cached<T>(k: string, ttlMs: number, f: () => Promise<T>): Promise<T> {
    const c = this.cache.get(k);
    if (c && Date.now() - c.at < ttlMs) return c.v;
    const v = await f();
    this.cache.set(k, { at: Date.now(), v });
    return v;
  }

  /** Live market: graduated → v4 slot0 × live QuotePricer (fallback launch price, then MarketLens); else curve.mcapNow(). */
  async live(coin: any): Promise<Live | null> {
    const client = this.client;
    if (!client) return null;
    return this.cached(`live:${coin.token}`, 10_000, async () => {
      const st = this.stackOf(coin.stack)!;
      const launchQ = BigInt(coin.quote_price_usd ?? "0");
      let qUsd = launchQ;
      if (st.quotePricer) {
        try {
          const v = (await client.readContract({ address: st.quotePricer, abi: READS, functionName: "quotePriceUsd", args: [coin.quote] })) as bigint;
          if (v > 0n) qUsd = v;
        } catch {}
      }
      if (coin.graduated && coin.pool_id) {
        try {
          const [sqrtP] = (await client.readContract({ address: this.cfg.stateView, abi: READS, functionName: "getSlot0", args: [coin.pool_id] })) as any;
          const L = (await client.readContract({ address: this.cfg.stateView, abi: READS, functionName: "getLiquidity", args: [coin.pool_id] })) as bigint;
          const tokenIsC0 = BigInt(coin.token) < BigInt(coin.quote);
          const p = priceWadFromSqrt(sqrtP, tokenIsC0);
          const curveM = (await client.readContract({ address: coin.curve, abi: READS, functionName: "mcapNow" }).catch(() => 0n)) as bigint;
          const m = wad(mcapUsdFromSqrt(sqrtP, tokenIsC0, qUsd, supplyOf(coin)));
          return {
            priceWad: p.toString(), priceUsd: m / supplyTokens(coin), mcapUsd: m, quoteUsd: wad(qUsd), mcapSource: "v4-pool",
            liquidityUsd: 2 * wad(virtualQuoteReserve(L, sqrtP, tokenIsC0)) * wad(qUsd),
            curveMcapNowUsd: wad(curveM),
          };
        } catch {
          if (st.marketLens) {
            const [p, m] = (await client.readContract({ address: st.marketLens, abi: READS, functionName: "market", args: [coin.token] })) as any;
            return { priceWad: p.toString(), priceUsd: wad(m) / supplyTokens(coin), mcapUsd: wad(m), quoteUsd: wad(qUsd), mcapSource: "market-lens", liquidityUsd: 0 };
          }
          throw new Error("no pool price");
        }
      }
      const [m, p, r] = await Promise.all([
        client.readContract({ address: coin.curve, abi: READS, functionName: "mcapNow" }) as Promise<bigint>,
        client.readContract({ address: coin.curve, abi: READS, functionName: "priceNow" }) as Promise<bigint>,
        client.readContract({ address: coin.curve, abi: READS, functionName: "quoteReserve" }) as Promise<bigint>,
      ]);
      return { priceWad: p.toString(), priceUsd: wad(m) / supplyTokens(coin), mcapUsd: wad(m), quoteUsd: wad(launchQ), mcapSource: "curve", liquidityUsd: 2 * wad(r) * wad(launchQ) };
    });
  }

  coin(token: string) {
    return this.db.prepare("SELECT * FROM coins WHERE token=?").get(token.toLowerCase()) as any;
  }

  tierInputs(coin: any, now = Math.floor(Date.now() / 1000)) {
    const st = this.stackOf(coin.stack);
    const v = this.db.prepare("SELECT COALESCE(SUM(volume_usd),0) v, COUNT(*) n FROM trades WHERE token=?").get(coin.token) as any;
    const v24 = this.db.prepare("SELECT COALESCE(SUM(volume_usd),0) v FROM trades WHERE token=? AND ts>=?").get(coin.token, now - 86400) as any;
    void st;
    const exclude = this.excluded(coin);
    const holders = (this.db.prepare(`SELECT holder FROM balances WHERE token=? AND bal != '0' AND bal NOT LIKE '-%'`).all(coin.token) as any[])
      .filter((h) => !exclude.includes(h.holder)).length;
    return { volumeUsd: v.v, volume24hUsd: v24.v, trades: v.n, ageSec: now - coin.launched_at, holders };
  }

  async coinDetail(token: string) {
    const c = this.coin(token);
    if (!c) return null;
    let live: Live | null = null;
    let liveError: string | undefined;
    try { live = await this.live(c); } catch (e: any) { liveError = e.message; }
    const tier = { ...this.tierInputs(c), liquidityUsd: live?.liquidityUsd ?? null };
    return { ...c, graduated: !!c.graduated, anon: !!c.anon, live, liveError, tier };
  }

  async creatorFees(token: string) {
    const c = this.coin(token);
    if (!c || !this.client) return null;
    const st = this.stackOf(c.stack)!;
    const creator = (await this.client.readContract({ address: st.launchpad, abi: READS, functionName: "creatorOf", args: [c.token] })) as Address;
    const accrued = (await this.client.readContract({ address: st.feeRouter, abi: READS, functionName: "creatorAccrued", args: [c.token, creator] })) as bigint;
    let anon: any = null;
    // the coin's launcher = its Launchpad creator: v2, or v1 legacy (whose post-grad token share is unclaimable)
    const al = [st.anonLauncher, st.anonLauncherLegacy].find((x) => x && creator.toLowerCase() === x.toLowerCase());
    if (al) {
      const [q, qa, ta] = (await this.client.readContract({ address: al, abi: READS, functionName: "pending", args: [c.token] })) as any;
      const owner = await this.client.readContract({ address: al, abi: READS, functionName: "stealthOwnerOf", args: [c.token] });
      anon = { launcher: al, legacy: al === st.anonLauncherLegacy, stealthOwner: owner, quote: q, quotePending: qa.toString(), tokenPending: ta.toString() };
    }
    const claimed = this.db.prepare("SELECT COUNT(*) n FROM fee_events WHERE token=? AND kind IN ('CreatorFeesClaimed','Claimed')").get(c.token) as any;
    return { token: c.token, creator, quote: c.quote, pending: accrued.toString(), pendingUsd: wad(accrued) * wad(BigInt(c.quote_price_usd ?? 0)), anon, claims: claimed.n };
  }

  listCoins(q: URLSearchParams) {
    const limit = intParam(q, "limit", 50, 1, 500);
    const sort = q.get("sort") ?? "new";
    const where: string[] = [];
    const args: any[] = [];
    if (q.get("stack")) { where.push("c.stack=?"); args.push(q.get("stack")); }
    if (q.get("graduated")) { where.push("c.graduated=?"); args.push(q.get("graduated") === "true" ? 1 : 0); }
    if (q.get("creator")) { where.push("c.creator=?"); args.push(q.get("creator")!.toLowerCase()); }
    const order = sort === "volume" ? "volume_usd DESC" : sort === "mcap" ? "last_mcap DESC" : sort === "tier" ? "COALESCE(c.tier,-1) DESC, last_mcap DESC" : "c.launched_block DESC";
    // per-coin aggregates maintained on ingest (coin_stats): no scan over trades per call. Same columns as before.
    return this.db.prepare(
      `SELECT c.*, COALESCE(s.volume_usd,0) volume_usd, COALESCE(s.trades,0) trades, s.last_mcap last_mcap
       FROM coins c LEFT JOIN coin_stats s ON s.token=c.token ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY ${order} LIMIT ?`,
    ).all(...args, limit);
  }

  trades(where: string, arg: string, q: URLSearchParams) {
    const limit = intParam(q, "limit", 100, 1, 1000);
    const before = intParam(q, "before", 2 ** 31, 0, 2 ** 31);
    return this.db.prepare(`SELECT * FROM trades WHERE ${where}=? AND ts < ? ORDER BY ts DESC, block DESC LIMIT ?`).all(arg.toLowerCase(), before, limit);
  }

  /**
   * OHLC over [from, to] (unix seconds). Defaults: to = the coin's last trade (no trades exist after it, so this equals
   * "now" while never returning an empty chart for a quiet coin), from = to − CANDLE_DEFAULT_BARS × interval. The span
   * is capped at CANDLE_MAX_BARS × interval (from is raised). Only that range is read (trades_token_ts index); the
   * first candle opens at the last close before `from`, as the unbounded version did.
   */
  candles(token: string, q: URLSearchParams) {
    const iv = INTERVALS[q.get("interval") ?? "5m"];
    if (!iv) throw new Error("bad interval");
    const t = token.toLowerCase();
    const field = q.get("unit") === "mcap" ? "CAST(mcap_usd AS REAL)/1e18" : "price_usd";
    const last = (this.db.prepare("SELECT last_ts FROM coin_stats WHERE token=?").get(t) as { last_ts: number | null } | undefined)?.last_ts;
    const to = intParam(q, "to", (last ?? Math.floor(Date.now() / 1000)) + 1, 0, 2 ** 31);
    let from = intParam(q, "from", to - CANDLE_DEFAULT_BARS * iv, 0, 2 ** 31);
    if (to - from > CANDLE_MAX_BARS * iv) from = to - CANDLE_MAX_BARS * iv;
    if (from > to) throw new Error("from must be <= to");
    const rows = this.db.prepare(`SELECT ts, ${field} price, volume_usd vol FROM trades WHERE token=? AND ts >= ? AND ts <= ? ORDER BY ts, block, id`).all(t, from, to) as any[];
    const prev = this.db.prepare(`SELECT ${field} price FROM trades WHERE token=? AND ts < ? ORDER BY ts DESC, block DESC, id DESC LIMIT 1`).get(t, from) as { price: number } | undefined;
    return candles(rows, iv, prev?.price);
  }

  orders(by: "token" | "owner", v: string) {
    return this.db.prepare(`SELECT * FROM orders WHERE ${by}=? ORDER BY placed_at DESC`).all(v.toLowerCase());
  }

  counters(user: string) {
    const r = this.db.prepare(
      `SELECT
        SUM(kind='tramp') trampsPlaced, SUM(kind='wall') wallsPlaced,
        SUM(kind='tramp' AND status='filled') trampsFilled,
        SUM(kind='wall' AND status='filled') wallsFilled,
        SUM(kind='tramp' AND status='filled' AND amount_in_usd >= ?) bigTrampsFilled
       FROM orders WHERE owner=?`,
    ).get(BIG_TRAMP_USD, user.toLowerCase()) as any;
    const t = this.db.prepare("SELECT COUNT(*) trades, COALESCE(SUM(volume_usd),0) volumeUsd FROM trades WHERE trader=?").get(user.toLowerCase()) as any;
    const launched = this.db.prepare("SELECT COUNT(*) n FROM coins WHERE creator=?").get(user.toLowerCase()) as any;
    const z = (x: any) => Number(x ?? 0);
    return {
      user: user.toLowerCase(), trampsPlaced: z(r.trampsPlaced), wallsPlaced: z(r.wallsPlaced), trampsFilled: z(r.trampsFilled),
      wallsFilled: z(r.wallsFilled), bigTrampsFilled: z(r.bigTrampsFilled), bigTrampUsd: BIG_TRAMP_USD, trades: t.trades, volumeUsd: t.volumeUsd, coinsLaunched: launched.n,
    };
  }

  rewards() {
    return this.db.prepare(
      `SELECT stack, quote asset, kind, COUNT(*) n, SUM(qd(a, (SELECT c.quote_decimals FROM coins c WHERE c.quote=fee_events.quote AND c.quote_decimals IS NOT NULL LIMIT 1))) sum_a, SUM(qd(b, (SELECT c.quote_decimals FROM coins c WHERE c.quote=fee_events.quote AND c.quote_decimals IS NOT NULL LIMIT 1))) sum_b FROM fee_events
       WHERE kind IN ('RewardAccrued','SnipeFeeRouted','SnipeFeeRoutedToLP','Distributed') GROUP BY stack, quote, kind`,
    ).all();
  }

  holders(token: string, q: URLSearchParams) {
    const c = this.coin(token);
    if (!c) return null;
    const limit = intParam(q, "limit", 100, 1, 1000);
    const ex = this.excluded(c);
    const rows = (this.db.prepare(`SELECT holder, bal FROM balances WHERE token=? AND bal != '0' AND bal NOT LIKE '-%'`).all(c.token) as any[])
      .map((r) => ({ holder: r.holder, balance: r.bal, protocol: ex.includes(r.holder) }))
      .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : BigInt(b.balance) < BigInt(a.balance) ? -1 : 0));
    const supply = BigInt(c.total_supply ?? "1000000000000000000000000000");
    return rows.slice(0, limit).map((r) => ({ ...r, pct: Number((BigInt(r.balance) * 1_000_000n) / supply) / 10_000 }));
  }

  excluded(coin: any) {
    const st = this.stackOf(coin.stack);
    return [coin.curve, POOL_MANAGER, st?.migration, st?.anonLauncher, st?.anonLauncherLegacy, st?.hook, st?.trampWallManager].filter(Boolean).map((x) => String(x).toLowerCase());
  }

  altitude(token: string) {
    const c = this.coin(token);
    if (!c) return null;
    const breaks = this.db.prepare("SELECT from_tier fromTier, to_tier toTier, CAST(mcap_usd AS REAL)/1e18 mcapUsd, source, block, ts, tx FROM tier_breaks WHERE token=? ORDER BY block, id").all(c.token);
    return {
      token: c.token, tier: c.tier, mcapUsd: c.altitude_mcap_usd ? wad(BigInt(c.altitude_mcap_usd)) : null, block: c.altitude_block,
      context: c.start_mcap_usd ? { startMcapUsd: wad(BigInt(c.start_mcap_usd)), graduationMcapUsd: wad(BigInt(c.graduation_mcap_usd)), totalSupply: c.total_supply, decimals: c.decimals } : null,
      breaks,
    };
  }

  tierBreaks(q: URLSearchParams) {
    const limit = intParam(q, "limit", 50, 1, 500);
    return this.db.prepare(`SELECT b.token, c.ticker, b.from_tier fromTier, b.to_tier toTier, CAST(b.mcap_usd AS REAL)/1e18 mcapUsd, b.source, b.block, b.ts, b.tx
      FROM tier_breaks b JOIN coins c ON c.token=b.token ORDER BY b.block DESC, b.id DESC LIMIT ?`).all(limit);
  }

  /** Sum of FeeRouter.TradeFeeRouted shares per quote asset (raw wei strings + USD at launch quote price). */
  feeRouting(token: string) {
    const c = this.coin(token);
    if (!c) return null;
    const rows = this.db.prepare("SELECT kind, quote, a, b, c, d, e, fee_is_quote FROM fee_events WHERE token=? AND kind IN ('TradeFeeRouted','SnipeFeeRouted','SnipeFeeRoutedToLP','CreatorFeesClaimed','RewardAccrued')").all(c.token) as any[];
    const sum = (xs: (string | null)[]) => xs.reduce((acc, x) => acc + BigInt(x ?? 0), 0n);
    // audit #11: quote-unit rows only (legacy rows have fee_is_quote NULL = quote); token-unit post-grad fees reported apart
    const tf = rows.filter((r) => r.kind === "TradeFeeRouted" && r.fee_is_quote !== 0);
    const tt = rows.filter((r) => r.kind === "TradeFeeRouted" && r.fee_is_quote === 0);
    const sn = rows.filter((r) => r.kind === "SnipeFeeRouted");
    const q = wad(BigInt(c.quote_price_usd ?? 0));
    const out: any = {
      token: c.token, quote: c.quote, trades: tf.length,
      creator: sum(tf.map((r) => r.a)), lp: sum(tf.map((r) => r.b)), treasury: sum(tf.map((r) => r.c)), referral: sum(tf.map((r) => r.d)),
      creatorTax: sum(tf.map((r) => r.e)),
      snipeToRewards: sum(sn.map((r) => r.a)), snipeToTreasury: sum(sn.map((r) => r.b)),
      snipeToLPLegacy: sum(rows.filter((r) => r.kind === "SnipeFeeRoutedToLP").map((r) => r.a)),
      creatorClaimed: sum(rows.filter((r) => r.kind === "CreatorFeesClaimed").map((r) => r.a)),
    };
    const usd: any = {};
    for (const [k, v] of Object.entries(out)) if (typeof v === "bigint") { usd[k] = wad(v) * q; out[k] = v.toString(); }
    const tokenUnits = {
      trades: tt.length, creator: sum(tt.map((r) => r.a)).toString(), lp: sum(tt.map((r) => r.b)).toString(),
      treasury: sum(tt.map((r) => r.c)).toString(), referral: sum(tt.map((r) => r.d)).toString(),
    };
    const kol = (this.db.prepare("SELECT fee_is_quote fq, amount FROM fee_credits WHERE token=? AND role='kol'").all(c.token) as any[]);
    out.kol = sum(kol.filter((r) => r.fq === 1).map((r) => r.amount)).toString();
    (tokenUnits as any).kol = sum(kol.filter((r) => r.fq === 0).map((r) => r.amount)).toString();
    usd.kol = wad(BigInt(out.kol)) * q;
    return { ...out, usd, tokenUnits };
  }

  leaderboard(kind: string, q: URLSearchParams) {
    const limit = intParam(q, "limit", 25, 1, 200);
    const since = intParam(q, "since", 0, 0, 2 ** 31);
    switch (kind) {
      case "traders": {
        const by = q.get("by") === "trades" ? "trades" : "volumeUsd";
        return this.db.prepare(`SELECT trader user, COUNT(*) trades, SUM(volume_usd) volumeUsd, SUM(is_buy) buys, COUNT(DISTINCT token) coins
          FROM trades WHERE ts >= ? GROUP BY trader ORDER BY ${by} DESC LIMIT ?`).all(since, limit);
      }
      case "creators":
        return this.db.prepare(`SELECT c.creator user, COUNT(DISTINCT c.token) coins, SUM(c.graduated) graduated, MAX(COALESCE(c.tier,-1)) bestTier,
          COALESCE((SELECT SUM(volume_usd) FROM trades t WHERE t.token IN (SELECT token FROM coins x WHERE x.creator=c.creator) AND t.ts >= ?),0) volumeUsd
          FROM coins c GROUP BY c.creator ORDER BY volumeUsd DESC LIMIT ?`).all(since, limit);
      case "coins":
        return this.listCoins(new URLSearchParams({ sort: q.get("by") ?? "volume", limit: String(limit) }));
      case "tramps":
        return this.db.prepare(`SELECT owner user, SUM(kind='tramp' AND status='filled') trampsFilled, SUM(kind='wall' AND status='filled') wallsFilled,
          SUM(CASE WHEN status='filled' THEN amount_in_usd ELSE 0 END) filledUsd, COUNT(*) placed FROM orders WHERE COALESCE(placed_at,0) >= ?
          GROUP BY owner ORDER BY trampsFilled + wallsFilled DESC, filledUsd DESC LIMIT ?`).all(since, limit);
      case "keepers":
        return this.db.prepare(`SELECT k.keeper user, COUNT(*) tips, SUM(qd(k.quote_tip, ${KEEPER_QD})) quoteTips, SUM(CAST(k.token_tip AS REAL))/1e18 tokenTips
          FROM keeper_tips k WHERE k.ts >= ? GROUP BY k.keeper ORDER BY tips DESC LIMIT ?`).all(since, limit);
      case "referrers":
        return this.db.prepare(`SELECT referrer user, SUM(status='attributed') attributed, SUM(status='pending') pending,
          COALESCE((SELECT SUM(qd(f.amount, (SELECT c.quote_decimals FROM coins c WHERE c.token=f.token))) FROM fee_credits f WHERE f.payee=r.referrer AND f.role IN ('referral','kol') AND f.fee_is_quote=1),0) referralShareQuote,
          COALESCE((SELECT SUM(CAST(f.amount AS REAL))/1e18 FROM fee_credits f WHERE f.payee=r.referrer AND f.role IN ('referral','kol') AND f.fee_is_quote=0),0) referralShareToken
          FROM referrals r GROUP BY referrer ORDER BY attributed DESC, pending DESC LIMIT ?`).all(limit);
      default:
        throw new Error("unknown leaderboard (traders|creators|coins|tramps|keepers|referrers)");
    }
  }

  holdings(user: string) {
    return this.db.prepare(`SELECT b.token, c.ticker, c.name, c.stack, c.tier, b.bal balance,
        (SELECT price_usd FROM trades t WHERE t.token=b.token ORDER BY ts DESC, block DESC LIMIT 1) lastPriceUsd
      FROM balances b JOIN coins c ON c.token=b.token WHERE b.holder=? AND b.bal != '0' AND b.bal NOT LIKE '-%'`).all(user.toLowerCase())
      .map((r: any) => ({ ...r, valueUsd: (Number(BigInt(r.balance)) / 1e18) * (r.lastPriceUsd ?? 0) }));
  }

  referrals(user: string) {
    const u = user.toLowerCase();
    const referredBy = this.db.prepare("SELECT stack, referrer, status, ts FROM referrals WHERE wallet=?").all(u);
    const referred = this.db.prepare("SELECT stack, wallet, status, ts FROM referrals WHERE referrer=? ORDER BY ts DESC").all(u);
    const claims = this.db.prepare("SELECT stack, quote, a amount, ts, tx FROM fee_events WHERE kind='ReferrerFeesClaimed' AND account=? ORDER BY ts DESC").all(u);
    const deposits = this.db.prepare("SELECT stack, a amount, b total, ts FROM fee_events WHERE kind='UsdgDepositRecorded' AND account=? ORDER BY ts DESC").all(u);
    return { user: u, referredBy, referred, claims, deposits };
  }

  profile(user: string) {
    const u = user.toLowerCase();
    return {
      user: u, counters: this.counters(u), holdings: this.holdings(u), coins: this.listCoins(new URLSearchParams({ creator: u })),
      anonCoins: this.db.prepare("SELECT token, ticker, stack FROM coins WHERE stealth_owner=?").all(u),
      referrals: this.referrals(u),
      keeperTips: this.db.prepare(`SELECT COUNT(*) n, SUM(qd(k.quote_tip, ${KEEPER_QD})) quote, SUM(CAST(k.token_tip AS REAL))/1e18 token FROM keeper_tips k WHERE k.keeper=?`).get(u),
    };
  }

  allOrders(q: URLSearchParams) {
    const where: string[] = [], args: any[] = [];
    for (const k of ["status", "kind", "token", "owner", "stack"]) if (q.get(k)) { where.push(`${k}=?`); args.push(k === "token" || k === "owner" ? q.get(k)!.toLowerCase() : q.get(k)); }
    const limit = intParam(q, "limit", 100, 1, 1000);
    return this.db.prepare(`SELECT * FROM orders ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY placed_at DESC LIMIT ?`).all(...args, limit);
  }

  status() {
    return { chainId: this.cfg.chainId, stacks: this.cfg.stacks.map((x) => ({ ...x, rpc: undefined })), cursors: this.db.prepare("SELECT * FROM cursor").all(),
      coins: (this.db.prepare("SELECT COUNT(*) n FROM coins").get() as any).n, trades: (this.db.prepare("SELECT COUNT(*) n FROM trades").get() as any).n,
      counts: Object.fromEntries(["orders", "tier_breaks", "keeper_tips", "referrals", "fee_events", "balances", "profit_tax", "holder_rewards", "usdg_escrow_events"].map((t) => [t, (this.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n])) };
  }

  /**
   * v4 PVE profit tax for one coin (quote raw strings + USD at the launch quote price). Tax is charged on sells above
   * the 1.77x trigger and distributed to curve holders; `holderRewardsClaimed` is what holders have pulled so far.
   */
  profitTax(token: string, q: URLSearchParams) {
    const c = this.coin(token);
    if (!c) return null;
    const limit = intParam(q, "limit", 50, 1, 500);
    const t = this.db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT seller) sellers FROM profit_tax WHERE token=?").get(c.token) as any;
    const sumOf = (sql: string, col: string) => (this.db.prepare(sql).all(c.token) as any[]).reduce((acc, r) => acc + BigInt(r[col] ?? 0), 0n);
    const tax = sumOf("SELECT tax FROM profit_tax WHERE token=?", "tax");
    const gross = sumOf("SELECT gross FROM profit_tax WHERE token=?", "gross");
    const basis = sumOf("SELECT cost_basis FROM profit_tax WHERE token=?", "cost_basis");
    const claimed = sumOf("SELECT amount FROM holder_rewards WHERE token=?", "amount");
    const qUsd = wad(BigInt(c.quote_price_usd ?? 0));
    const events = this.db.prepare("SELECT seller, tax, gross, cost_basis costBasis, block, ts, tx FROM profit_tax WHERE token=? ORDER BY block DESC, id DESC LIMIT ?").all(c.token, limit);
    const claims = this.db.prepare("SELECT holder, amount, block, ts, tx FROM holder_rewards WHERE token=? ORDER BY block DESC, id DESC LIMIT ?").all(c.token, limit);
    return {
      token: c.token, quote: c.quote, mode: c.mode ?? null, count: t.n, sellers: t.sellers,
      totalTax: tax.toString(), totalGross: gross.toString(), totalCostBasis: basis.toString(),
      holderRewardsClaimed: claimed.toString(), unclaimedEstimate: (tax > claimed ? tax - claimed : 0n).toString(),
      usd: { totalTax: wad(tax) * qUsd, totalGross: wad(gross) * qUsd, holderRewardsClaimed: wad(claimed) * qUsd },
      events, claims,
    };
  }

  /**
   * Everything a wallet earned or paid on v4: PVE holder rewards (claimed per coin + live pendingRewards when an RPC
   * client is attached), profit tax paid, creator fee claims (quote + launch-token units) and per-role fee credits.
   */
  async userRewards(user: string) {
    const u = user.toLowerCase();
    const claimed = this.db.prepare(`SELECT r.token, c.ticker, c.quote, COUNT(*) n, GROUP_CONCAT(r.amount) amts FROM holder_rewards r JOIN coins c ON c.token=r.token
      WHERE r.holder=? GROUP BY r.token`).all(u) as any[];
    const taxPaid = this.db.prepare(`SELECT p.token, c.ticker, c.quote, COUNT(*) n, GROUP_CONCAT(p.tax) taxes FROM profit_tax p JOIN coins c ON c.token=p.token
      WHERE p.seller=? GROUP BY p.token`).all(u) as any[];
    const sumCsv = (x: string | null) => (x ? x.split(",").reduce((acc, v) => acc + BigInt(v), 0n) : 0n).toString();
    // PVE coins the wallet holds or has claimed from (pending rewards live on the curve)
    const pveCoins = this.db.prepare(`SELECT DISTINCT c.token, c.curve, c.ticker, c.quote, c.quote_price_usd FROM coins c
      WHERE c.mode=1 AND (c.token IN (SELECT token FROM balances WHERE holder=? AND bal != '0' AND bal NOT LIKE '-%') OR c.token IN (SELECT token FROM holder_rewards WHERE holder=?))`).all(u, u) as any[];
    const pending = await Promise.all(pveCoins.map(async (c) => {
      let amount: string | null = null;
      if (this.client) try { amount = ((await this.client.readContract({ address: c.curve, abi: READS, functionName: "pendingRewards", args: [u as Address] })) as bigint).toString(); } catch {}
      return { token: c.token, ticker: c.ticker, quote: c.quote, pending: amount, pendingUsd: amount == null ? null : wad(BigInt(amount)) * wad(BigInt(c.quote_price_usd ?? 0)) };
    }));
    const creatorClaims = this.db.prepare(`SELECT kind, token, COUNT(*) n, GROUP_CONCAT(a) amts FROM fee_events WHERE account=? AND kind IN ('CreatorFeesClaimed','CreatorTokenFeesClaimed') GROUP BY kind, token`).all(u) as any[];
    const credits = this.db.prepare(`SELECT role, fee_is_quote feeIsQuote, fee_token feeToken, COUNT(*) n, GROUP_CONCAT(amount) amts FROM fee_credits WHERE payee=? GROUP BY role, fee_is_quote, fee_token`).all(u) as any[];
    return {
      user: u,
      holderRewards: { claimed: claimed.map((r) => ({ token: r.token, ticker: r.ticker, quote: r.quote, claims: r.n, amount: sumCsv(r.amts) })), pending },
      profitTaxPaid: taxPaid.map((r) => ({ token: r.token, ticker: r.ticker, quote: r.quote, sells: r.n, tax: sumCsv(r.taxes) })),
      creatorFeesClaimed: creatorClaims.map((r) => ({ token: r.token, units: r.kind === "CreatorTokenFeesClaimed" ? "token" : "quote", claims: r.n, amount: sumCsv(r.amts) })),
      feeCredits: credits.map((r) => ({ role: r.role, units: r.feeIsQuote === 0 ? "token" : "quote", feeToken: r.feeToken, count: r.n, amount: sumCsv(r.amts) })),
    };
  }

  /**
   * v4 referral state of a wallet: its referrer (pending until the $10 USDG gate), wallets it referred, gate deposits
   * (ReferralRegistry.UsdgDepositRecorded running total), UsdgDepositNotifier escrow entries (7-day lock each) and
   * withdrawals, and referral earnings (fee credits + claims).
   */
  userReferral(user: string, now = Math.floor(Date.now() / 1000)) {
    const u = user.toLowerCase();
    const referredBy = this.db.prepare("SELECT stack, referrer, status, ts, tx FROM referrals WHERE wallet=? ORDER BY ts DESC").all(u);
    const referred = this.db.prepare("SELECT stack, wallet, status, ts FROM referrals WHERE referrer=? ORDER BY ts DESC").all(u) as any[];
    const lastDep = this.db.prepare("SELECT stack, b total, ts FROM fee_events WHERE kind='UsdgDepositRecorded' AND account=? ORDER BY block DESC, id DESC LIMIT 1").get(u) as any;
    const ev = this.db.prepare("SELECT kind, counterparty, amount, escrow_id escrowId, unlock_at unlockAt, ts, tx FROM usdg_escrow_events WHERE wallet=? ORDER BY block, id").all(u) as any[];
    const sum = (k: string) => ev.filter((e) => e.kind === k).reduce((acc, e) => acc + BigInt(e.amount), 0n);
    const escrowed = sum("Escrowed"), withdrawn = sum("Withdrawn");
    const escrows = ev.filter((e) => e.kind === "Escrowed").map((e) => {
      const dep = ev.find((d) => d.kind === "Deposited" && d.tx === e.tx);
      return { id: e.escrowId, amount: e.amount, unlockAt: e.unlockAt, unlocked: e.unlockAt <= now, fundedBy: dep?.counterparty ?? null, ts: e.ts, tx: e.tx };
    });
    const credits = this.db.prepare("SELECT fee_is_quote fq, fee_token feeToken, role, amount FROM fee_credits WHERE payee=? AND role IN ('referral','kol')").all(u) as any[];
    const earned = (fq: number) => credits.filter((c) => c.fq === fq).reduce((acc, c) => acc + BigInt(c.amount), 0n).toString();
    const claims = this.db.prepare("SELECT stack, quote, a amount, ts, tx FROM fee_events WHERE kind='ReferrerFeesClaimed' AND account=? ORDER BY ts DESC").all(u);
    return {
      user: u, referredBy,
      referred: { total: referred.length, attributed: referred.filter((r) => r.status === "attributed").length, pending: referred.filter((r) => r.status === "pending").length, wallets: referred },
      usdgGate: {
        depositedTotal: lastDep?.total ?? "0", lastDepositTs: lastDep?.ts ?? null,
        escrowedNow: (escrowed > withdrawn ? escrowed - withdrawn : 0n).toString(), withdrawn: withdrawn.toString(),
        attested: sum("Attested").toString(), escrows,
        withdrawals: ev.filter((e) => e.kind === "Withdrawn").map((e) => ({ amount: e.amount, ts: e.ts, tx: e.tx })),
      },
      earnings: { quoteUnits: earned(1), tokenUnits: earned(0), claims },
    };
  }

  /** Minimal router; returns [status, body]. */
  /** LP auto-compound history: 33% LP share added to the locked full-range position (raw units). */
  lpCompounds(token: string) {
    const t = token.toLowerCase();
    const rows = this.db.prepare(
      "SELECT liquidity, token_used tokenUsed, quote_used quoteUsed, token_carry tokenCarry, quote_carry quoteCarry, block, ts, tx FROM lp_compounds WHERE token=? ORDER BY block, id",
    ).all(t) as any[];
    const sum = (k: string) => rows.reduce((acc, r) => acc + BigInt(r[k]), 0n).toString();
    const last = rows[rows.length - 1];
    return {
      token: t, count: rows.length, totalLiquidity: sum("liquidity"), totalTokenUsed: sum("tokenUsed"), totalQuoteUsed: sum("quoteUsed"),
      tokenCarry: last?.tokenCarry ?? "0", quoteCarry: last?.quoteCarry ?? "0", events: rows,
    };
  }

  async route(method: string, url: URL): Promise<[number, unknown]> {
    if (method !== "GET") return [405, { error: "GET only" }];
    const p = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    // list endpoints: short in-process TTL keyed by URL + data version (new ingest invalidates immediately)
    if (LIST_CACHE_MS > 0 && isListPath(p)) {
      const k = `list:${dataVersion(this.db)}:${url.pathname}?${url.searchParams.toString()}`;
      if (this.cache.size > 2000) for (const [ck, cv] of Array.from(this.cache)) if (Date.now() - cv.at > 60_000) this.cache.delete(ck);
      return this.cached(k, LIST_CACHE_MS, () => this.routeUncached(p, url));
    }
    return this.routeUncached(p, url);
  }

  private async routeUncached(p: string[], url: URL): Promise<[number, unknown]> {
    const q = url.searchParams;
    const addr = (x?: string) => (x && /^0x[0-9a-fA-F]{40}$/.test(x) ? x : null);
    if (p.length === 0 || p[0] === "health") return [200, this.status()];
    if (p[0] === "coins" && p.length === 1) return [200, this.listCoins(q)];
    if (p[0] === "coins" && addr(p[1])) {
      const t = p[1];
      if (p.length === 2) { const d = await this.coinDetail(t); return d ? [200, d] : [404, { error: "unknown coin" }]; }
      if (p[2] === "trades") return [200, this.trades("token", t, q)];
      if (p[2] === "candles") return [200, this.candles(t, q)];
      if (p[2] === "fees") { const f = await this.creatorFees(t); return f ? [200, f] : [404, { error: "unknown coin" }]; }
      if (p[2] === "orders") return [200, this.orders("token", t)];
      const nf = (x: unknown): [number, unknown] => (x ? [200, x] : [404, { error: "unknown coin" }]);
      if (p[2] === "holders") return nf(this.holders(t, q));
      if (p[2] === "altitude") return nf(this.altitude(t));
      if (p[2] === "fee-routing") return nf(this.feeRouting(t));
      if (p[2] === "lp-compounds") return [200, this.lpCompounds(t)];
      if (p[2] === "profit-tax") return nf(this.profitTax(t, q));
    }
    if (p[0] === "users" && addr(p[1])) {
      if (p.length === 2) return [200, this.profile(p[1])];
      if (p[2] === "holdings") return [200, this.holdings(p[1])];
      if (p[2] === "referrals") return [200, this.referrals(p[1])];
      if (p[2] === "referral") return [200, this.userReferral(p[1])];
      if (p[2] === "rewards") return [200, await this.userRewards(p[1])];
      if (p[2] === "counters") return [200, this.counters(p[1])];
      if (p[2] === "orders") return [200, this.orders("owner", p[1])];
      if (p[2] === "trades") return [200, this.trades("trader", p[1], q)];
      if (p[2] === "coins") return [200, this.listCoins(new URLSearchParams({ creator: p[1] }))];
    }
    if (p[0] === "rewards") return [200, this.rewards()];
    if (p[0] === "orders") return [200, this.allOrders(q)];
    if (p[0] === "tier-breaks") return [200, this.tierBreaks(q)];
    if (p[0] === "leaderboard" && p[1]) return [200, this.leaderboard(p[1], q)];
    return [404, { error: "not found" }];
  }

  server() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      let status = 500, body: unknown = { error: "internal" };
      try { [status, body] = await this.route(req.method ?? "GET", url); } catch (e: any) { status = 400; body = { error: e.message }; }
      const p = url.pathname.split("/").filter(Boolean);
      const cacheHdr: Record<string, string> = status === 200 && LIST_CACHE_MS > 0 && isListPath(p)
        ? { "cache-control": `public, max-age=${Math.round(LIST_CACHE_MS / 1000)}, s-maxage=${Math.round(LIST_CACHE_MS / 1000)}` } : {};
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", ...cacheHdr });
      res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    });
  }
}
