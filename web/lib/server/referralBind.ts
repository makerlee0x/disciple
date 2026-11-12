/**
 * Account referral bind (flow/account-referral-bind). Usual affiliate pattern (Rewardful / Impact): the first-touch
 * referral is kept in the browser (lib/referral.ts: `disciple_ref` cookie → `disciple.refv2`), then saved to the
 * account on the server when the player signs in. After that the browser no longer matters: clearing cookies or
 * signing in from another browser does not change it.
 *
 * Keys (same `referral:<chain>` namespace as lib/server/referralLedger.ts; Upstash via lib/server/kv):
 *   referral:<chain>:bind:acct:<privyDid>  SET NX, no TTL. The account's first referrer. First write wins.
 *   referral:<chain>:bind:<wallet>         SET NX, no TTL. Same referrer, copied to each of the account's wallets
 *                                          (linked wallets + their smart accounts) so the ledger can look up a
 *                                          trader address directly. Never overwritten.
 * Value: {"r":<referrer wallet>,"t":<first-touch ms>,"at":<bound ms>}. No email, IP, or other personal data.
 *
 * Username path (bindWalletReferrer): a wallet-signed username claim or change (POST /api/profile/username) saves the
 * same first touch to that wallet's `bind:<wallet>` key only (no Privy account there). Same value and rules.
 *
 * Rules: the touch must carry a referrer wallet (`a`; a username-only touch is rejected), be inside the 30-day window
 * (parseRef), and not be one of the signed-in account's own wallets (no self-referral). Nothing here is on-chain and
 * nothing here runs on the login, relay, or trade path.
 * Pure over a tiny store + injected auth (no server-only), so tests can run it with an in-memory store.
 */
import { ACTIVE_CHAIN } from "@/lib/chains";
import { REF_COOKIE, parseRef, type RefTouch } from "@/lib/referral";
import type { AuthResult, PrivyUser } from "./privyAuth";

export type BindStore = { get(k: string): Promise<string | null>; setNX(k: string, v: string, ttlSec?: number): Promise<boolean> };
export type BindRecord = { r: string; t: number; at: number };

const ns = () => `referral:${ACTIVE_CHAIN.id}`;
export const BIND = {
  account: (did: string) => `${ns()}:bind:acct:${did}`,
  wallet: (w: string) => `${ns()}:bind:${w.toLowerCase()}`,
};

const ADDR_RE = /^0x[0-9a-f]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
const MAX_WALLETS = 24;

function parseRecord(raw: string | null): BindRecord | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<BindRecord>;
    const r = typeof j.r === "string" ? j.r.toLowerCase() : "";
    return ADDR_RE.test(r) && r !== ZERO ? { r, t: Number(j.t) || 0, at: Number(j.at) || 0 } : null;
  } catch { return null; }
}

/** The referrer saved to this wallet's account, or null. This is what the payout sheet uses. */
export async function accountReferrerOf(wallet: string, store: BindStore): Promise<string | null> {
  const w = String(wallet || "").toLowerCase();
  if (!ADDR_RE.test(w) || w === ZERO) return null;
  return parseRecord(await store.get(BIND.wallet(w)))?.r ?? null;
}

export type BindResult =
  | { ok: true; referrer: string; bound: boolean }
  | { ok: false; reason: "no_wallet" | "expired" | "self" | "no_account_wallet" };

/**
 * Save the first-touch referrer to the account. Set-if-absent everywhere: an account that already has a referrer keeps
 * it (`bound: false`, the saved referrer is returned and copied to any of its wallets that do not have one yet).
 */
export async function bindAccountReferrer(
  input: { did: string; wallets: string[]; touch: unknown },
  store: BindStore,
  now = Date.now(),
): Promise<BindResult> {
  const own = Array.from(new Set(input.wallets.map((w) => String(w).toLowerCase()).filter((w) => ADDR_RE.test(w) && w !== ZERO))).slice(0, MAX_WALLETS);
  if (!own.length) return { ok: false, reason: "no_account_wallet" };
  const copyTo = async (rec: BindRecord) => {
    const v = JSON.stringify(rec);
    // never point a wallet at itself (e.g. a wallet linked later that happens to be the referrer)
    await Promise.all(own.filter((w) => w !== rec.r).map((w) => store.setNX(BIND.wallet(w), v)));
  };
  let existing = parseRecord(await store.get(BIND.account(input.did)));
  if (!existing) {
    // A wallet may already be bound by the username path (bindWalletReferrer, no Privy account). That earlier save
    // wins for the whole account, so both paths agree.
    const prior = (await Promise.all(own.map(async (w) => parseRecord(await store.get(BIND.wallet(w)))))).filter((x): x is BindRecord => !!x);
    if (prior.length) {
      const first = prior.reduce((a, b) => (b.at && b.at < a.at ? b : a));
      await store.setNX(BIND.account(input.did), JSON.stringify(first));
      existing = parseRecord(await store.get(BIND.account(input.did))) ?? first;
    }
  }
  if (existing) { await copyTo(existing); return { ok: true, referrer: existing.r, bound: false }; }

  // Same validation as the browser (lib/referral.parseRef): 30-day window, wallet or username shape.
  let touch: RefTouch | null = null;
  try { touch = parseRef(JSON.stringify(input.touch ?? null), now); } catch { touch = null; }
  if (!touch) return { ok: false, reason: input.touch && typeof input.touch === "object" && (input.touch as RefTouch).a ? "expired" : "no_wallet" };
  if (!touch.a || touch.a === ZERO) return { ok: false, reason: "no_wallet" };
  if (own.includes(touch.a)) return { ok: false, reason: "self" };

  const rec: BindRecord = { r: touch.a, t: touch.t, at: now };
  const won = await store.setNX(BIND.account(input.did), JSON.stringify(rec));
  const final = won ? rec : parseRecord(await store.get(BIND.account(input.did))) ?? rec;
  await copyTo(final);
  return { ok: true, referrer: final.r, bound: won };
}

