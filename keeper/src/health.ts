// What the keeper knows about its own health, kept in memory and written to a small JSON file after every round.
// `node src/main.ts --health` (or `carry-keeper-health` on the server) reads that file: it needs no keys and no RPC,
// and exits 1 when the keeper looks unhealthy, so a cron job or a person can check it the same way.
import { renameSync, writeFileSync, readFileSync } from "node:fs";
import { formatEther } from "viem";

export type TxKind = "sample" | "sample-unpaid" | "sweep" | "match" | "settle" | "push" | "commit" | "deliver" | "collect";

export interface TxRecord {
  at: number;
  kind: TxKind;
  ok: boolean;
  gasWei: string;
}

export interface HealthFile {
  pid: number;
  wallet: string;
  startedAt: number;
  /** last round that finished, worked or not, and the last one that worked */
  lastRoundAt: number;
  lastOkAt: number;
  lastError: string;
  failuresInARow: number;
  multicall: Record<string, boolean>;
  chains: Record<string, { head: number; headAt: number; balanceEth: string; inFlight: number }>;
  /** pool id -> gap to its leader in bps, when it was read, and since when it has been off the leader */
  pools: Record<string, { entry: string; gapBps: number; at: number; offSince: number }>;
  /** last 24 h of transactions, by kind */
  day: Record<string, { sent: number; reverted: number; gasEth: string }>;
  stuck: number;
  lastStuckAt: number;
}

const now = () => Math.floor(Date.now() / 1000);

export class Health {
  wallet = "";
  startedAt = now();
  lastRoundAt = 0;
  lastOkAt = 0;
  lastError = "";
  failuresInARow = 0;
  stuck = 0;
  lastStuckAt = 0;
  multicall: Record<string, boolean> = {};
  chains: HealthFile["chains"] = {};
  pools: HealthFile["pools"] = {};
  txs: TxRecord[] = [];

  chain(name: string) {
    return (this.chains[name] ??= { head: 0, headAt: 0, balanceEth: "?", inFlight: 0 });
  }

  tx(kind: TxKind, ok: boolean, gasWei: bigint): void {
    const t = now();
    this.txs.push({ at: t, kind, ok, gasWei: gasWei.toString() });
    this.txs = this.txs.filter((x) => x.at > t - 86_400);
  }

  round(ok: boolean, err = ""): void {
    const t = now();
    this.lastRoundAt = t;
    if (ok) {
      this.lastOkAt = t;
      this.failuresInARow = 0;
    } else {
      this.failuresInARow++;
      this.lastError = err.slice(0, 300);
    }
  }

  /** Records a pool's gap to its leader; returns how long (s) it has been at least `offBps` off (0 = it is not). */
  gap(id: string, entry: string, gapBps: number, offBps: number): number {
    const t = now();
    const prev = this.pools[id];
    const off = gapBps >= offBps;
    const offSince = off ? (prev && prev.offSince > 0 ? prev.offSince : t) : 0;
    this.pools[id] = { entry, gapBps: Math.round(gapBps * 10) / 10, at: t, offSince };
    return off ? t - offSince : 0;
  }

  day(): HealthFile["day"] {
    const out: HealthFile["day"] = {};
    const wei: Record<string, bigint> = {};
    for (const x of this.txs) {
      const d = (out[x.kind] ??= { sent: 0, reverted: 0, gasEth: "0" });
      d.sent++;
      if (!x.ok) d.reverted++;
      wei[x.kind] = (wei[x.kind] ?? 0n) + BigInt(x.gasWei);
    }
    for (const k of Object.keys(out)) out[k].gasEth = formatEther(wei[k]);
    return out;
  }

  snapshot(): HealthFile {
    return {
      pid: process.pid,
      wallet: this.wallet,
      startedAt: this.startedAt,
      lastRoundAt: this.lastRoundAt,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      failuresInARow: this.failuresInARow,
      multicall: this.multicall,
      chains: this.chains,
      pools: this.pools,
      day: this.day(),
      stuck: this.stuck,
      lastStuckAt: this.lastStuckAt,
    };
  }

  /** Written to a temp file and renamed, so a reader never sees half a file. Never throws. */
  write(file: string): void {
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(this.snapshot(), null, 2));
      renameSync(`${file}.tmp`, file);
    } catch {
      /* the health file must never stop the keeper */
    }
  }

  /** One message for the daily summary alert. */
  summary(): string {
    const d = this.day();
    const kinds = Object.entries(d).map(([k, v]) => `${v.sent} ${k}${v.reverted ? ` (${v.reverted} reverted)` : ""}`);
    const gas = Object.values(d).reduce((a, v) => a + Number(v.gasEth), 0);
    const bal = Object.entries(this.chains).map(([n, c]) => `${c.balanceEth} ETH on ${n}`);
    const gaps = Object.entries(this.pools).map(([id, p]) => `${id.slice(0, 10)} ${p.gapBps} bps off its leader`);
    return [
      `last 24h: ${kinds.length ? kinds.join(", ") : "no transactions"}, gas ${gas.toFixed(6)} ETH`,
      `wallet ${bal.join(", ") || "?"}`,
      gaps.length ? `pools: ${gaps.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
}

/** Reads the health file and says whether the keeper is healthy. Pure apart from the file read, for tests. */
export function judgeHealth(h: HealthFile, t: number, o: { stallSec: number; staleHeadSec: number; minEth: string; offLeaderSec: number }): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const quiet = t - Math.max(h.lastOkAt, h.startedAt);
  if (quiet > Math.max(120, o.stallSec / 3)) problems.push(`no good round for ${quiet}s (last error: ${h.lastError || "none"})`);
  for (const [n, c] of Object.entries(h.chains)) {
    if (c.headAt > 0 && h.lastRoundAt - c.headAt > o.staleHeadSec) problems.push(`${n}: RPC head is ${h.lastRoundAt - c.headAt}s old`);
    if (c.balanceEth !== "?" && Number(c.balanceEth) < Number(o.minEth)) problems.push(`${n}: wallet has ${c.balanceEth} ETH, below ${o.minEth}`);
  }
  for (const [id, p] of Object.entries(h.pools)) {
    if (p.offSince > 0 && t - p.offSince >= o.offLeaderSec) problems.push(`pool ${id.slice(0, 10)} ${p.gapBps} bps off its leader for ${t - p.offSince}s`);
  }
  if (h.lastStuckAt > t - 3600) problems.push(`a transaction got stuck ${t - h.lastStuckAt}s ago (${h.stuck} since start)`);
  return { ok: problems.length === 0, problems };
}

export function readHealth(file: string): HealthFile {
  return JSON.parse(readFileSync(file, "utf8")) as HealthFile;
}
