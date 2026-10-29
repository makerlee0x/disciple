/**
 * Invite-only beta (off-chain, Upstash KV via lib/server/kv). Plan: disciple-notes/invite-only-plan.md.
 *  - Single-use codes: 8 chars from A–Z + 2–9 without 0/O/1/I. A code is claimed with SET NX on invite:used:<CODE>,
 *    so two people can never both use one code.
 *  - A player is "in" when invite:user:<privyId> exists. Each player gets PER_PLAYER (3) codes, minted on first look;
 *    the admin can top up. Admin codes have no limit.
 *  - Wallet routes (bundler, paymaster, drip, chat, username) only see an address, so each in-player's linked wallets
 *    and their smart accounts are recorded as invite:wallet:<addr> → privyId (refreshed every status call).
 *  - One switch: invite:mode ("on" | "off") in KV, else the INVITE_ONLY env, else OFF. Off ⇒ every gate lets
 *    everyone through and nothing changes.
 * This gates our site and servers only. The contracts stay permissionless (own wallet + own bundler still works).
 * Pure over a tiny store + injected auth (no server-only): unit-tested by scripts/test-invites.mts.
 */
import { randomBytes } from "crypto";
import { consumeNonce, issueNonce, type NonceStore } from "./nonces";
import { hitLimit, type CounterStore } from "./limits";
import { authenticate, authenticateAdmin, isAdminUser, parseAdminEmails, type FetchLike, type PrivyEnv, type PrivyUser } from "./privyAuth";

export type InviteStore = NonceStore & CounterStore & {
  set(k: string, v: string): Promise<void>;
  mget(ks: string[]): Promise<(string | null)[]>;
  sadd(k: string, ...m: string[]): Promise<void>;
  smembers(k: string): Promise<string[]>;
  zadd(k: string, items: { score: number; member: string }[]): Promise<void>;
  zrange(k: string, limit?: number, rev?: boolean): Promise<string[]>;
  zrem(k: string, ...members: string[]): Promise<number>;
};
export type CodeRecord = { by: string; createdAt: number; usedBy?: string; usedAt?: number; revoked?: boolean };
export type UserRecord = { code: string; at: number; left: number };
export type Deps = {
  store: InviteStore; privy: PrivyEnv; adminEmails: string | undefined; envMode: string | undefined;
  fetch?: FetchLike; now?: () => number;
  /** linked wallets + the smart accounts they own (lowercased) */
  accountsOf: (user: PrivyUser) => Promise<string[]>;
};
type Res = [number, Record<string, unknown>];

