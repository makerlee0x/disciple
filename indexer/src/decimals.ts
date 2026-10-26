import type { Address } from "viem";
import type { DB } from "./db.js";

/**
 * Per-coin quote decimals (coins.quote_decimals). USDG is 6 dec on mainnet and on the testnet redeploy (~Nov 2);
 * today's testnet mUSDG and STRATEGY are 18. Resolved per distinct quote: QUOTE_DECIMALS config first, else the
 * token's decimals() on-chain. Unresolvable quotes stay NULL (and their sums NULL) rather than being guessed as 18.
 */
export function parseQuoteDecimals(v: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (v ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^(0x[0-9a-fA-F]{40})\s*[:=]\s*(\d{1,2})$/.exec(part);
    if (m && Number(m[2]) <= 36) out[m[1].toLowerCase()] = Number(m[2]);
  }
  return out;
}

export async function fillQuoteDecimals(
  db: DB, read: (token: Address) => Promise<number>, known: Record<string, number> = {}, log: (m: string) => void = () => {},
): Promise<number> {
  const quotes = (db.prepare("SELECT DISTINCT quote FROM coins WHERE quote_decimals IS NULL").all() as { quote: string }[]).map((r) => r.quote);
  let n = 0;
  for (const q of quotes) {
    let dec: number | undefined = known[q.toLowerCase()];
    if (dec === undefined) {
      try { dec = Number(await read(q as Address)); } catch (e) { log(`quote decimals ${q}: ${(e as Error).message ?? e}`); continue; }
    }
    if (!Number.isInteger(dec) || dec < 0 || dec > 36) continue;
    n += db.prepare("UPDATE coins SET quote_decimals=? WHERE quote=? AND quote_decimals IS NULL").run(dec, q).changes;
  }
  return n;
}
