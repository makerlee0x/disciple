import "server-only";
/**
 * Delete account (App Review 5.1.1(v): an app with sign-up must offer deletion inside the app; native plan 2026-11-14).
 * Removes what DISCIPLE stores about a pilot, for every wallet on their Privy account, then deletes the Privy user so the
 * login (email / Apple / X) is gone. The wallet itself lives on the blockchain: coins and cash in it stay there, reachable
 * only with the exported key, so Settings tells the pilot to withdraw or export first. Public trade history is on-chain
 * and stays; the feed stops showing a name for it.
 */
import { kv, type Kv } from "./kv";
import { unlink } from "./xLink";
import { subsOf, unsubscribe } from "./push";
import type { PrivyEnv } from "./privyAuth";

export type DeleteResult = { ok: true; wallets: number; privyDeleted: boolean } | { ok: false; reason: string };

async function wipeWallet(walletIn: string, s: Kv): Promise<void> {
  const w = walletIn.toLowerCase();
  const name = await s.get(`user:addr:${w}`);
  if (name) await s.delIfEq(`user:name:${name}`, w);
  await s.del(`user:addr:${w}`);
  await s.del(`user:meta:${w}`);
  await unlink(w).catch(() => {});
  for (const d of await subsOf(w, s)) await unsubscribe(w, d, s);
  for (const k of [`push:subs:${w}`, `push:prefs:${w}`, `push:inbox:${w}`]) await s.del(k);
}

/** DELETE https://api.privy.io/v1/users/{did} (Basic appId:secret). 404 = already gone. */
export async function deletePrivyUser(did: string, pe: PrivyEnv, f: typeof fetch = fetch): Promise<boolean> {
  if (!pe.appId || !pe.appSecret || !/^did:privy:[a-z0-9]{8,64}$/.test(did)) return false;
  try {
    const r = await f(`https://api.privy.io/v1/users/${did}`, {
      method: "DELETE",
      headers: { authorization: `Basic ${Buffer.from(`${pe.appId}:${pe.appSecret}`).toString("base64")}`, "privy-app-id": pe.appId },
      signal: AbortSignal.timeout(6000),
    });
    return r.ok || r.status === 404;
  } catch { return false; }
}

export async function deleteAccount(user: { id: string; wallets: string[] }, pe: PrivyEnv, s: Kv = kv(), f: typeof fetch = fetch): Promise<DeleteResult> {
  for (const w of user.wallets) await wipeWallet(w, s);
  const privyDeleted = await deletePrivyUser(user.id, pe, f);
  if (!privyDeleted) return { ok: false, reason: "Your profile was removed, but your sign-in couldn't be closed. Try again in a minute." };
  return { ok: true, wallets: user.wallets.length, privyDeleted };
}