export const PER_PLAYER = 3;
export const CODE_LEN = 8;
/** A–Z and 2–9, without 0/O and 1/I: 32 symbols, so one random byte & 31 is unbiased. */
export const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LEN}}$`);
export const LIMITS = {
  statusPerIp: { limit: 120, windowSec: 60 },
  redeemPerIp: { limit: 20, windowSec: 600 },
  redeemPerUser: { limit: 10, windowSec: 600 },
  adminPerIp: { limit: 120, windowSec: 60 },
} as const;
export const ADMIN_MAX_CREATE = 50;
export const ADMIN_MAX_TOPUP = 20;
const NONCE_TTL = 600, LOCK_TTL = 10, P_ADMIN = "invite:admin:nonce";
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const DID_RE = /^did:privy:[a-z0-9]{8,64}$/;

export const K = {
  code: (c: string) => `invite:code:${c}`,
  used: (c: string) => `invite:used:${c}`,
  user: (id: string) => `invite:user:${id}`,
  by: (id: string) => `invite:by:${id}`,
  wallet: (a: string) => `invite:wallet:${a.toLowerCase()}`,
  wl: (id: string) => `invite:wl:${id}`,
  lock: (id: string) => `invite:lock:${id}`,
  mint: (id: string) => `invite:mint:${id}`,
  waitlist: "invite:waitlist",
  log: "invite:log",
  mode: "invite:mode",
  adminCodes: "invite:by:admin",
};

/* ---------------- codes (pure) ---------------- */
export function newCode(rand: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  const b = rand(CODE_LEN);
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[b[i] & 31];
  return s;
}
/** User input → canonical code, or null. Case, spaces and dashes are ignored. */
export function normCode(v: unknown): string | null {
  const s = String(v ?? "").toUpperCase().replace(/[\s-]/g, "");
  return CODE_RE.test(s) ? s : null;
}

/* ---------------- mode ---------------- */
/** INVITE_ONLY env → true / false; anything else (unset, typo) ⇒ false (safe default: invite-only stays OFF). */
export function parseInviteEnv(v: string | undefined): boolean {
  return /^(1|true|on|yes)$/i.test(String(v ?? "").trim());
}
export type Mode = { on: boolean; source: "kv" | "env" | "default" };
export async function readMode(store: Pick<InviteStore, "get">, envMode: string | undefined): Promise<Mode> {
  const v = await store.get(K.mode).catch(() => null);
  if (v === "on" || v === "off") return { on: v === "on", source: "kv" };
  const envSet = String(envMode ?? "").trim() !== "";
  return { on: envSet && parseInviteEnv(envMode), source: envSet ? "env" : "default" };
}

/* ---------------- records ---------------- */
async function getJson<T>(store: InviteStore, k: string): Promise<T | null> {
  const v = await store.get(k);
  if (!v) return null;
  try { return JSON.parse(v) as T; } catch { return null; }
}
export const userRecord = (store: InviteStore, id: string) => getJson<UserRecord>(store, K.user(id));
export const codeRecord = (store: InviteStore, code: string) => getJson<CodeRecord>(store, K.code(code));
export const isInvited = async (store: InviteStore, id: string) => !!(await store.get(K.user(id)));
export const walletInvited = async (store: InviteStore, addr: string) => isAddr(addr) && !!(await store.get(K.wallet(addr)));

async function log(store: InviteStore, now: number, entry: Record<string, unknown>) {
  await store.zadd(K.log, [{ score: now, member: JSON.stringify({ t: now, r: randomBytes(3).toString("hex"), ...entry }) }]).catch(() => undefined);
}
/** Store one new unused code made by `by` (retries on the rare collision). */
async function createCode(store: InviteStore, by: string, now: number): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const c = newCode();
    if (await store.setNX(K.code(c), JSON.stringify({ by, createdAt: now } satisfies CodeRecord))) return c;
  }
  throw new Error("could not make a unique code");
}
export async function linkWallets(store: InviteStore, id: string, accounts: string[]) {
  for (const a of Array.from(new Set(accounts.filter(isAddr).map((x) => x.toLowerCase()))).slice(0, 30)) await store.set(K.wallet(a), id);
}
async function removeFromWaitlist(store: InviteStore, id: string) {
  const rows = await store.zrange(K.waitlist, 5000);
  const mine = rows.filter((m) => { try { return (JSON.parse(m) as { privyId?: string }).privyId === id; } catch { return false; } });
  if (mine.length) await store.zrem(K.waitlist, ...mine);
  await store.del(K.wl(id));
}

/** Let `id` in (no-op if already in). `code` is the code they used, or "admin". */
export async function admit(store: InviteStore, id: string, code: string, now: number, left = PER_PLAYER): Promise<boolean> {
  if (!(await store.setNX(K.user(id), JSON.stringify({ code, at: now, left } satisfies UserRecord)))) return false;
  await removeFromWaitlist(store, id);
  return true;
}

/**
 * Turn a player's remaining allowance into codes (left → 0). A short per-player lock means two parallel calls can't
 * both mint, so a player never gets more than their allowance.
 */
export async function mintCodes(store: InviteStore, id: string, now: number): Promise<string[]> {
  const u = await userRecord(store, id);
  if (!u || u.left <= 0) return [];
  if (!(await store.setNX(K.mint(id), "1", LOCK_TTL))) return [];
  try {
    const fresh = await userRecord(store, id);   // re-read under the lock
    if (!fresh || fresh.left <= 0) return [];
    const out: string[] = [];
    for (let i = 0; i < fresh.left; i++) out.push(await createCode(store, id, now));
    await store.sadd(K.by(id), ...out);
    await store.set(K.user(id), JSON.stringify({ ...fresh, left: 0 }));
    return out;
  } finally { await store.del(K.mint(id)); }
}

export type MyCode = { code: string; used: boolean };
export async function myCodes(store: InviteStore, id: string): Promise<MyCode[]> {
  const cs = (await store.smembers(K.by(id))).filter((c) => CODE_RE.test(c)).sort();
  if (!cs.length) return [];
  const recs = await store.mget(cs.map(K.code));
  return cs.map((code, i) => {
    let r: CodeRecord | null = null;
    try { r = recs[i] ? (JSON.parse(recs[i]!) as CodeRecord) : null; } catch { /* bad row */ }
    return { code, used: !!r?.usedBy || !!r?.revoked };
  });
}

export type RedeemResult = { ok: true } | { ok: false; error: "bad_code" | "used" | "own_code" | "already_in" | "busy" };
/** Use `code` for player `id`. Single use (SET NX on invite:used), one redemption at a time per player. */
export async function redeemCode(store: InviteStore, id: string, rawCode: unknown, now: number, accounts: string[] = []): Promise<RedeemResult> {
  const code = normCode(rawCode);
  if (!code) return { ok: false, error: "bad_code" };
  if (!(await store.setNX(K.lock(id), "1", LOCK_TTL))) return { ok: false, error: "busy" };
  try {
    if (await isInvited(store, id)) return { ok: false, error: "already_in" };
    const rec = await codeRecord(store, code);
    if (!rec || rec.revoked) return { ok: false, error: "bad_code" };
    if (rec.by === id) return { ok: false, error: "own_code" };
    if (rec.usedBy || !(await store.setNX(K.used(code), id))) return { ok: false, error: "used" };
    await store.set(K.code(code), JSON.stringify({ ...rec, usedBy: id, usedAt: now } satisfies CodeRecord));
    await admit(store, id, code, now);
    await linkWallets(store, id, accounts);
    await log(store, now, { a: "redeem", code, who: id, from: rec.by });
    return { ok: true };
  } finally { await store.del(K.lock(id)); }
}

/* ---------------- gates (used by the API routes) ---------------- */
export type Gate = { ok: true } | { ok: false; reason: "invite_required" };
export async function gateUser(store: InviteStore, mode: Mode, id: string): Promise<Gate> {
  if (!mode.on) return { ok: true };
  return (await isInvited(store, id)) ? { ok: true } : { ok: false, reason: "invite_required" };
}
export async function gateWallet(store: InviteStore, mode: Mode, addr: string): Promise<Gate> {
  if (!mode.on) return { ok: true };
  return (await walletInvited(store, addr)) ? { ok: true } : { ok: false, reason: "invite_required" };
}

/* ---------------- player API ---------------- */
async function player(d: Deps, token: string | null, ip: string, lim: { limit: number; windowSec: number }, key: string) {
  const rl = await hitLimit(d.store, `invite:${key}:ip:${ip}`, lim.limit, lim.windowSec);
  if (!rl.ok) return { res: [429, { error: "rate_limited", retryAfterSec: rl.retryAfterSec }] as Res };
  const a = await authenticate(token, d.privy, d.fetch, d.now?.());
  if (!a.ok) return { res: [a.status, { error: a.reason }] as Res };
  return { user: a.user };
}

/** GET /api/invites: the switch, whether I'm in, and my codes (minted on first look). Admins are let in automatically.
 *  Off ⇒ just { mode: false }. */
export async function playerStatus(d: Deps, token: string | null, ip: string): Promise<Res> {
  const mode = await readMode(d.store, d.envMode);
  // switch off ⇒ nothing to show and no Privy round trip (this runs on page loads)
  if (!mode.on) return [200, { mode: false }];
  const p = await player(d, token, ip, LIMITS.statusPerIp, "status");
  if (p.res) return p.res[0] === 401 ? [200, { mode: mode.on, signedIn: false }] : p.res;
  const u = p.user!, now = (d.now ?? Date.now)();
  const admin = isAdminUser(u, parseAdminEmails(d.adminEmails));
  if (admin && !(await isInvited(d.store, u.id))) await admit(d.store, u.id, "admin", now);
  const inNow = await isInvited(d.store, u.id);
  if (inNow) {
    await linkWallets(d.store, u.id, await d.accountsOf(u).catch(() => u.wallets));
    await mintCodes(d.store, u.id, now);
  }
  const codes = inNow ? await myCodes(d.store, u.id) : [];
  return [200, {
    mode: mode.on, signedIn: true, in: inNow, admin,
    waitlisted: !inNow && !!(await d.store.get(K.wl(u.id))),
    left: codes.filter((c) => !c.used).length, codes,
  }];
}

/** POST /api/invites { action: "redeem", code } | { action: "waitlist" } */
export async function playerAction(d: Deps, token: string | null, body: Record<string, unknown>, ip: string): Promise<Res> {
  const p = await player(d, token, ip, LIMITS.redeemPerIp, "redeem");
  if (p.res) return p.res;
  const u = p.user!, now = (d.now ?? Date.now)();
  if (body.action === "waitlist") {
    if (await isInvited(d.store, u.id)) return [200, { ok: true, in: true }];
    if (await d.store.setNX(K.wl(u.id), String(now))) {
      await d.store.zadd(K.waitlist, [{ score: now, member: JSON.stringify({ privyId: u.id, at: now }) }]);
      await log(d.store, now, { a: "waitlist", who: u.id });
    }
    return [200, { ok: true, waitlisted: true }];
  }
  if (body.action !== "redeem") return [400, { error: "bad_action" }];
  const ru = await hitLimit(d.store, `invite:redeem:user:${u.id}`, LIMITS.redeemPerUser.limit, LIMITS.redeemPerUser.windowSec);
  if (!ru.ok) return [429, { error: "rate_limited", retryAfterSec: ru.retryAfterSec }];
  const r = await redeemCode(d.store, u.id, body.code, now, await d.accountsOf(u).catch(() => u.wallets));
  if (r.ok) return [200, { ok: true, in: true }];
  const status = r.error === "busy" ? 429 : r.error === "already_in" || r.error === "used" ? 409 : 400;
  return [status, { ok: false, error: r.error }];
}

/* ---------------- admin API ---------------- */
async function adminAuth(d: Deps, token: string | null, ip: string) {
  const rl = await hitLimit(d.store, `invite:admin:ip:${ip}`, LIMITS.adminPerIp.limit, LIMITS.adminPerIp.windowSec);
  if (!rl.ok) return { res: [429, { error: "rate_limited", retryAfterSec: rl.retryAfterSec }] as Res };
  const a = await authenticateAdmin(token, d.privy, d.adminEmails, d.fetch, d.now?.());
  if (!a.ok) return { res: [a.status, { error: a.reason }] as Res };
  return { user: a.user };
}
export async function adminNonce(d: Deps, token: string | null, ip: string): Promise<Res> {
  const a = await adminAuth(d, token, ip); if (a.res) return a.res;
  return [200, { nonce: await issueNonce(d.store, P_ADMIN, a.user!.id, NONCE_TTL), ttlSec: NONCE_TTL }];
}

const parseRows = <T,>(rows: string[]) => rows.map((m) => { try { return JSON.parse(m) as T; } catch { return null; } }).filter((x): x is T => !!x);
export async function adminList(d: Deps, token: string | null, ip: string): Promise<Res> {
  const a = await adminAuth(d, token, ip); if (a.res) return a.res;
  const mode = await readMode(d.store, d.envMode);
  const cs = (await d.store.smembers(K.adminCodes)).filter((c) => CODE_RE.test(c)).slice(0, 2000);
  const recs = cs.length ? await d.store.mget(cs.map(K.code)) : [];
  const codes = cs.map((code, i) => { try { return { code, ...(JSON.parse(recs[i] ?? "null") as CodeRecord) }; } catch { return null; } })
    .filter((x): x is CodeRecord & { code: string } => !!x && !!x.createdAt).sort((x, y) => y.createdAt - x.createdAt);
  return [200, {
    me: a.user!.emails[0] ?? null,
    mode: mode.on, modeSource: mode.source, envDefault: parseInviteEnv(d.envMode),
    codes,
    waitlist: parseRows<{ privyId: string; at: number }>(await d.store.zrange(K.waitlist, 500)),
    log: parseRows<Record<string, unknown>>(await d.store.zrange(K.log, 100, true)),
  }];
}

/** POST { nonce, action: create{n} | admit{privyId} | topup{privyId, n} | revoke{code} | mode{mode: on|off|default} } */
export async function adminAction(d: Deps, token: string | null, body: Record<string, unknown>, ip: string): Promise<Res> {
  const a = await adminAuth(d, token, ip); if (a.res) return a.res;
  const action = String(body.action ?? "");
  if (!["create", "admit", "topup", "revoke", "mode"].includes(action)) return [400, { error: "Bad action." }];
  if (!(await consumeNonce(d.store, P_ADMIN, body.nonce, a.user!.id))) return [401, { error: "Action expired. Reload and try again." }];
  const now = (d.now ?? Date.now)(), by = a.user!.emails[0] ?? a.user!.id, n = Math.floor(Number(body.n));
  const pid = String(body.privyId ?? "").trim();
  switch (action) {
    case "create": {
      if (!(n >= 1 && n <= ADMIN_MAX_CREATE)) return [400, { error: `Make 1 to ${ADMIN_MAX_CREATE} codes at a time.` }];
      const out: string[] = [];
      for (let i = 0; i < n; i++) out.push(await createCode(d.store, `admin:${by}`, now));
      await d.store.sadd(K.adminCodes, ...out);
      await log(d.store, now, { a: "create", n, by });
      return [200, { ok: true, codes: out }];
    }
    case "admit": {
      if (!DID_RE.test(pid)) return [400, { error: "Bad player id." }];
      const ok = await admit(d.store, pid, "admin", now);
      await log(d.store, now, { a: "admit", who: pid, by });
      return [200, { ok: true, already: !ok }];
    }
    case "topup": {
      if (!DID_RE.test(pid)) return [400, { error: "Bad player id." }];
      if (!(n >= 1 && n <= ADMIN_MAX_TOPUP)) return [400, { error: `Add 1 to ${ADMIN_MAX_TOPUP} invites at a time.` }];
      const u = await userRecord(d.store, pid);
      if (!u) return [404, { error: "That player isn't in yet." }];
      await d.store.set(K.user(pid), JSON.stringify({ ...u, left: u.left + n }));
      await log(d.store, now, { a: "topup", who: pid, n, by });
      return [200, { ok: true }];
    }
    case "revoke": {
      const code = normCode(body.code);
      const rec = code ? await codeRecord(d.store, code) : null;
      if (!code || !rec) return [404, { error: "No such code." }];
      if (rec.usedBy || !(await d.store.setNX(K.used(code), "revoked"))) return [409, { error: "That code was already used." }];
      await d.store.set(K.code(code), JSON.stringify({ ...rec, revoked: true }));
      await log(d.store, now, { a: "revoke", code, by });
      return [200, { ok: true }];
    }
    default: {
      const m = String(body.mode ?? "");
      if (m === "on" || m === "off") await d.store.set(K.mode, m);
      else if (m === "default") await d.store.del(K.mode);
      else return [400, { error: "Mode must be on, off or default." }];
      await log(d.store, now, { a: "mode", mode: m, by });
      return [200, { ok: true, mode: (await readMode(d.store, d.envMode)).on }];
    }
  }
}
