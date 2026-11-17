import "server-only";
/**
 * One pilot, several wallets (XP mismatch, maker 2026-11-17). Privy makes a separate user, with its own embedded wallet,
 * for each login method: signing in with email on desktop and Apple / Google in the iPhone app can land on two wallets
 * for the same person. XP, level, trophies and parts are keyed by wallet, so each device showed a different pilot.
 *
 * An ACCOUNT groups the wallets of one person: every wallet of one Privy user, and every Privy user that shares a
 * verified email (email OTP, Google or Apple; lib/server/privyAuth userFromLinkedAccounts). Reads (lib/server/xp
 * ledgerOf / ownedOf, lib/server/achievements unlocksOf) sum the whole account; earning stays on the wallet that
 * earned it and pays once per account. Cash and coins are NOT moved or pooled: only XP-side state is read across wallets.
 *
 * KV keys (not chain-namespaced: an account is a person, the per-chain XP keys hang off its wallets):
 *   acct:w:<wallet>   string  account id (the account's first wallet)
 *   acct:u:<did>      string  account id of a Privy user
 *   acct:e:<sha256>   string  account id of a verified email (hashed: no addresses in key names)
 *   acct:m:<id>       set     the account's wallets
 *   acct:lock:<id>    short lock while linking
 * Linked once per sign-in from the client (POST /api/xp/account), so both devices join as soon as each one opens the app.
 */
import { createHash, randomUUID } from "node:crypto";
import { kv, type Kv } from "./kv";
import type { PrivyUser } from "./privyAuth";

/** Most wallets one account reads (each one is a ledger read): plenty for email + Google + Apple + old wallet logins. */
export const ACCOUNT_MAX_WALLETS = 8;
const ADDR = /^0x[0-9a-f]{40}$/;
const emailKey = (e: string) => createHash("sha256").update(e.trim().toLowerCase()).digest("hex").slice(0, 40);
export const AK = {
  wallet: (w: string) => `acct:w:${w.toLowerCase()}`,
  user: (did: string) => `acct:u:${did}`,
  email: (e: string) => `acct:e:${emailKey(e)}`,
  members: (id: string) => `acct:m:${id.toLowerCase()}`,
  lock: (id: string) => `acct:lock:${id.toLowerCase()}`,
};

/** The account id a wallet belongs to (its own address when it was never linked). */
export async function accountIdOf(walletIn: string, s: Kv = kv()): Promise<string> {
  const w = walletIn.toLowerCase();
  return (await s.get(AK.wallet(w))) || w;
}

/** Every wallet on this wallet's account, this wallet first. A wallet that was never linked is its own account. */
export async function accountWallets(walletIn: string, s: Kv = kv()): Promise<string[]> {
  const w = walletIn.toLowerCase();
  const id = await s.get(AK.wallet(w));
  if (!id) return [w];
  const members = (await s.smembers(AK.members(id))).map((x) => x.toLowerCase()).filter((x) => ADDR.test(x) && x !== w).sort();
  return [w, ...members].slice(0, ACCOUNT_MAX_WALLETS);
}

export type LinkResult = { ok: true; account: string; wallets: string[]; joined: string[] } | { ok: false; reason: string };

/**
 * Join this Privy user's wallets (and every account that shares one of its verified emails) into one account.
 * The caller has verified the Privy session; `user` is what Privy returned for it. Idempotent: a second call writes nothing new.
 */
export async function linkAccount(user: PrivyUser, s: Kv = kv()): Promise<LinkResult> {
  const wallets = Array.from(new Set(user.wallets.map((w) => w.toLowerCase()).filter((w) => ADDR.test(w))));
  if (!wallets.length) return { ok: false, reason: "No wallet on this login yet." };
  const emails = Array.from(new Set(user.emails.map((e) => e.trim().toLowerCase()).filter(Boolean)));
  const keys = [AK.user(user.id), ...emails.map(AK.email), ...wallets.map(AK.wallet)];
  const found = await s.mget(keys);
  const ids = Array.from(new Set(found.filter((x): x is string => !!x && ADDR.test(x))));
  // the account that already exists wins (the user's own first, then by email, then by wallet); else this login's first wallet
  const id = ids[0] ?? wallets[0];
  const token = randomUUID();
  if (!(await s.setNX(AK.lock(id), token, 10))) return { ok: false, reason: "Busy, try again." };
  try {
    const members = new Set((await s.smembers(AK.members(id))).map((x) => x.toLowerCase()));
    members.add(id);
    const before = new Set(members);
    // fold in any other account this person already had (e.g. one per login method, linked before they shared an email)
    for (const other of ids.slice(1)) if (other !== id) (await s.smembers(AK.members(other))).forEach((m) => members.add(m.toLowerCase()));
    for (const w of wallets) members.add(w);
    const all = Array.from(members).filter((x) => ADDR.test(x));
    if (all.length > ACCOUNT_MAX_WALLETS) {
      console.warn("[xp account] too many wallets, not linking more", { account: id, wallets: all.length });
      return { ok: false, reason: "Too many logins on this account." };
    }
    await s.sadd(AK.members(id), ...all);
    for (const w of all) await s.set(AK.wallet(w), id);
    await s.set(AK.user(user.id), id);
    for (const e of emails) await s.set(AK.email(e), id);
    for (const other of ids.slice(1)) if (other !== id) await s.del(AK.members(other));
    const joined = all.filter((w) => !before.has(w));
    return { ok: true, account: id, wallets: all, joined };
  } finally {
    await s.delIfEq(AK.lock(id), token).catch(() => {});
  }
}
