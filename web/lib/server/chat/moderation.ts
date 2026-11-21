import "server-only";
/**
 * Coin chat moderation (App Review 1.2: report, block, Team action).
 *   report: any signed-in player flags one message; 3 different reporters hide it for everyone until the Team decides.
 *   Team (/admin/chat, ADMIN_EMAILS): remove or restore a message, mute or unmute a sender, dismiss a report.
 * Blocking is per player and lives on the device (lib/chat/block): a blocked sender's messages never render for you.
 * Keys: chat:reports zset (score = time, member = report JSON) · chat:rep:<id>:<by> one report per player per message
 *       chat:repn:<id> reporters count · chat:mute:<addr> muted sender · chat:hidden:<coin> (lib/server/chat/hidden)
 */
import type { ChatFrom } from "@/lib/chat/types";
import { kv } from "@/lib/server/kv";
import { chatStore } from "@/lib/server/chat/store";
import { setHidden } from "@/lib/server/chat/hidden";

export const AUTO_HIDE_AT = 3;
const MONTH = 30 * 86400;
export const REPORT_REASONS = ["spam", "abuse", "scam", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export type ChatReport = { id: string; coin: string; text: string; from: ChatFrom | null; by: string; reason: ReportReason; sentAt: number; at: number };
export type ReportResult = { ok: true; hidden: boolean } | { ok: false; status: number; error: string };

const lc = (s: string) => s.toLowerCase();
export const isMuted = async (addr: string) => !!(await kv().get(`chat:mute:${lc(addr)}`).catch(() => null));

export async function reportMessage(coin: string, id: string, by: string, reason: string, now = Date.now()): Promise<ReportResult> {
  const r: ReportReason = (REPORT_REASONS as readonly string[]).includes(reason) ? (reason as ReportReason) : "other";
  const msg = (await chatStore().recent(coin, 200)).find((m) => m.id === id);
  if (!msg || msg.kind !== "user") return { ok: false, status: 404, error: "That message is gone." };
  if (msg.from && lc(msg.from.addr) === lc(by)) return { ok: false, status: 400, error: "That's your own message." };
  const k = kv();
  if (!(await k.setNX(`chat:rep:${id}:${lc(by)}`, "1", MONTH))) return { ok: true, hidden: false };   // already reported by you
  const rep: ChatReport = { id, coin, text: msg.text, from: msg.from, by: lc(by), reason: r, sentAt: msg.ts, at: now };
  await k.zadd("chat:reports", [{ score: now, member: JSON.stringify(rep) }]);
  const n = await k.incrEx(`chat:repn:${id}`, MONTH);
  const hidden = n >= AUTO_HIDE_AT;
  if (n === AUTO_HIDE_AT) await setHidden(coin, id, true);
  return { ok: true, hidden };
}

export type ReportGroup = { id: string; coin: string; text: string; from: ChatFrom | null; sentAt: number; reasons: ReportReason[]; reporters: number; lastAt: number; hidden: boolean; muted: boolean; members: string[] };

/** Reports grouped by message, newest first. */
export async function listReports(limit = 300): Promise<ReportGroup[]> {
  const k = kv();
  const raw = await k.zrange("chat:reports", limit, true);
  const by = new Map<string, ReportGroup>();
  for (const s of raw) {
    let r: ChatReport; try { r = JSON.parse(s) as ChatReport; } catch { continue; }
    const g = by.get(r.id) ?? { id: r.id, coin: r.coin, text: r.text, from: r.from, sentAt: r.sentAt, reasons: [], reporters: 0, lastAt: r.at, hidden: false, muted: false, members: [] };
    g.reporters += 1; g.members.push(s); if (!g.reasons.includes(r.reason)) g.reasons.push(r.reason); g.lastAt = Math.max(g.lastAt, r.at);
    by.set(r.id, g);
  }
  const groups = Array.from(by.values());
  const coins = Array.from(new Set(groups.map((g) => g.coin)));
  const addrs = Array.from(new Set(groups.map((g) => g.from?.addr).filter((a): a is string => !!a).map(lc)));
  const [hid, mut] = await Promise.all([
    coins.length ? k.mget(coins.map((c) => `chat:hidden:${c}`)) : Promise.resolve([]),
    addrs.length ? k.mget(addrs.map((a) => `chat:mute:${a}`)) : Promise.resolve([]),
  ]);
  const hidden = new Set<string>(); hid.forEach((v) => { try { for (const x of JSON.parse(v || "[]")) hidden.add(String(x)); } catch { /* */ } });
  const muted = new Set(addrs.filter((_, i) => !!mut[i]));
  for (const g of groups) { g.hidden = hidden.has(g.id); g.muted = !!g.from && muted.has(lc(g.from.addr)); }
  return groups.sort((a, b) => b.lastAt - a.lastAt);
}

export type ModAction = "remove" | "restore" | "mute" | "unmute" | "dismiss";
/** Team action on one reported message. `dismiss` clears its reports from the queue (the message stays as it is). */
export async function moderate(action: ModAction, id: string): Promise<{ ok: boolean; error?: string }> {
  const g = (await listReports(1000)).find((x) => x.id === id);
  if (!g) return { ok: false, error: "No report for that message." };
  const k = kv();
  if (action === "remove") await setHidden(g.coin, id, true);
  else if (action === "restore") await setHidden(g.coin, id, false);
  else if (action === "mute") { if (!g.from) return { ok: false, error: "No sender." }; await k.set(`chat:mute:${lc(g.from.addr)}`, String(Date.now())); }
  else if (action === "unmute") { if (g.from) await k.del(`chat:mute:${lc(g.from.addr)}`); }
  else if (action === "dismiss") await k.zrem("chat:reports", ...g.members);
  else return { ok: false, error: "Unknown action." };
  return { ok: true };
}
