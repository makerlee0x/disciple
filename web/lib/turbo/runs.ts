/**
 * Turbo run log (this device only, `disciple.turbo.runs.v1`). Every position is a run: it starts at the fill and ends at
 * a full cash out or an H-BOMB. The result screens read streak, best multiple today and longest run per gear from here.
 * A server board (best multiple per gear, fed by Nova fills) can replace the "today" numbers later.
 */
import type { Market, Side } from "./types";

export const TURBO_RUNS_KEY = "disciple.turbo.runs.v1";
const MAX_RUNS = 200;

export interface TurboRun {
  id: string;
  kind: "cashed" | "hbomb";
  market: Market;
  side: Side;
  leverage: number;
  /** Fuel put in at the start ($). */
  fuelUsd: number;
  /** Everything that came back to fuel over the run ($, partial banks included). 0 on an H-BOMB with nothing banked. */
  backUsd: number;
  /** backUsd / fuelUsd. */
  multiple: number;
  startedAt: number;
  endedAt: number;
  /** Highest cash-out multiple seen during the run. */
  peakMultiple?: number;
  /** Cash-out multiple samples over the run, for the result chart (max 80 points). */
  path?: number[];
}

export interface RunStore {
  all(): TurboRun[];
  add(r: TurboRun): void;
}

export function createRunStore(storage?: Storage | null): RunStore {
  let s: Storage | null = null;
  if (storage !== undefined) s = storage;
  else { try { s = typeof window !== "undefined" ? window.localStorage : null; } catch { s = null; } }
  let mem: TurboRun[] = [];
  const read = (): TurboRun[] => {
    if (!s) return mem;
    try { const raw = s.getItem(TURBO_RUNS_KEY); const j = raw ? JSON.parse(raw) : null; return Array.isArray(j?.runs) ? (j.runs as TurboRun[]) : []; } catch { return mem; }
  };
  return {
    all: read,
    add(r) {
      const runs = [...read().filter((x) => x.id !== r.id), r].slice(-MAX_RUNS);
      mem = runs;
      if (s) { try { s.setItem(TURBO_RUNS_KEY, JSON.stringify({ v: 1, runs })); } catch { /* memory only */ } }
    },
  };
}

const isGreen = (r: TurboRun) => r.multiple > 1;
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** Green runs in a row, counting back from the latest. */
export function streak(runs: TurboRun[]): number {
  let n = 0;
  for (let i = runs.length - 1; i >= 0 && isGreen(runs[i]); i--) n++;
  return n;
}

/** Best cash-out multiple today (any gear), or null. */
export function bestToday(runs: TurboRun[], now = Date.now()): number | null {
  const today = runs.filter((r) => sameDay(r.endedAt, now));
  return today.length ? Math.max(...today.map((r) => r.multiple)) : null;
}

/** Longest run (ms) at this gear, or null. */
export function longestAt(runs: TurboRun[], leverage: number): number | null {
  const at = runs.filter((r) => r.leverage === leverage);
  return at.length ? Math.max(...at.map((r) => r.endedAt - r.startedAt)) : null;
}

/** "0:41", "1:12", "12:05", "2:03:10". */
export function clock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "3.1×", "0.24×", "12×". */
export function multipleLabel(x: number): string {
  if (!Number.isFinite(x)) return "—";
  const v = x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(2).replace(/0$/, "") : x.toFixed(2);
  return `${v}×`;
}
