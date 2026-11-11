import "server-only";
/**
 * Off-chain name+ticker lock store (Upstash / local KV). Mainnet only.
 *
 * Keys:
 *   namelock:key:<key>     → LockRecord JSON (SET NX on claim)
 *   namelock:token:<token> → key  (holder reverse lookup)
 *   namelock:launch:<token>→ { name, ticker, curve, block, logIndex, at }
 *   namelock:copy:<token>  → { key, launched: {block,logIndex}, at }
 *   namelock:watch         → zset of holder tokens
 *   namelock:cur:<launchpad> cursor of the Launched / GraduatedToV4 scan
 *
 * Claim is triggered by GraduatedToV4 (same event lib/server/grad and the achievements scanner already use).
 * Live mcap is readCoinMcap (marketCapQuote × launch quote price) — the site's existing source of truth,
 * not BondingCurve.marketCapUsd() (retired for display because the live pricer drifted from the chart).
 */
import { decodeEventLog, getAbiItem, type Address, type Hex, type Log, type PublicClient } from "viem";
import { bondingCurveAbi, launchpadAbi } from "@/lib/abi";
import { ACTIVE_CHAIN, deployment, ZERO } from "@/lib/chains";
import { readCoinMcap } from "@/lib/mcap";
import {
  applyMcapTick,
  claimOnAscend,
  isSlippedInCopy,
  launchBlockedByLock,
  nameLockEnforced,
  nameLockKey,
  observeLockMcap,
  type ChainPos,
  type LockRecord,
} from "@/lib/nameLock";
import { serverPc } from "./chat/identity";
import { kv, type Kv } from "./kv";

const LAUNCHED = getAbiItem({ abi: launchpadAbi, name: "Launched" });
const GRADUATED = getAbiItem({ abi: bondingCurveAbi, name: "GraduatedToV4" });
const CHUNK = BigInt(Math.max(100, Number(process.env.NAME_LOCK_CHUNK_BLOCKS) || 20_000));
const PREFIX = "namelock";

const lockKey = (k: string) => `${PREFIX}:key:${k}`;
const tokenKey = (t: string) => `${PREFIX}:token:${t.toLowerCase()}`;
const launchKey = (t: string) => `${PREFIX}:launch:${t.toLowerCase()}`;
const copyKey = (t: string) => `${PREFIX}:copy:${t.toLowerCase()}`;
const WATCH = `${PREFIX}:watch`;
const cursorKey = (lp: string) => `${PREFIX}:cur:${lp.toLowerCase()}`;

export type LaunchMeta = { name: string; ticker: string; curve: string; block: number; logIndex: number; at: number };
export type CopyRecord = { key: string; launched: ChainPos; at: number };

const parse = <T>(s: string | null): T | null => {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
};

export async function getLockByKey(key: string, s: Kv = kv()): Promise<LockRecord | null> {
  const r = parse<LockRecord>(await s.get(lockKey(key)));
  return r && typeof r.token === "string" ? { ...r, token: r.token.toLowerCase(), belowSince: r.belowSince ?? null } : null;
}

export async function checkNameTicker(
  name: string,
  ticker: string,
  chainId: number = ACTIVE_CHAIN.id,
  s: Kv = kv(),
): Promise<{ enforced: boolean; available: boolean; reason?: string; holder?: string }> {
  if (!nameLockEnforced(chainId)) return { enforced: false, available: true };
  const key = nameLockKey(name, ticker);
  const lock = await getLockByKey(key, s);
  const hit = launchBlockedByLock({ enforced: true, lock });
  return { enforced: true, available: !hit.blocked, reason: hit.reason, holder: lock?.token };
}

export async function copyStatus(
  token: string,
  chainId: number = ACTIVE_CHAIN.id,
  s: Kv = kv(),
): Promise<{ enforced: boolean; copy: boolean; holder?: string }> {
  if (!nameLockEnforced(chainId)) return { enforced: false, copy: false };
  const t = token.toLowerCase();
  const rec = parse<CopyRecord>(await s.get(copyKey(t)));
  if (!rec?.key) return { enforced: true, copy: false };
  const lock = await getLockByKey(rec.key, s);
  const copy = isSlippedInCopy({ token: t, launched: rec.launched, lock });
  return { enforced: true, copy, holder: copy ? lock?.token : undefined };
}

