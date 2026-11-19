import "server-only";
/**
 * Coin looks (lib/coinLook): the skin + trail a host stamped on a coin at launch, kept per coin so everyone sees it on
 * the pad and the lobby / All rockets cards. Only the coin's on-chain creator (Launchpad.creatorOf) can set it: a signed-in
 * host by their session, a hidden host by signing with the coin's stealth owner key (lib/coinLook coinLookMessage), so
 * the server never learns who's behind a hidden coin. Items must be out or owned (lib/server/collection lookCopies); a
 * public host's own copy is credited (serial), a hidden coin carries none. Set once: a coin keeps its look.
 */
import { createPublicClient, http, recoverMessageAddress, type Address, type Hex } from "viem";
import { ACTIVE_CHAIN, deployment, isDeployed } from "@/lib/chains";
import { anonLauncherAbi, launchpadAbi } from "@/lib/abi";
import { anonLaunchers } from "@/lib/anon";
import { CLASSIC, coinLookMessage, lookFromCopy, parseLook, type CoinLook } from "@/lib/coinLook";
import { lookCopies } from "./collection";
import { kv, type Kv } from "./kv";

const key = (token: string) => `coinlook:${ACTIVE_CHAIN.id}:${token.toLowerCase()}`;
const isAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a);

let pc: ReturnType<typeof createPublicClient> | null = null;
const client = () => (pc ??= createPublicClient({ chain: ACTIVE_CHAIN, transport: http() }));

/** The coin's creator on chain, lower case; null when it isn't a coin (or the chain didn't answer). Tests swap it. */
export let creatorOf = async (token: string): Promise<string | null> => {
  if (!isDeployed()) return null;
  const r = await client().readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "creatorOf", args: [token as Address] }).catch(() => null);
  const c = r ? String(r).toLowerCase() : null;
  return c && isAddr(c) && !/^0x0{40}$/.test(c) ? c : null;
};
export function setCreatorOfForTests(f: typeof creatorOf) { creatorOf = f; }

/**
 * A hidden coin's on-chain creator is the AnonLauncher, not the host: the host is the coin's one-time stealth owner
 * (AnonLauncher.stealthOwnerOf). Lower case; null for a public coin or when the chain didn't answer. Tests swap it.
 */
export let stealthOwnerOf = async (token: string, creator: string): Promise<string | null> => {
  if (!anonLaunchers(ACTIVE_CHAIN.id).some((a) => a.toLowerCase() === creator)) return null;
  const r = await client().readContract({ address: creator as Address, abi: anonLauncherAbi, functionName: "stealthOwnerOf", args: [token as Address] }).catch(() => null);
  const o = r ? String(r).toLowerCase() : null;
  return o && isAddr(o) && !/^0x0{40}$/.test(o) ? o : null;
};
export function setStealthOwnerOfForTests(f: typeof stealthOwnerOf) { stealthOwnerOf = f; }

/** Stored looks for up to 200 coins (lower case). Coins with none are left out (they fly the chrome rocket). */
export async function coinLooksOf(tokens: readonly string[], s: Kv = kv()): Promise<Record<string, CoinLook>> {
  const ts = [...new Set(tokens.map((t) => t.toLowerCase()).filter(isAddr))].slice(0, 200);
  if (!ts.length) return {};
  const raw = await s.mget(ts.map(key));
  const out: Record<string, CoinLook> = {};
  ts.forEach((t, i) => { try { const l = raw[i] ? parseLook(JSON.parse(raw[i]!)) : null; if (l) out[t] = l; } catch { /* a bad record = chrome */ } });
  return out;
}

export type SetLookResult = { ok: true; look: CoinLook } | { ok: false; reason: string; status: number };
/**
 * Stamp a look on a coin. `by` is either the signed-in account's wallets (one must be the coin's creator), or a stealth
 * owner's signature over coinLookMessage (it must recover to the coin's creator; for hidden launches).
 */
export async function setCoinLook(tokenIn: string, by: { wallets: readonly string[] } | { sig: Hex }, skin: string, trail: string, s: Kv = kv()): Promise<SetLookResult> {
  const token = tokenIn.toLowerCase();
  if (!isAddr(token)) return { ok: false, reason: "That isn't a rocket.", status: 400 };
  const creator = await creatorOf(token);
  if (!creator) return { ok: false, reason: "That rocket isn't on the chain yet. Try again in a moment.", status: 409 };
  let host: string | null = null, hidden = false;
  if ("sig" in by) {
    const a = await recoverMessageAddress({ message: coinLookMessage(token, skin, trail), signature: by.sig }).catch(() => null);
    // hidden launches: the signer is the stealth owner the AnonLauncher (the on-chain creator) recorded for this coin
    const owner = a ? await stealthOwnerOf(token, creator) : null;
    if (!a || (a.toLowerCase() !== creator && a.toLowerCase() !== owner)) return { ok: false, reason: "Only the rocket's host can paint it.", status: 403 };
    hidden = true;
  } else {
    host = by.wallets.map((x) => x.toLowerCase()).find((x) => x === creator) ?? null;
    if (!host) return { ok: false, reason: "Only the rocket's host can paint it.", status: 403 };
  }
  if (await s.get(key(token))) return { ok: false, reason: "This rocket already has its look.", status: 409 };
  const r = await lookCopies(host, skin, trail, s);
  if (!r.ok) return { ok: false, reason: r.reason, status: 409 };
  const look = lookFromCopy(skin, trail, skin === CLASSIC || hidden ? null : r.skin);
  const rec = hidden ? { ...look, at: Date.now() } : { ...look, by: host, at: Date.now(), copy: r.skin?.uid ?? null };
  if (!(await s.setNX(key(token), JSON.stringify(rec)))) return { ok: false, reason: "This rocket already has its look.", status: 409 };
  return { ok: true, look };
}
