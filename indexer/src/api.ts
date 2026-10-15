import http from "node:http";
import type { Address, PublicClient } from "viem";
import { READS } from "./abi.js";
import type { Config, Stack } from "./config.js";
import type { DB } from "./db.js";
import { candles, mcapUsdWad, priceWadFromSqrt, virtualQuoteReserve, wad } from "./math.js";

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const INTERVALS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
export const BIG_TRAMP_USD = 1000;

type Live = {
  priceWad: string; mcapUsd: number; quoteUsd: number; mcapSource: string; liquidityUsd: number; curveMcapNowUsd?: number;
};

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
          return {
            priceWad: p.toString(), mcapUsd: wad(mcapUsdWad(p, qUsd)), quoteUsd: wad(qUsd), mcapSource: "v4-pool",
            liquidityUsd: 2 * wad(virtualQuoteReserve(L, sqrtP, tokenIsC0)) * wad(qUsd),
            curveMcapNowUsd: wad(curveM),
          };
        } catch {
          if (st.marketLens) {
            const [p, m] = (await client.readContract({ address: st.marketLens, abi: READS, functionName: "market", args: [coin.token] })) as any;
            return { priceWad: p.toString(), mcapUsd: wad(m), quoteUsd: wad(qUsd), mcapSource: "market-lens", liquidityUsd: 0 };
          }
          throw new Error("no pool price");
        }
      }
      const [m, p, r] = await Promise.all([
        client.readContract({ address: coin.curve, abi: READS, functionName: "mcapNow" }) as Promise<bigint>,
        client.readContract({ address: coin.curve, abi: READS, functionName: "priceNow" }) as Promise<bigint>,
        client.readContract({ address: coin.curve, abi: READS, functionName: "quoteReserve" }) as Promise<bigint>,
      ]);
      return { priceWad: p.toString(), mcapUsd: wad(m), quoteUsd: wad(launchQ), mcapSource: "curve", liquidityUsd: 2 * wad(r) * wad(launchQ) };
    });
  }

  coin(token: string) {
    return this.db.prepare("SELECT * FROM coins WHERE token=?").get(token.toLowerCase()) as any;
  }

  tierInputs(coin: any, now = Math.floor(Date.now() / 1000)) {
    const st = this.stackOf(coin.stack);
    const v = this.db.prepare("SELECT COALESCE(SUM(volume_usd),0) v, COUNT(*) n FROM trades WHERE token=?").get(coin.token) as any;
    const v24 = this.db.prepare("SELECT COALESCE(SUM(volume_usd),0) v FROM trades WHERE token=? AND ts>=?").get(coin.token, now - 86400) as any;
    const exclude = [coin.curve, POOL_MANAGER, st?.migration, st?.anonLauncher, st?.hook, st?.trampWallManager]
      .filter(Boolean).map((x) => String(x).toLowerCase());
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
    if (st.anonLauncher && creator.toLowerCase() === st.anonLauncher.toLowerCase()) {
      const [q, qa, ta] = (await this.client.readContract({ address: st.anonLauncher, abi: READS, functionName: "pending", args: [c.token] })) as any;
      const owner = await this.client.readContract({ address: st.anonLauncher, abi: READS, functionName: "stealthOwnerOf", args: [c.token] });
      anon = { stealthOwner: owner, quote: q, quotePending: qa.toString(), tokenPending: ta.toString() };
    }
    const claimed = this.db.prepare("SELECT COUNT(*) n FROM fee_events WHERE token=? AND kind IN ('CreatorFeesClaimed','Claimed')").get(c.token) as any;
    return { token: c.token, creator, quote: c.quote, pending: accrued.toString(), pendingUsd: wad(accrued) * wad(BigInt(c.quote_price_usd ?? 0)), anon, claims: claimed.n };
  }

  listCoins(q: URLSearchParams) {
    const limit = Math.min(Number(q.get("limit") ?? 50), 500);
    const sort = q.get("sort") ?? "new";
    const where: string[] = [];
    const args: any[] = [];
    if (q.get("stack")) { where.push("c.stack=?"); args.push(q.get("stack")); }
    if (q.get("graduated")) { where.push("c.graduated=?"); args.push(q.get("graduated") === "true" ? 1 : 0); }
    if (q.get("creator")) { where.push("c.creator=?"); args.push(q.get("creator")!.toLowerCase()); }
    const order = sort === "volume" ? "volume_usd DESC" : sort === "mcap" ? "last_mcap DESC" : "c.launched_block DESC";
    return this.db.prepare(
      `SELECT c.*, COALESCE(SUM(t.volume_usd),0) volume_usd, COUNT(t.id) trades,
        (SELECT CAST(mcap_usd AS REAL)/1e18 FROM trades x WHERE x.token=c.token ORDER BY x.ts DESC, x.block DESC LIMIT 1) last_mcap
       FROM coins c LEFT JOIN trades t ON t.token=c.token ${where.length ? "WHERE " + where.join(" AND ") : ""}
       GROUP BY c.token ORDER BY ${order} LIMIT ?`,
    ).all(...args, limit);
  }

  trades(where: string, arg: string, q: URLSearchParams) {
    const limit = Math.min(Number(q.get("limit") ?? 100), 1000);
    const before = Number(q.get("before") ?? 2 ** 31);
    return this.db.prepare(`SELECT * FROM trades WHERE ${where}=? AND ts < ? ORDER BY ts DESC, block DESC LIMIT ?`).all(arg.toLowerCase(), before, limit);
  }

  candles(token: string, q: URLSearchParams) {
    const iv = INTERVALS[q.get("interval") ?? "5m"];
    if (!iv) throw new Error("bad interval");
    const field = q.get("unit") === "mcap" ? "CAST(mcap_usd AS REAL)/1e18" : "price_usd";
    const rows = this.db.prepare(`SELECT ts, ${field} price, volume_usd vol FROM trades WHERE token=? ORDER BY ts, block, id`).all(token.toLowerCase()) as any[];
    return candles(rows, iv);
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
      `SELECT stack, quote asset, kind, COUNT(*) n, SUM(CAST(b AS REAL))/1e18 sum_b, SUM(CAST(c AS REAL))/1e18 sum_c FROM fee_events
       WHERE kind IN ('RewardAccrued','SnipeFeeRouted','SnipeFeeRoutedToLP','Distributed') GROUP BY stack, quote, kind`,
    ).all();
  }

  status() {
    return { chainId: this.cfg.chainId, stacks: this.cfg.stacks, cursors: this.db.prepare("SELECT * FROM cursor").all(),
      coins: (this.db.prepare("SELECT COUNT(*) n FROM coins").get() as any).n, trades: (this.db.prepare("SELECT COUNT(*) n FROM trades").get() as any).n };
  }

  /** Minimal router; returns [status, body]. */
  async route(method: string, url: URL): Promise<[number, unknown]> {
    if (method !== "GET") return [405, { error: "GET only" }];
    const p = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
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
    }
    if (p[0] === "users" && addr(p[1])) {
      if (p[2] === "counters") return [200, this.counters(p[1])];
      if (p[2] === "orders") return [200, this.orders("owner", p[1])];
      if (p[2] === "trades") return [200, this.trades("trader", p[1], q)];
      if (p[2] === "coins") return [200, this.listCoins(new URLSearchParams({ creator: p[1] }))];
    }
    if (p[0] === "rewards") return [200, this.rewards()];
    return [404, { error: "not found" }];
  }

  server() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      let status = 500, body: unknown = { error: "internal" };
      try { [status, body] = await this.route(req.method ?? "GET", url); } catch (e: any) { status = 400; body = { error: e.message }; }
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    });
  }
}
