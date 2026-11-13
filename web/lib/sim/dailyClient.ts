/**
 * Daily flight, browser side: the device id (random, never sent anywhere but /api/daily, where it is hashed into a public
 * run id), the scored run this device flew today (kept so the result opens again instead of a second scored run) and
 * the submit call. The server's replay is the verdict; the local score is only shown if the submit can't reach it.
 */
import type { PlayerInput } from "./run";
import type { DailyScore } from "./daily";
import type { LevelInfo } from "../xp";
import { privyAccessToken } from "../aa/sessionState";

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

export interface DailyVerdict { runId: string; name: string; score: DailyScore; rank: number; count: number; topPct: number; /** on the board (saved by a signed-in pilot); false: rank is where it would place */ boarded?: boolean; already: boolean; /** the day's seed (for the chart replay) */ seed: number; /** already: the input log of the run that was scored first */ inputs?: PlayerInput[] }
export interface LocalDaily { id: number; seed: number; inputs: PlayerInput[]; verdict: DailyVerdict | null }

export function savedDaily(id: number): LocalDaily | null {
  try { const s = localStorage.getItem(runKey(id)), d = s ? (JSON.parse(s) as LocalDaily) : null; return d && typeof d.seed === "number" ? d : null; } catch { return null; }
}
export function saveDaily(d: LocalDaily) { try { localStorage.setItem(runKey(d.id), JSON.stringify(d)); } catch { /* ignore */ } }

/** start today's scored run: the seed (secret until now) and the start ticket the submit needs */
export async function startDaily(id: number): Promise<{ ok: true; seed: number; ticket: string; already: boolean } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/daily/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, device: deviceId() }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || typeof j.seed !== "number") return { ok: false, error: typeof j.error === "string" ? j.error : "Couldn't reach the board." };
    return { ok: true, seed: j.seed, ticket: String(j.ticket || ""), already: !!j.already };
  } catch { return { ok: false, error: "Couldn't reach the board." }; }
}
export async function submitDaily(id: number, inputs: PlayerInput[], ticket: string): Promise<{ ok: true; verdict: DailyVerdict } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/daily", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, device: deviceId(), inputs, ticket }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: typeof j.error === "string" ? j.error : "Couldn't reach the board." };
    return { ok: true, verdict: j as DailyVerdict };
  } catch { return { ok: false, error: "Couldn't reach the board." }; }
}
/** the board's latest rank for a run this device flew (the rank moves as more pilots finish) */
export async function refreshRank(id: number, runId: string): Promise<{ rank: number; count: number; topPct: number; boarded: boolean } | null> {
  try {
    const res = await fetch(`/api/daily?id=${id}&me=${runId}`); if (!res.ok) return null;
    const j = await res.json(); return j.me ? { rank: j.me.rank, count: j.me.count ?? j.count, topPct: j.me.topPct, boarded: !!j.me.boarded } : null;
  } catch { return null; }
}

export interface FreePlayXpResult { ok: true; xp: number; already: boolean; paidToday: number; perDay: number; capped: boolean; totalXp: number; level: LevelInfo }
/** save Free play XP for the signed-in pilot (POST /api/freeplay/xp): null when signed out or the server said no */
export async function claimFreePlayXp(wallet: string | null, body: { daily: { id: number; device: string } } | { practice: { difficulty: string; seed: number; inputs: PlayerInput[] } }): Promise<FreePlayXpResult | { ok: false; reason: string } | null> {
  if (!wallet) return null;
  const token = await privyAccessToken(); if (!token) return null;
  try {
    const r = await fetch("/api/freeplay/xp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ wallet, ...body }) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) return { ok: false, reason: (j && typeof j.reason === "string" && j.reason) || "Couldn't save XP." };
    return j as FreePlayXpResult;
  } catch { return { ok: false, reason: "Couldn't save XP." }; }
}
