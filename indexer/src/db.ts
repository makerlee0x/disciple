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
  CREATE INDEX IF NOT EXISTS trades_trader ON trades(trader);
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
  `);
  return db;
}
