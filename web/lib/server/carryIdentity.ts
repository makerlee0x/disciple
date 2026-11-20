import "server-only";
/**
 * The @username and profile follow the person, not the wallet (maker 2026-11-20: after the Privy production switch the
 * pill showed 0x1d0F…387E instead of @maker). Privy gives each app (and each unlinked login method) its own embedded wallet,
 * and usernames / profile meta are keyed by wallet, so a new wallet on an existing account started nameless.
 *
 * On sign-in (POST /api/xp/account, after the wallets are joined into one account by verified email), a wallet with NO
 * username takes the name of another wallet on the same account: the name key moves here (lib/server/usernames
 * bindReserved), the old wallet goes nameless. A wallet with no profile meta copies the same wallet's meta (display name,
 * picture, bio, banner, title). A wallet that already has its own name or meta keeps it: nothing is overwritten.
 * When several old wallets hold names, the one renamed most recently wins (then the account's first).
 */
import { kv, type Kv } from "./kv";
import { accountWallets } from "./xpAccount";
import { bindReserved, usernameOf, walletOf } from "./usernames";
import { lastUsernameChangeAt, metaOf, setMeta } from "./profileMeta";
import type { ProfileMeta } from "@/lib/profileMeta";

const hasMeta = (m: ProfileMeta) => !!(m.pfp || m.bio || m.name || m.banner || m.title || m.flag);

export type CarryResult = { username: string | null; movedName: boolean; copiedMeta: boolean; from: string | null };

export async function carryIdentity(walletIn: string, s: Kv = kv()): Promise<CarryResult> {
  const w = walletIn.toLowerCase();
  const [mine, myMeta, all] = await Promise.all([usernameOf(w), metaOf(w), accountWallets(w, s)]);
  const others = all.filter((x) => x !== w);
  if (!others.length || (mine && hasMeta(myMeta))) return { username: mine, movedName: false, copiedMeta: false, from: null };

  const rows = await Promise.all(others.map(async (o) => {
    const [name, at, meta] = await Promise.all([usernameOf(o), lastUsernameChangeAt(o).catch(() => null), metaOf(o)]);
    // only a name that this wallet still really holds (both keys agree)
    const held = name && (await walletOf(name)) === o ? name : null;
    return { o, name: held, at: at ?? 0, meta };
  }));
  const named = rows.filter((r) => r.name).sort((a, b) => b.at - a.at);
  const src = named[0] ?? rows.find((r) => hasMeta(r.meta)) ?? null;
  if (!src) return { username: mine, movedName: false, copiedMeta: false, from: null };

  let username = mine, movedName = false, copiedMeta = false;
  if (!mine && src.name) { await bindReserved(src.name, w); username = src.name; movedName = true; }
  const metaSrc = hasMeta(src.meta) ? src : rows.find((r) => hasMeta(r.meta));
  if (!hasMeta(myMeta) && metaSrc) { await setMeta(w, metaSrc.meta); copiedMeta = true; }
  if (movedName || copiedMeta) console.info("[identity] carried to new wallet", { to: w, from: src.o, name: movedName, meta: copiedMeta });
  return { username, movedName, copiedMeta, from: src.o };
}
