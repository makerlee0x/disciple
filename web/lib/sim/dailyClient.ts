/**
 * Daily flight, browser side: the device id (random, never sent anywhere but /api/daily, where it is hashed into a public
 * run id), the scored run this device flew today (kept so the result opens again instead of a second scored run) and
 * the submit call. The server's replay is the verdict; the local score is only shown if the submit can't reach it.
 */
import type { PlayerInput } from "./run";
import type { DailyScore } from "./daily";

const DEVICE_KEY = "disciple.daily.device";
const runKey = (id: number) => `disciple.daily.${id}`;

export function deviceId(): string {
  try {
    const have = localStorage.getItem(DEVICE_KEY); if (have && /^[A-Za-z0-9-]{16,64}$/.test(have)) return have;
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b: number) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(DEVICE_KEY, id); return id;
  } catch { return "anon-" + Math.random().toString(36).slice(2).padEnd(16, "0"); }
}

export interface DailyVerdict { runId: string; name: string; score: DailyScore; rank: number; count: number; topPct: number; already: boolean; /** already: the input log of the run that was scored first */ inputs?: PlayerInput[] }
export interface LocalDaily { id: number; inputs: PlayerInput[]; verdict: DailyVerdict | null }

export function savedDaily(id: number): LocalDaily | null {
  try { const s = localStorage.getItem(runKey(id)); return s ? (JSON.parse(s) as LocalDaily) : null; } catch { return null; }
}
export function saveDaily(d: LocalDaily) { try { localStorage.setItem(runKey(d.id), JSON.stringify(d)); } catch { /* ignore */ } }

export async function submitDaily(id: number, inputs: PlayerInput[]): Promise<{ ok: true; verdict: DailyVerdict } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/daily", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, device: deviceId(), inputs }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: typeof j.error === "string" ? j.error : "Couldn't reach the board." };
    return { ok: true, verdict: j as DailyVerdict };
  } catch { return { ok: false, error: "Couldn't reach the board." }; }
}
/** the board's latest rank for a run this device flew (the rank moves as more pilots finish) */
export async function refreshRank(id: number, runId: string): Promise<{ rank: number; count: number; topPct: number } | null> {
  try {
    const res = await fetch(`/api/daily?id=${id}&me=${runId}`); if (!res.ok) return null;
    const j = await res.json(); return j.me ? { rank: j.me.rank, count: j.count, topPct: j.me.topPct } : null;
  } catch { return null; }
}
