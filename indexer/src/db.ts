import Database from "better-sqlite3";

export type DB = Database.Database;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
  CREATE TABLE IF NOT EXISTS cursor (stack TEXT PRIMARY KEY, block INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS coins (
    token TEXT PRIMARY KEY, stack TEXT NOT NULL, curve TEXT NOT NULL, creator TEXT NOT NULL, quote TEXT NOT NULL,
    name TEXT, ticker TEXT, creator_tax_bps INTEGER, quote_price_usd TEXT, image_uri TEXT, description TEXT, socials_uri TEXT,
    launched_block INTEGER, launched_at INTEGER, launch_tx TEXT, graduated INTEGER DEFAULT 0, graduated_at INTEGER,
    pool_id TEXT, stealth_owner TEXT, anon INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY, token TEXT NOT NULL, stack TEXT NOT NULL, source TEXT NOT NULL, trader TEXT NOT NULL, is_buy INTEGER,
    quote_amt TEXT, token_amt TEXT, fee TEXT, snipe_fee TEXT, price_before TEXT, price_after TEXT, impact_bps INTEGER,
    mcap_usd TEXT, price_usd REAL, volume_usd REAL, block INTEGER, ts INTEGER, tx TEXT
  );
  CREATE INDEX IF NOT EXISTS trades_token_ts ON trades(token, ts);
  -- leaderboard (GROUP BY trader WHERE ts >= ?) and per-user trades; supersedes the old trades(trader) index
  CREATE INDEX IF NOT EXISTS trades_trader_ts ON trades(trader, ts);
  DROP INDEX IF EXISTS trades_trader;
  -- per-coin trade aggregates for listCoins, maintained on ingest (src/ingest.ts bumpCoinStats); backfilled once below
  CREATE TABLE IF NOT EXISTS coin_stats (
    token TEXT PRIMARY KEY, volume_usd REAL NOT NULL DEFAULT 0, trades INTEGER NOT NULL DEFAULT 0,
    last_mcap REAL, last_price_usd REAL, last_ts INTEGER, last_block INTEGER
  );
  CREATE INDEX IF NOT EXISTS coin_stats_volume ON coin_stats(volume_usd);
  CREATE INDEX IF NOT EXISTS coin_stats_mcap ON coin_stats(last_mcap);
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS orders (
    stack TEXT NOT NULL, id INTEGER NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL, token TEXT NOT NULL,
    tick_lower INTEGER, tick_upper INTEGER, liquidity TEXT, amount_in TEXT, amount_in_usd REAL,
    status TEXT NOT NULL DEFAULT 'open', quote_out TEXT, token_out TEXT, keeper TEXT,
    placed_tx TEXT, placed_at INTEGER, closed_tx TEXT, closed_at INTEGER, fees_quote TEXT DEFAULT '0', fees_token TEXT DEFAULT '0',
    PRIMARY KEY (stack, id)
  );
  CREATE TABLE IF NOT EXISTS fee_events (
    id TEXT PRIMARY KEY, stack TEXT, kind TEXT, token TEXT, account TEXT, quote TEXT, a TEXT, b TEXT, c TEXT, d TEXT, e TEXT, block INTEGER, ts INTEGER, tx TEXT
  );
  CREATE INDEX IF NOT EXISTS fee_token ON fee_events(token, kind);
  CREATE TABLE IF NOT EXISTS balances (token TEXT, holder TEXT, bal TEXT, PRIMARY KEY (token, holder));
  CREATE TABLE IF NOT EXISTS tier_breaks (
    id TEXT PRIMARY KEY, stack TEXT, token TEXT NOT NULL, source TEXT, from_tier INTEGER, to_tier INTEGER, mcap_usd TEXT, block INTEGER, ts INTEGER, tx TEXT
  );
  CREATE INDEX IF NOT EXISTS tier_breaks_token ON tier_breaks(token, block);
  CREATE TABLE IF NOT EXISTS keeper_tips (
    id TEXT PRIMARY KEY, stack TEXT, order_id INTEGER, keeper TEXT, quote_tip TEXT, token_tip TEXT, block INTEGER, ts INTEGER, tx TEXT
  );
  CREATE INDEX IF NOT EXISTS keeper_tips_keeper ON keeper_tips(keeper);
  CREATE TABLE IF NOT EXISTS referrals (
    stack TEXT, wallet TEXT, referrer TEXT, status TEXT, block INTEGER, ts INTEGER, tx TEXT, PRIMARY KEY (stack, wallet)
  );
  CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals(referrer);
  -- last indexed block hash per stack, for reorg detection
  CREATE TABLE IF NOT EXISTS block_hashes (stack TEXT, block INTEGER, hash TEXT, PRIMARY KEY (stack, block));
  `);
  // additive migrations for DBs created by the v0 scaffold
  const cols = (t: string) => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name));
  const add = (t: string, defs: Record<string, string>) => {
    const have = cols(t);
    for (const [c, d] of Object.entries(defs)) if (!have.has(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
  };
  add("coins", {
    tier: "INTEGER", altitude_mcap_usd: "TEXT", altitude_block: "INTEGER", start_mcap_usd: "TEXT", graduation_mcap_usd: "TEXT",
    total_supply: "TEXT", decimals: "INTEGER", launch_fee: "TEXT",
  });
  add("orders", { placed_block: "INTEGER", keeper_quote_tip: "TEXT DEFAULT '0'", keeper_token_tip: "TEXT DEFAULT '0'" });
  // one-time backfill of coin_stats for DBs indexed before the aggregates existed
  const v = db.prepare("SELECT v FROM meta WHERE k='coin_stats_v'").get() as { v: string } | undefined;
  if (v?.v !== COIN_STATS_VERSION) db.transaction(() => { rebuildCoinStats(db); db.prepare("INSERT OR REPLACE INTO meta VALUES ('coin_stats_v', ?)").run(COIN_STATS_VERSION); })();
  return db;
}

const COIN_STATS_VERSION = "1";
/**
 * Recompute coin_stats from trades (migration/backfill; also safe to call any time). last_* = the latest trade by
 * (ts, block, rowid), same "latest" the old listCoins subquery used (ts DESC, block DESC).
 */
export function rebuildCoinStats(db: DB, tokens?: string[]) {
  const where = tokens ? `WHERE token IN (${tokens.map(() => "?").join(",")})` : "";
  db.prepare(`DELETE FROM coin_stats ${where}`).run(...(tokens ?? []));
  db.prepare(`INSERT INTO coin_stats (token, volume_usd, trades, last_mcap, last_price_usd, last_ts, last_block)
    SELECT t.token, COALESCE(SUM(t.volume_usd),0), COUNT(*),
      (SELECT CAST(x.mcap_usd AS REAL)/1e18 FROM trades x WHERE x.token=t.token ORDER BY x.ts DESC, x.block DESC, x.rowid DESC LIMIT 1),
      (SELECT x.price_usd FROM trades x WHERE x.token=t.token ORDER BY x.ts DESC, x.block DESC, x.rowid DESC LIMIT 1),
      MAX(t.ts), MAX(t.block)
    FROM trades t ${where.replace("token", "t.token")} GROUP BY t.token`).run(...(tokens ?? []));
}

/** In-process data version: bumped on every applied chunk / wipe, so API caches never outlive new data. */
const versions = new WeakMap<DB, number>();
export const dataVersion = (db: DB) => versions.get(db) ?? 0;
export const bumpDataVersion = (db: DB) => { versions.set(db, dataVersion(db) + 1); };

/** Tables holding event-derived rows keyed by stack (used for reorg rewind / rebuild). */
export function wipeStack(db: DB, stack: string) {
  db.transaction(() => {
    db.prepare("DELETE FROM balances WHERE token IN (SELECT token FROM coins WHERE stack=?)").run(stack);
    db.prepare("DELETE FROM coin_stats WHERE token IN (SELECT token FROM coins WHERE stack=?)").run(stack);
    for (const t of ["trades", "orders", "fee_events", "tier_breaks", "keeper_tips", "referrals", "coins", "cursor", "block_hashes"])
      db.prepare(`DELETE FROM ${t} WHERE stack=?`).run(stack);
  })();
  bumpDataVersion(db);
}
