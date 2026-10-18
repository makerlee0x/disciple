/**
 * Verified badge with human review (off-chain, Upstash KV via lib/server/kv). A badge shows ONLY for an approved rocket.
 *   creator  → POST request (Privy session; must be the on-chain creator of the rocket via a linked wallet or its
 *              MAv2 smart account), single-use nonce, X handle / website / short note (stored, NEVER fetched ⇒ no SSRF)
 *   admin    → list + approve / reject / revoke (Privy session + ADMIN_EMAILS allowlist; unset ⇒ fail closed),
 *              single-use nonce per action
 *   public   → verified map for a batch of rockets (cached)
 * Keys: verify:req:<token> (JSON record) · verify:tokens (set of requested tokens) · verify:ok:<token> ("1" when approved).
 * Pure over a tiny store + injected auth/chain (no server-only): unit-tested by scripts/test-verify-api.mts.
 */
import { consumeNonce, issueNonce, nonceValid, type NonceStore } from "./nonces";
import { hitLimit, type CounterStore } from "./limits";
import { authenticate, authenticateAdmin, type FetchLike, type PrivyEnv, type PrivyUser } from "./privyAuth";

export type VerifyStore = NonceStore & CounterStore & {
  set(k: string, v: string): Promise<void>;
  mget(ks: string[]): Promise<(string | null)[]>;
  sadd(k: string, ...m: string[]): Promise<void>;
  smembers(k: string): Promise<string[]>;
};
export type VerifyStatus = "pending" | "approved" | "rejected" | "revoked";
export type VerifyRecord = {
  token: string; creator: string; privyId: string;
  x: string | null; website: string | null; note: string;
  status: VerifyStatus; requestedAt: number; updatedAt: number;
  reviewedBy?: string; reviewedAt?: number; reason?: string;
};
export type Deps = {
  store: VerifyStore; privy: PrivyEnv; adminEmails: string | undefined; fetch?: FetchLike; now?: () => number;
  /** on-chain creatorOf(token), lowercased; null if not a rocket */
  creatorOf: (token: string) => Promise<string | null>;
  /** addresses the user controls: linked wallets + their MAv2 smart accounts (lowercased) */
  accountsOf: (user: PrivyUser) => Promise<string[]>;
};
type Res = [number, Record<string, unknown>];

export const LIMITS = {
  publicPerIp: { limit: 240, windowSec: 60 },
  requestPerIp: { limit: 30, windowSec: 60 },
  requestPerUser: { limit: 6, windowSec: 600 },
  adminPerIp: { limit: 120, windowSec: 60 },
} as const;
const NONCE_TTL = 600;
const P_REQ = "verify:nonce", P_ADMIN = "verify:admin:nonce";
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const k = { req: (t: string) => `verify:req:${t}`, ok: (t: string) => `verify:ok:${t}`, set: "verify:tokens" };