/** Tokens in `list` that are currently slipped-in copies (re-checked against the live lock). */
export async function flaggedCopySet(tokens: string[], s: Kv = kv()): Promise<Set<string>> {
  const out = new Set<string>();
  const list = tokens.map((t) => t.toLowerCase()).filter((t) => /^0x[0-9a-f]{40}$/.test(t));
  if (!list.length) return out;
  const raw = await s.mget(list.map(copyKey));
  const recs: { token: string; rec: CopyRecord }[] = [];
  list.forEach((t, i) => {
    const rec = parse<CopyRecord>(raw[i]);
    if (rec?.key && rec.launched) recs.push({ token: t, rec });
  });
  if (!recs.length) return out;
  const keys = Array.from(new Set(recs.map((x) => x.rec.key)));
  const locks = await s.mget(keys.map(lockKey));
  const byKey = new Map<string, LockRecord | null>();
  keys.forEach((k, i) => { byKey.set(k, parse<LockRecord>(locks[i])); });
  for (const { token, rec } of recs) {
    const lock = byKey.get(rec.key) ?? null;
    if (lock && isSlippedInCopy({ token, launched: rec.launched, lock })) out.add(token);
  }
  return out;
}

type LaunchArgs = { token: string; curve: string; name: string; ticker: string };
type GradArgs = { token: string };

async function writeLaunch(s: Kv, ev: LaunchMeta & { token: string }, dryRun: boolean) {
  if (!dryRun) await s.set(launchKey(ev.token), JSON.stringify({ name: ev.name, ticker: ev.ticker, curve: ev.curve, block: ev.block, logIndex: ev.logIndex, at: ev.at }));
}

async function tryClaim(s: Kv, ev: { token: string; name: string; ticker: string } & ChainPos & { at: number }, dryRun: boolean): Promise<"claimed" | "idempotent" | "held"> {
  const key = nameLockKey(ev.name, ev.ticker);
  const existing = await getLockByKey(key, s);
  const { lock, wrote } = claimOnAscend(existing, ev.token, ev, ev.at);
  if (!wrote) return existing && existing.token === ev.token.toLowerCase() ? "idempotent" : "held";
  if (dryRun) return "claimed";
  if (!(await s.setNX(lockKey(key), JSON.stringify(lock)))) {
    const won = await getLockByKey(key, s);
    return won && won.token === ev.token.toLowerCase() ? "idempotent" : "held";
  }
  await s.set(tokenKey(ev.token), key);
  await s.zadd(WATCH, [{ score: ev.at, member: ev.token.toLowerCase() }]);
  return "claimed";
}

async function flagCopy(s: Kv, ev: { token: string; key: string; launched: ChainPos; at: number }, dryRun: boolean) {
  if (dryRun) return;
  await s.set(copyKey(ev.token), JSON.stringify({ key: ev.key, launched: ev.launched, at: ev.at }));
}

async function release(s: Kv, token: string, key: string, dryRun: boolean) {
  if (dryRun) return;
  const held = await getLockByKey(key, s);
  if (!held || held.token !== token.toLowerCase()) return;
  await s.del(lockKey(key), tokenKey(token));
  await s.zrem(WATCH, token.toLowerCase());
}

export type NameLockTick = {
  ok: true;
  enforced: boolean;
  skipped?: string;
  dryRun: boolean;
  launches: number;
  claims: number;
  alreadyHeld: number;
  copies: number;
  watched: number;
  released: number;
  cursor?: string;
  latest?: string;
  done: boolean;
};

/**
 * One cron tick: scan new Launched / GraduatedToV4 logs, claim or flag, then tick drop-back on holders.
 * No-op on testnet. Idempotent (SET NX claim, cursor, copy records).
 */
