import "server-only";
/**
 * Push alerts store and sender (lib/push.ts rules). KV:
 *   push:subs:<w>   JSON PushSub[] (≤ 5 devices)       push:ep:<sha256(endpoint)>  wallet (the service worker's lookup)
 *   push:prefs:<w>  JSON PushPrefs                      push:inbox:<w>  zset of PushMsg (newest read by the worker)
 *   push:n:<w>:<day> daily count (cap 3)               push:once:<event>:<w>  one push per event per pilot
 */
import { createHash, randomUUID } from "crypto";
import { PUSH_DAILY_CAP, readPrefs, type PushKind, type PushMsg, type PushPrefs } from "@/lib/push";
import { kv, type Kv } from "./kv";
import { sendPush, validEndpoint, vapidKeys, type PushSub } from "./webPush";

const MAX_SUBS = 5;
const INBOX_KEEP = 20;
const K = {
  subs: (w: string) => `push:subs:${w}`, ep: (e: string) => `push:ep:${createHash("sha256").update(e).digest("hex")}`,
  prefs: (w: string) => `push:prefs:${w}`, inbox: (w: string) => `push:inbox:${w}`,
  n: (w: string, day: number) => `push:n:${w}:${day}`, once: (ev: string, w: string) => `push:once:${ev}:${w}`,
};
const parse = <T,>(v: string | null): T | null => { if (!v) return null; try { return JSON.parse(v) as T; } catch { return null; } };

export const pushConfigured = () => !!vapidKeys();
export const pushPublicKey = () => vapidKeys()?.pub ?? null;

export async function subsOf(w: string, s: Kv = kv()): Promise<PushSub[]> { return parse<PushSub[]>(await s.get(K.subs(w.toLowerCase()))) ?? []; }
export async function prefsOf(w: string, s: Kv = kv()): Promise<PushPrefs> { return readPrefs(parse(await s.get(K.prefs(w.toLowerCase())))); }
export async function setPrefs(w: string, p: unknown, s: Kv = kv()): Promise<PushPrefs> { const v = readPrefs(p); await s.set(K.prefs(w.toLowerCase()), JSON.stringify(v)); return v; }

export async function subscribe(walletIn: string, endpoint: unknown, s: Kv = kv()): Promise<boolean> {
  if (!validEndpoint(endpoint)) return false;
  const w = walletIn.toLowerCase();
  const subs = (await subsOf(w, s)).filter((x) => x.endpoint !== endpoint);
  subs.unshift({ endpoint });
  for (const old of subs.slice(MAX_SUBS)) await s.del(K.ep(old.endpoint));
  await s.set(K.subs(w), JSON.stringify(subs.slice(0, MAX_SUBS)));
  await s.set(K.ep(endpoint), w);
  return true;
}
export async function unsubscribe(walletIn: string, endpoint: string, s: Kv = kv()) {
  const w = walletIn.toLowerCase();
  await s.set(K.subs(w), JSON.stringify((await subsOf(w, s)).filter((x) => x.endpoint !== endpoint)));
  await s.del(K.ep(endpoint));
}

/** the worker's read: newest message for the wallet behind this endpoint (the endpoint is the capability) */
export async function latestFor(endpoint: string, s: Kv = kv()): Promise<PushMsg | null> {
  if (!validEndpoint(endpoint)) return null;
  const w = await s.get(K.ep(endpoint));
  if (!w) return null;
  return parse<PushMsg>((await s.zrange(K.inbox(w), 1, true))[0] ?? null);
}

export type NotifyResult = "sent" | "off" | "dupe" | "capped" | "nosub" | "unconfigured";

/** One push for one event: honours the pilot's switch, once per event, the daily cap, then every device. */
export async function notify(walletIn: string, kind: PushKind, event: string, msg: { title: string; body: string; url: string }, now = Date.now(), s: Kv = kv()): Promise<NotifyResult> {
  const keys = vapidKeys();
  if (!keys) return "unconfigured";
  const w = walletIn.toLowerCase();
  const [prefs, subs] = await Promise.all([prefsOf(w, s), subsOf(w, s)]);
  if (!prefs[kind]) return "off";
  if (!subs.length) return "nosub";
  if (!(await s.setNX(K.once(event, w), "1", 30 * 86400))) return "dupe";
  if ((await s.incrEx(K.n(w, Math.floor(now / 86_400_000)), 2 * 86400)) > PUSH_DAILY_CAP) return "capped";
  const m: PushMsg = { id: randomUUID(), kind, ...msg, ts: now };
  await s.zadd(K.inbox(w), [{ score: now, member: JSON.stringify(m) }]);
  const old = await s.zrange(K.inbox(w), 100);
  if (old.length > INBOX_KEEP) await s.zrem(K.inbox(w), ...old.slice(0, old.length - INBOX_KEEP));
  const res = await Promise.all(subs.map((x) => sendPush(x, keys)));
  const gone = subs.filter((_, i) => res[i] === "gone");
  for (const g of gone) await unsubscribe(w, g.endpoint, s);
  return "sent";
}