/* ---------------- input normalisation (pure) ---------------- */
export function normX(v: unknown): string | null | false {
  const s = String(v ?? "").trim().replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").replace(/^@/, "").replace(/\/.*$/, "");
  if (!s) return null;
  return /^[A-Za-z0-9_]{1,15}$/.test(s) ? s : false;
}
/** http(s) URL, no credentials, public-looking hostname; stored only (never fetched server-side). */
export function normWebsite(v: unknown): string | null | false {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (s.length > 200) return false;
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return false; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port) return false;
  const h = u.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) || /^\d+(\.\d+){3}$/.test(h) || h.endsWith(".local") || h.endsWith(".internal") || h === "localhost") return false;
  return u.toString();
}
export function normNote(v: unknown): string | false {
  const s = String(v ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim();
  return s.length > 280 ? false : s;
}

async function read(store: VerifyStore, token: string): Promise<VerifyRecord | null> {
  const [v] = await store.mget([k.req(token)]);
  if (!v) return null;
  try { return JSON.parse(v) as VerifyRecord; } catch { return null; }
}

/* ---------------- public ---------------- */
/** { verified: { <token>: true } } for approved rockets among `tokens` (max 100; non-addresses ignored, e.g. sample-*). */
export async function verifiedMap(store: VerifyStore, tokens: string[]): Promise<Record<string, true>> {
  const ts = Array.from(new Set(tokens.filter(isAddr).map((t) => t.toLowerCase()))).slice(0, 100);
  if (!ts.length) return {};
  const vs = await store.mget(ts.map(k.ok));
  const out: Record<string, true> = {};
  ts.forEach((t, i) => { if (vs[i] === "1") out[t] = true; });
  return out;
}

/* ---------------- creator ---------------- */
export async function creatorNonce(d: Deps, token: string | null, ip: string): Promise<Res> {
  const rl = await hitLimit(d.store, `verify:req:ip:${ip}`, LIMITS.requestPerIp.limit, LIMITS.requestPerIp.windowSec);
  if (!rl.ok) return [429, { error: "rate_limited", retryAfterSec: rl.retryAfterSec }];
  const a = await authenticate(token, d.privy, d.fetch, d.now?.());
  if (!a.ok) return [a.status, { error: a.reason }];
  return [200, { nonce: await issueNonce(d.store, P_REQ, a.user.id, NONCE_TTL), ttlSec: NONCE_TTL }];
}

/** The caller's own request for `rocket` (status shown on the creator dashboard). */
export async function creatorStatus(d: Deps, token: string | null, rocket: string, ip: string): Promise<Res> {
  const rl = await hitLimit(d.store, `verify:req:ip:${ip}`, LIMITS.requestPerIp.limit, LIMITS.requestPerIp.windowSec);
  if (!rl.ok) return [429, { error: "rate_limited", retryAfterSec: rl.retryAfterSec }];
  if (!isAddr(rocket)) return [400, { error: "Bad rocket address." }];
  const a = await authenticate(token, d.privy, d.fetch, d.now?.());
  if (!a.ok) return [a.status, { error: a.reason }];
  const r = await read(d.store, rocket.toLowerCase());
  if (!r || r.privyId !== a.user.id) return [200, { status: null }];
  return [200, { status: r.status, reason: r.reason ?? null, requestedAt: r.requestedAt, x: r.x, website: r.website, note: r.note }];
}

export async function submitRequest(d: Deps, token: string | null, body: Record<string, unknown>, ip: string): Promise<Res> {
  const rl = await hitLimit(d.store, `verify:req:ip:${ip}`, LIMITS.requestPerIp.limit, LIMITS.requestPerIp.windowSec);
  if (!rl.ok) return [429, { error: "rate_limited", retryAfterSec: rl.retryAfterSec }];
  const a = await authenticate(token, d.privy, d.fetch, d.now?.());
  if (!a.ok) return [a.status, { error: a.reason }];
  const ru = await hitLimit(d.store, `verify:req:user:${a.user.id}`, LIMITS.requestPerUser.limit, LIMITS.requestPerUser.windowSec);
  if (!ru.ok) return [429, { error: "rate_limited", retryAfterSec: ru.retryAfterSec }];
  const rocket = String(body.token ?? "").toLowerCase();
  if (!isAddr(rocket)) return [400, { error: "Bad rocket address." }];
  const x = normX(body.x), website = normWebsite(body.website), note = normNote(body.note);
  if (x === false) return [400, { error: "X handle looks wrong." }];
  if (website === false) return [400, { error: "Website must be a public http(s) link." }];
  if (note === false) return [400, { error: "Note is too long (280 max)." }];
  if (!x && !website) return [400, { error: "Add your X handle or website." }];
  if (!(await nonceValid(d.store, P_REQ, body.nonce, a.user.id))) return [401, { error: "Request expired. Try again." }];
  const creator = await d.creatorOf(rocket);
  if (!creator) return [404, { error: "Not a DISCIPLE rocket." }];
  const mine = new Set((await d.accountsOf(a.user)).map((s) => s.toLowerCase()));
  if (!mine.has(creator)) return [403, { error: "Only the rocket's creator can ask." }];
  // single use: consumed before writing; a parallel replay loses the GETDEL race
  if (!(await consumeNonce(d.store, P_REQ, body.nonce, a.user.id))) return [401, { error: "Request expired. Try again." }];
  const prev = await read(d.store, rocket);
  if (prev?.status === "approved") return [409, { error: "Already verified." }];
  const now = (d.now ?? Date.now)();
  const rec: VerifyRecord = { token: rocket, creator, privyId: a.user.id, x: x || null, website: website || null, note: note || "",
    status: "pending", requestedAt: prev?.requestedAt ?? now, updatedAt: now };
  await d.store.set(k.req(rocket), JSON.stringify(rec));
  await d.store.sadd(k.set, rocket);
  return [200, { ok: true, status: "pending" }];
}

/* ---------------- admin ---------------- */
async function admin(d: Deps, token: string | null, ip: string) {
  const rl = await hitLimit(d.store, `verify:admin:ip:${ip}`, LIMITS.adminPerIp.limit, LIMITS.adminPerIp.windowSec);
  if (!rl.ok) return { res: [429, { error: "rate_limited", retryAfterSec: rl.retryAfterSec }] as Res };
  const a = await authenticateAdmin(token, d.privy, d.adminEmails, d.fetch, d.now?.());
  if (!a.ok) return { res: [a.status, { error: a.reason }] as Res };
  return { user: a.user };
}

export async function adminNonce(d: Deps, token: string | null, ip: string): Promise<Res> {
  const a = await admin(d, token, ip); if (a.res) return a.res;
  return [200, { nonce: await issueNonce(d.store, P_ADMIN, a.user!.id, NONCE_TTL), ttlSec: NONCE_TTL }];
}

export async function adminList(d: Deps, token: string | null, status: string | null, ip: string): Promise<Res> {
  const a = await admin(d, token, ip); if (a.res) return a.res;
  const ts = (await d.store.smembers(k.set)).filter(isAddr).slice(0, 2000);
  const vs = ts.length ? await d.store.mget(ts.map(k.req)) : [];
  let rows = vs.map((v) => { try { return v ? (JSON.parse(v) as VerifyRecord) : null; } catch { return null; } }).filter((r): r is VerifyRecord => !!r);
  if (status && status !== "all") rows = rows.filter((r) => r.status === status);
  rows.sort((x, y) => y.updatedAt - x.updatedAt);
  // privyId is internal; admins see the creator wallet + what they submitted
  return [200, { me: a.user!.emails[0] ?? null, rows: rows.map((r) => { const o: Partial<VerifyRecord> = { ...r }; delete o.privyId; return o; }) }];
}

export async function adminAction(d: Deps, token: string | null, body: Record<string, unknown>, ip: string): Promise<Res> {
  const a = await admin(d, token, ip); if (a.res) return a.res;
  const rocket = String(body.token ?? "").toLowerCase(), action = String(body.action ?? "");
  if (!isAddr(rocket)) return [400, { error: "Bad rocket address." }];
  if (!["approve", "reject", "revoke"].includes(action)) return [400, { error: "Bad action." }];
  const reason = normNote(body.reason);
  if (reason === false) return [400, { error: "Reason is too long." }];
  if (!(await consumeNonce(d.store, P_ADMIN, body.nonce, a.user!.id))) return [401, { error: "Action expired. Reload and try again." }];
  const r = await read(d.store, rocket);
  if (!r) return [404, { error: "No request for that rocket." }];
  if (action === "revoke" && r.status !== "approved") return [409, { error: "Only approved rockets can be revoked." }];
  const now = (d.now ?? Date.now)();
  const next: VerifyRecord = { ...r, status: action === "approve" ? "approved" : action === "reject" ? "rejected" : "revoked",
    reviewedBy: a.user!.emails[0] ?? a.user!.id, reviewedAt: now, updatedAt: now, reason: reason || undefined };
  await d.store.set(k.req(rocket), JSON.stringify(next));
  if (next.status === "approved") await d.store.set(k.ok(rocket), "1");
  else await d.store.del(k.ok(rocket));
  return [200, { ok: true, status: next.status }];
}
