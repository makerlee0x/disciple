import "server-only";
/**
 * Username registry on lib/server/kv (Upstash when configured, local file otherwise).
 * Keys: user:name:<username> → wallet (lowercase) · user:addr:<wallet> → username   (both directions, unique)
 * Uniqueness: the name key is claimed with SET NX, so two wallets racing for one name can't both win.
 * One name per wallet: claiming a new name releases the wallet's previous name.
 * NOTE: still trusts the posted address (no signature yet) — same as the old stub.
 */
import { kv } from "./kv";

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
  return { ok: true };
}