/** Pick the first-touch for a request: the posted `ref` (the browser's currentRef(), same payload as /api/referral/bind)
 *  when it parses, else the `disciple_ref` cookie the browser sent. Both go through parseRef (30 days, shape). */
export function touchFromRequest(cookieHeader: string | null, bodyRef: unknown, now = Date.now()): RefTouch | null {
  let posted: RefTouch | null = null;
  try { posted = bodyRef && typeof bodyRef === "object" ? parseRef(JSON.stringify(bodyRef), now) : null; } catch { posted = null; }
  if (posted?.a) return posted;
  const c = (cookieHeader ?? "").split(/;\s*/).find((x) => x.startsWith(REF_COOKIE + "="));
  let fromCookie: RefTouch | null = null;
  if (c) { try { fromCookie = parseRef(decodeURIComponent(c.slice(REF_COOKIE.length + 1)), now); } catch { fromCookie = null; } }
  return fromCookie ?? posted;
}

/**
 * Username path (POST /api/profile/username, wallet-signed claim or change; no Privy session needed). Saves the
 * first-touch referrer to the signed wallet only: SET NX referral:<chain>:bind:<wallet>, same value and rules as
 * bindAccountReferrer (first write wins, never overwrites, no self-referral, no username-only or expired touch).
 * `alsoOwn`: other wallets of the signer (e.g. a smart account's owner) that also count as self.
 */
export async function bindWalletReferrer(
  input: { wallet: string; touch: unknown; alsoOwn?: (string | null | undefined)[] },
  store: BindStore,
  now = Date.now(),
): Promise<BindResult> {
  const w = String(input.wallet || "").toLowerCase();
  if (!ADDR_RE.test(w) || w === ZERO) return { ok: false, reason: "no_account_wallet" };
  const existing = parseRecord(await store.get(BIND.wallet(w)));
  if (existing) return { ok: true, referrer: existing.r, bound: false };
  let touch: RefTouch | null = null;
  try { touch = parseRef(JSON.stringify(input.touch ?? null), now); } catch { touch = null; }
  if (!touch) return { ok: false, reason: input.touch && typeof input.touch === "object" && (input.touch as RefTouch).a ? "expired" : "no_wallet" };
  if (!touch.a || touch.a === ZERO) return { ok: false, reason: "no_wallet" };
  const self = new Set([w, ...(input.alsoOwn ?? []).map((x) => String(x ?? "").toLowerCase())]);
  if (self.has(touch.a)) return { ok: false, reason: "self" };
  const rec: BindRecord = { r: touch.a, t: touch.t, at: now };
  const won = await store.setNX(BIND.wallet(w), JSON.stringify(rec));
  if (won) return { ok: true, referrer: rec.r, bound: true };
  return { ok: true, referrer: parseRecord(await store.get(BIND.wallet(w)))?.r ?? rec.r, bound: false };
}

/** Best-effort wrapper for the username route: never throws, gives up after `ms` so the claim is never held up. */
export async function bindWalletReferrerSafe(
  input: { wallet: string; touch: unknown; alsoOwn?: (string | null | undefined)[] },
  store: BindStore,
  now = Date.now(),
  ms = 1500,
): Promise<BindResult | "error" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      bindWalletReferrer(input, store, now).catch(() => "error" as const),
      new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), ms); }),
    ]);
  } catch { return "error"; } finally { if (timer) clearTimeout(timer); }
}

export type BindDeps = {
  store: BindStore;
  authenticate: (token: string | null) => Promise<AuthResult>;
  accountsOf: (user: PrivyUser) => Promise<string[]>;
  now?: () => number;
};
type Res = [number, Record<string, unknown>];

/**
 * POST /api/referral/bind body { wallet, ref: { u, a, t } }, Authorization: Bearer <Privy access token>.
 * The posted wallet must belong to the signed-in account. Idempotent; the client ignores every failure.
 */
export async function handleBind(d: BindDeps, token: string | null, body: unknown): Promise<Res> {
  const a = await d.authenticate(token);
  if (!a.ok) return [a.status, { ok: false, error: a.reason }];
  const b = (body && typeof body === "object" ? body : {}) as { wallet?: unknown; ref?: unknown };
  const wallet = String(b.wallet ?? "").toLowerCase();
  if (!ADDR_RE.test(wallet)) return [400, { ok: false, error: "bad_wallet" }];
  let wallets: string[];
  try { wallets = (await d.accountsOf(a.user)).map((w) => w.toLowerCase()); } catch { wallets = a.user.wallets.map((w) => w.toLowerCase()); }
  if (!wallets.includes(wallet)) return [403, { ok: false, error: "not_your_wallet" }];
  const r = await bindAccountReferrer({ did: a.user.id, wallets, touch: b.ref }, d.store, d.now?.() ?? Date.now());
  return r.ok ? [200, { ok: true, bound: r.bound }] : [200, { ok: false, error: r.reason }];
}
