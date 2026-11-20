import "server-only";
/**
 * Flight log money rows, server side (labels: lib/cashHistory). Reads the pilot's USDG Transfer logs once and keeps them
 * in KV with a block cursor, so each visit only scans the blocks since the last one.
 *
 * KV keys (chain-namespaced):
 *   cash:<chain>:legs:<w>     JSON { cursor, legs }        USDG legs to/from the wallet (newest MAX_LEGS kept)
 *   cash:<chain>:tin:<w>      set of addresses              Turbo deposit addresses the server gave this wallet
 *   cash:<chain>:tout:<w>     zset score=at, { at, usd }    Turbo cash-backs this wallet started
 */
import { parseAbiItem, toEventSelector, type Address } from "viem";
import { ACTIVE_CHAIN, deployment } from "@/lib/chains";
import { itemById } from "@/lib/collection";
import { cashRows, throughForwarder, type CashRow, type OnwardLeg, type MarketSide, type UsdgLeg } from "@/lib/cashHistory";
import { sellerCents, type Listing } from "@/lib/market";
import { usdgRawToUsd } from "@/lib/usdg";
import { serverPc } from "./chat/identity";
import { kv, type Kv } from "./kv";
import { MKT } from "./market";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const TRANSFER_TOPIC = toEventSelector(TRANSFER);
const CHUNK0 = BigInt(2_000_000), CHUNK_MIN = BigInt(2_000);
const MAX_LEGS = 400;
const ns = () => `cash:${ACTIVE_CHAIN.id}`;
export const CASHK = {
  legs: (w: string) => `${ns()}:legs:${w}`,
  turboIn: (w: string) => `${ns()}:tin:${w}`,
  turboOut: (w: string) => `${ns()}:tout:${w}`,
  fwd: (tx: string) => `${ns()}:fwd:${tx}`,
};
const lc = (a: string) => a.toLowerCase();
const parse = <T,>(v: string | null): T | null => { if (!v) return null; try { return JSON.parse(v) as T; } catch { return null; } };
const ZERO = "0x0000000000000000000000000000000000000000";

/** The server gave this wallet a Turbo deposit address (app/api/lighter deposit-address). */
export async function noteTurboIn(w: string, address: string, s: Kv = kv()) {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) await s.sadd(CASHK.turboIn(lc(w)), lc(address)).catch(() => {});
}
/** This wallet sent Turbo cash back to Cash (app/api/lighter withdraw-finish). */
export async function noteTurboOut(w: string, usd: number, now = Date.now(), s: Kv = kv()) {
  if (usd > 0) await s.zadd(CASHK.turboOut(lc(w)), [{ score: now, member: JSON.stringify({ at: now, usd }) }]).catch(() => {});
}

/** Every protocol contract on this chain: legs to or from them are trades or launches. */
function protocolSet(): Set<string> {
  const d = deployment() as unknown as Record<string, unknown>;
  const skip = new Set(["usdg", "defaultQuote", "permit2", "permitForwarder", "creatorFeeHarvest", "curveFeeVault", "feeRouter", "referralRegistry", "fromBlock", "usdgDecimals"]);
  const out = new Set<string>();
  for (const [k, v] of Object.entries(d)) if (!skip.has(k) && typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && v !== ZERO) out.add(lc(v));
  return out;
}
const addrSet = (...xs: (string | undefined)[]) => new Set(xs.filter((x): x is string => !!x && x !== ZERO).map(lc));

const blockTs = new Map<bigint, number>();
async function tsOf(b: bigint): Promise<number> {
  const hit = blockTs.get(b); if (hit !== undefined) return hit;
  const t = Number((await serverPc().getBlock({ blockNumber: b })).timestamp) * 1000;
  if (blockTs.size > 5000) blockTs.clear();
  blockTs.set(b, t); return t;
}

/** USDG legs to/from w in [from, latest], chunked like lib/chainTransfers. Stops at the deadline and says how far it got. */
async function scan(w: Address, from: bigint, latest: bigint, deadline: number): Promise<{ legs: UsdgLeg[]; reached: bigint }> {
  const usdg = deployment().usdg, dec = deployment().usdgDecimals, pc = serverPc();
  const legs: UsdgLeg[] = [];
  let cur = from, chunk = CHUNK0, reached = from - BigInt(1);
  while (cur <= latest) {
    if (Date.now() > deadline) break;
    const to = cur + chunk - BigInt(1) > latest ? latest : cur + chunk - BigInt(1);
    let logs;
    try {
      const [a, b] = await Promise.all([
        pc.getLogs({ address: usdg, event: TRANSFER, args: { to: w }, fromBlock: cur, toBlock: to }),
        pc.getLogs({ address: usdg, event: TRANSFER, args: { from: w }, fromBlock: cur, toBlock: to }),
      ]);
      logs = [...a, ...b];
    } catch (e) { if (chunk > CHUNK_MIN) { chunk = chunk / BigInt(8); continue; } throw e; }
    for (const l of logs) {
      if (!l.transactionHash || l.blockNumber == null) continue;
      legs.push({ tx: l.transactionHash, block: Number(l.blockNumber), logIndex: Number(l.logIndex), ts: await tsOf(l.blockNumber), from: String(l.args.from), to: String(l.args.to), usd: usdgRawToUsd(l.args.value as bigint, dec) });
    }
    reached = to;
    cur = to + BigInt(1);
  }
  return { legs, reached };
}