export async function runNameLock(opts: {
  budgetMs?: number;
  dryRun?: boolean;
  chainId?: number;
  now?: number;
  s?: Kv;
  readMcap?: (token: Address) => Promise<number>;
} = {}): Promise<NameLockTick> {
  const s = opts.s ?? kv();
  const chainId = opts.chainId ?? ACTIVE_CHAIN.id;
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? Date.now();
  const out: NameLockTick = { ok: true, enforced: nameLockEnforced(chainId), dryRun, launches: 0, claims: 0, alreadyHeld: 0, copies: 0, watched: 0, released: 0, done: true };
  if (!out.enforced) return { ...out, skipped: "not_mainnet" };

  const d = deployment();
  if (d.launchpad === ZERO) return { ...out, skipped: "not_deployed" };

  const t0 = Date.now();
  const budgetMs = opts.budgetMs ?? 40_000;
  const pc = serverPc();
  const latest = await pc.getBlockNumber();
  const ck = cursorKey(d.launchpad);
  let cur = BigInt((await s.get(ck)) ?? (d.fromBlock - BigInt(1)).toString());
  let chunk = CHUNK;
  const blockTs = new Map<bigint, number>();
  const tsOf = async (bn: bigint): Promise<number> => {
    const hit = blockTs.get(bn);
    if (hit) return hit;
    const t = Number((await pc.getBlock({ blockNumber: bn })).timestamp) * 1000;
    blockTs.set(bn, t);
    return t;
  };

  while (cur < latest) {
    if (Date.now() - t0 > budgetMs) { out.done = false; break; }
    const from = cur + BigInt(1);
    const to = from + chunk - BigInt(1) > latest ? latest : from + chunk - BigInt(1);
    let launches: Log[], grads: Log[];
    try {
      [launches, grads] = await Promise.all([
        pc.getLogs({ address: d.launchpad, event: LAUNCHED, fromBlock: from, toBlock: to }) as Promise<Log[]>,
        pc.getLogs({ event: GRADUATED, fromBlock: from, toBlock: to }) as Promise<Log[]>,
      ]);
    } catch {
      if (chunk > BigInt(200)) { chunk = chunk / BigInt(4); continue; }
      throw new Error("name-lock log scan failed");
    }

    type Row =
      | { kind: "launch"; block: number; logIndex: number; log: Log }
      | { kind: "ascend"; block: number; logIndex: number; log: Log };
    const rows: Row[] = [];
    for (const l of launches) rows.push({ kind: "launch", block: Number(l.blockNumber ?? 0), logIndex: Number(l.logIndex ?? 0), log: l });
    for (const l of grads) rows.push({ kind: "ascend", block: Number(l.blockNumber ?? 0), logIndex: Number(l.logIndex ?? 0), log: l });
    rows.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

    for (const row of rows) {
      if (row.kind === "launch") {
        let a: LaunchArgs;
        try {
          a = (decodeEventLog({ abi: [LAUNCHED], data: row.log.data, topics: row.log.topics as [Hex, ...Hex[]] }) as unknown as { args: LaunchArgs }).args;
        } catch { continue; }
        const token = a.token.toLowerCase();
        const at = await tsOf(BigInt(row.block));
        const meta: LaunchMeta = { name: a.name, ticker: a.ticker, curve: a.curve.toLowerCase(), block: row.block, logIndex: row.logIndex, at };
        await writeLaunch(s, { ...meta, token }, dryRun);
        out.launches++;
        const key = nameLockKey(a.name, a.ticker);
        const lock = await getLockByKey(key, s);
        if (isSlippedInCopy({ token, launched: { block: row.block, logIndex: row.logIndex }, lock })) {
          await flagCopy(s, { token, key, launched: { block: row.block, logIndex: row.logIndex }, at }, dryRun);
          out.copies++;
        }
      } else {
        let a: GradArgs;
        try {
          a = (decodeEventLog({ abi: [GRADUATED], data: row.log.data, topics: row.log.topics as [Hex, ...Hex[]] }) as unknown as { args: GradArgs }).args;
        } catch { continue; }
        const token = a.token.toLowerCase();
        const meta = parse<LaunchMeta>(await s.get(launchKey(token)));
        if (!meta) continue;
        if (meta.curve !== row.log.address.toLowerCase()) continue; // spoofed / foreign curve
        const at = await tsOf(BigInt(row.block));
        const result = await tryClaim(s, { token, name: meta.name, ticker: meta.ticker, block: row.block, logIndex: row.logIndex, at }, dryRun);
        if (result === "claimed") out.claims++;
        else if (result === "held") out.alreadyHeld++;
      }
    }

    cur = to;
    if (!dryRun) await s.set(ck, cur.toString());
  }
  out.cursor = cur.toString();
  out.latest = latest.toString();

  // Drop-back: tick every current holder. A release needs 24h continuously below + a final mcap read still below.
  const holders = await s.zrange(WATCH, 10_000);
  const read = opts.readMcap ?? (async (token: Address) => (await readCoinMcap(pc as unknown as PublicClient, token)).mcapUsd);
  for (const token of holders) {
    if (Date.now() - t0 > budgetMs) { out.done = false; break; }
    const key = await s.get(tokenKey(token));
    if (!key) continue;
    const lock = await getLockByKey(key, s);
    if (!lock || lock.token !== token) continue;
    out.watched++;
    let seen: number;
    try { seen = await read(token as Address); }
    catch { continue; }
    const obs = observeLockMcap(lock.belowSince, seen, now);
    let next = applyMcapTick(lock, seen, now, seen);
    if (obs.mayRelease) {
      let finalMcap = seen;
      try { finalMcap = await read(token as Address); } catch { /* keep the first reading only if the re-read fails */ }
      next = applyMcapTick(lock, seen, now, finalMcap);
    }
    if (next.released) {
      await release(s, token, key, dryRun);
      out.released++;
    } else if (next.lock && next.lock.belowSince !== lock.belowSince) {
      if (!dryRun) await s.set(lockKey(key), JSON.stringify(next.lock));
    }
  }
  return out;
}
