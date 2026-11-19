import "server-only";
/**
 * Username registry on lib/server/kv (Upstash when configured, local file otherwise).
 * Keys: user:name:<username> → wallet (lowercase) · user:addr:<wallet> → username   (both directions, unique)
 * Uniqueness: the name key is claimed with SET NX, so two wallets racing for one name can't both win.
 * One name per wallet: claiming a new name releases the wallet's previous name.
 * NOTE: still trusts the posted address (no signature yet) — same as the old stub.
 */
import { kv } from "./kv";
import { indexUsername } from "./searchIndex";

const nameKey = (u: string) => `user:name:${u}`;
const addrKey = (a: string) => `user:addr:${a.toLowerCase()}`;

export async function walletOf(username: string): Promise<string | null> { return kv().get(nameKey(username)); }
export async function usernameOf(wallet: string): Promise<string | null> { return kv().get(addrKey(wallet)); }

export async function claim(username: string, wallet: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const a = wallet.toLowerCase(), s = kv();
  const owner = await s.get(nameKey(username));
  if (owner && owner !== a) return { ok: false, reason: "Username taken." };
  if (!owner && !(await s.setNX(nameKey(username), a))) {
    if ((await s.get(nameKey(username))) !== a) return { ok: false, reason: "Username taken." };
  }
  const prev = await s.get(addrKey(a));
  if (prev && prev !== username && (await s.get(nameKey(prev))) === a) await s.del(nameKey(prev));
  await s.set(addrKey(a), username);
  await indexUsername(s, username, prev && prev !== username && (await s.get(nameKey(prev))) == null ? prev : null);
  return { ok: true };
}

/**
 * Bind a RESERVED name (lib/server/reservedNames) to its owner's current wallet: the name moves here even if another
 * wallet holds it (that wallet's name is cleared), and this wallet's previous name is released. Callers must have
 * checked ownership (Privy-verified email). Returns moved: false when this wallet already held it.
 */
export async function bindReserved(username: string, wallet: string): Promise<{ moved: boolean; from: string | null }> {
  const a = wallet.toLowerCase(), s = kv();
  const [holder, mine] = await Promise.all([s.get(nameKey(username)), s.get(addrKey(a))]);
  if (holder === a && mine === username) return { moved: false, from: null };
  if (holder && holder !== a && (await s.get(addrKey(holder))) === username) await s.del(addrKey(holder));
  if (mine && mine !== username && (await s.get(nameKey(mine))) === a) await s.del(nameKey(mine));
  await s.set(nameKey(username), a);
  await s.set(addrKey(a), username);
  await indexUsername(s, username, mine && mine !== username && (await s.get(nameKey(mine))) == null ? mine : null);
  return { moved: true, from: holder && holder !== a ? holder : null };
}