/** The wallet's legs, caught up as far as the budget allows. `done` = scanned to the chain head. */
async function legsOf(w: string, budgetMs: number, s: Kv): Promise<{ legs: UsdgLeg[]; done: boolean }> {
  const saved = parse<{ cursor: string; legs: UsdgLeg[] }>(await s.get(CASHK.legs(w)));
  const start = saved?.cursor && /^\d+$/.test(saved.cursor) ? BigInt(saved.cursor) + BigInt(1) : deployment().fromBlock;
  const latest = await serverPc().getBlockNumber();
  if (start > latest) return { legs: saved?.legs ?? [], done: true };
  const { legs: fresh, reached } = await scan(w as Address, start, latest, Date.now() + budgetMs);
  const seen = new Set((saved?.legs ?? []).map((l) => `${l.tx}:${l.logIndex}`));
  const legs = [...(saved?.legs ?? []), ...fresh.filter((l) => !seen.has(`${l.tx}:${l.logIndex}`))].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex).slice(-MAX_LEGS);
  if (reached >= start) await s.set(CASHK.legs(w), JSON.stringify({ cursor: reached.toString(), legs }));
  return { legs, done: reached >= latest };
}

/** The forwarder's onward USDG legs in each of these txs (from the receipt; kept in KV, a mined tx never changes). */
async function onwardLegs(txs: string[], forwarder: string, s: Kv): Promise<Map<string, OnwardLeg[]>> {
  const out = new Map<string, OnwardLeg[]>();
  if (!txs.length) return out;
  const usdg = lc(deployment().usdg), dec = deployment().usdgDecimals, f = lc(forwarder);
  const hits = await s.mget(txs.map(CASHK.fwd)).catch(() => txs.map(() => null));
  await Promise.all(txs.map(async (tx, i) => {
    const hit = parse<OnwardLeg[]>(hits[i] ?? null);
    if (hit) { out.set(tx, hit); return; }
    try {
      const rc = await serverPc().getTransactionReceipt({ hash: tx as `0x${string}` });
      const legs: OnwardLeg[] = [];
      for (const l of rc.logs) {
        if (lc(l.address) !== usdg || l.topics[0] !== TRANSFER_TOPIC || l.topics.length < 3) continue;
        if (`0x${l.topics[1]!.slice(26)}` !== f) continue;
        legs.push({ to: `0x${l.topics[2]!.slice(26)}`, usd: usdgRawToUsd(BigInt(l.data), dec), logIndex: Number(l.logIndex) });
      }
      out.set(tx, legs);
      await s.set(CASHK.fwd(tx), JSON.stringify(legs)).catch(() => {});
    } catch { /* keep the forwarder leg as it is */ }
  }));
  return out;
}

/** Sold listings this wallet sold or bought. */
async function marketSides(w: string, s: Kv): Promise<MarketSide[]> {
  const [mine, bought, recent] = await Promise.all([
    s.zrange(MKT.by(w), 200, true),
    s.zrange(MKT.bought(w), 200, true),
    // sales before the per-buyer index existed: the newest sales, every item (Sale rows name their listing)
    s.zrange(MKT.sales(), 300, true),
  ]);
  const ids = new Set([...mine, ...bought]);
  for (const m of recent) { const sale = parse<{ listing?: string }>(m); if (sale?.listing) ids.add(sale.listing); }
  if (!ids.size) return [];
  const list = [...ids];
  const rows = (await s.mget(list.map(MKT.l))).map((v) => parse<Listing>(v)).filter((l): l is Listing => !!l && l.state === "sold");
  const out: MarketSide[] = [];
  for (const l of rows) {
    const side = lc(l.seller) === w ? "sold" : l.buyer && lc(l.buyer) === w ? "bought" : null;
    if (!side) continue;
    out.push({ listing: l.id, side, item: l.item, name: itemById(l.item)?.name ?? "Item", price: l.price, sellerGets: sellerCents(l.price), soldAt: l.soldAt ?? l.at, ...(l.tx ? { tx: l.tx } : {}) });
  }
  return out;
}

export async function cashHistory(walletIn: string, budgetMs = 8_000, s: Kv = kv()): Promise<{ rows: CashRow[]; done: boolean }> {
  const w = lc(walletIn);
  const d = deployment();
  const [{ legs, done }, market, tin, tout] = await Promise.all([
    legsOf(w, budgetMs, s),
    marketSides(w, s),
    s.smembers(CASHK.turboIn(w)).catch(() => [] as string[]),
    s.zrange(CASHK.turboOut(w), 200, true).catch(() => [] as string[]),
  ]);
  const fwd = d.permitForwarder && d.permitForwarder !== ZERO ? lc(d.permitForwarder) : undefined;
  const fwdTxs = fwd ? [...new Set(legs.filter((l) => lc(l.from) === w && lc(l.to) === fwd).map((l) => lc(l.tx)))].slice(-100) : [];
  const shown = throughForwarder(w, legs, fwd, fwd ? await onwardLegs(fwdTxs, fwd, s) : new Map());
  const rows = cashRows(w, shown, {
    protocol: protocolSet(),
    fees: addrSet(d.creatorFeeHarvest, d.curveFeeVault, d.feeRouter),
    rewards: addrSet(d.referralRegistry),
    turboIn: new Set(tin.map(lc)),
    turboOut: tout.map((m) => parse<{ at: number; usd: number }>(m)).filter((x): x is { at: number; usd: number } => !!x),
    market,
  });
  return { rows: rows.slice(0, 200), done };
}
