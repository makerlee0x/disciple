/** Pure helpers for the in-game chat overlay (unit-tested by scripts/test-gamechat.mjs). */
import type { ChatMsg } from "./adapter";
import { BOMB_PCT } from "../config";
import { bombTierIndex, impactPctOf, type ImpactInput } from "../flight/bombTier";

/** Deterministic username colour from the address (FNV-1a → hue), readable on a dark translucent column. */
export function nameColor(addr: string) {
  let h = 2166136261; const s = String(addr || "").toLowerCase();
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  const hue = (h >>> 0) % 360, light = 64 + ((h >>> 9) % 3) * 4;
  return `hsl(${hue} 85% ${light}%)`;
}
/** Chat display for bomb tiers (names/colours unchanged). WHICH tier = lib/flight/bombTier (engine rule + shared
 *  lib/config thresholds, impact-based); `min` is in bps (= BOMB_PCT × 100, same as docs/bombs.md). */
export const BOMB_TIERS = [
  { name: "ATOM", min: BOMB_PCT.ATOM * 100, color: "#ff3b6b", idx: 5 }, { name: "NUKE", min: BOMB_PCT.NUKE * 100, color: "#ff6b3b", idx: 4 },
  { name: "CRUISE", min: BOMB_PCT.CRUISE * 100, color: "#ffa04a", idx: 3 }, { name: "BUNKER", min: BOMB_PCT.BUNKER * 100, color: "#ffc46b", idx: 2 },
  { name: "GRENADE", min: BOMB_PCT.GRENADE * 100, color: "#ffd98a", idx: 1 },
] as const;
/** Chat bomb row for a sell: same tier as the in-game blast. Accepts the event meta (impactPct / prePrice+postPrice /
 *  impactBps, engine precedence) or a bare impactBps number. PUFF (<2 %) or no impact data → null (plain sell row). */
export function bombTier(x: number | ImpactInput | null | undefined) {
  const pct = typeof x === "number" ? Math.abs(x) / 100 : impactPctOf(x);
  if (pct == null) return null;
  const i = bombTierIndex(pct);
  return BOMB_TIERS.find((t) => t.idx === i) || null;
}

export type Part = { t: "text"; v: string } | { t: "emote"; code: string };
/** split ":code:" tokens (only known codes) — no HTML, rendered as React nodes */
export function parseEmotes(text: string, known: (c: string) => boolean): Part[] {
  const out: Part[] = []; const re = /:([a-z0-9_]{2,24}):/g; let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) { if (!known(m[1])) continue; if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) }); out.push({ t: "emote", code: m[1] }); last = m.index + m[0].length; }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

/** A rendered row: a chat message, or a grouped burst of small trade events. */
export type Row = { key: string; msg: ChatMsg; group?: { side: "buy" | "sell"; n: number; usd: number; t0: number; t1: number } };
export const GROUP_MS = 2500, ROW_CAP = 200;
/** Append with burst grouping: consecutive small (< GRENADE) buys/sells within GROUP_MS fold into one line. Big bombs + graduations stay standalone. */
export function appendRows(rows: Row[], incoming: ChatMsg[], cap = ROW_CAP): Row[] {
  const out = rows.slice();
  for (const m of incoming) {
    const ev = m.kind === "event" ? m.meta?.event : undefined;
    const side = ev === "buy" || ev === "sell" ? ev : null;
    const small = side && !bombTier(m.meta);
    const last = out[out.length - 1];
    if (small && last && last.msg.kind === "event" && m.ts - (last.group?.t1 ?? last.msg.ts) <= GROUP_MS) {
      const lastSide = last.group?.side ?? (last.msg.meta?.event as string);
      const lastSmall = last.group || !bombTier(last.msg.meta);
      if (lastSide === side && lastSmall) {
        const g = last.group ?? { side, n: 1, usd: last.msg.meta?.usd || 0, t0: last.msg.ts, t1: last.msg.ts };
        out[out.length - 1] = { key: last.key, msg: last.msg, group: { side, n: g.n + 1, usd: g.usd + (m.meta?.usd || 0), t0: g.t0, t1: m.ts } };
        continue;
      }
    }
    out.push({ key: m.id, msg: m });
  }
  return out.length > cap ? out.slice(out.length - cap) : out;
}
export const fmtUsd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`);
export const shortAddr = (a: string) => (a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "?");
