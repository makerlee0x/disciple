import "server-only";
/**
 * Chat identity. Client signs `chatLoginMessage(addr, ts)` once per session:
 *  - EOA / Privy wallet: personal_sign by `addr` (ERC-1271/6492 also accepted via viem verifyMessage).
 *  - DISCIPLE smart account (LightAccount v2, maybe counterfactual): the account's OWNER key signs the raw
 *    keccak of the message; server checks factory.getAddress(owner, 0) === addr.
 * Server returns an HMAC-SHA256 token (CHAT_TOKEN_SECRET) valid 12h: base64url(payload).base64url(mac).
 */
import { createHmac, timingSafeEqual } from "crypto";
import { createPublicClient, http, keccak256, recoverMessageAddress, stringToBytes, type Address, type Hex } from "viem";
import { ACTIVE_CHAIN, deployment } from "@/lib/chains";
import { factoryAbi, LIGHT_ACCOUNT_V2_FACTORY } from "@/lib/aa/core";
import { launchpadAbi } from "@/lib/abi";
import { CHAT_LIMITS, type ChatBadge, type ChatFrom } from "@/lib/chat/types";
import { chatLoginMessage } from "@/lib/chat/login";
import { usernameOf as registryUsernameOf } from "../usernames";

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
let pcInst: ReturnType<typeof createPublicClient> | null = null;
export const serverPc = () => (pcInst ??= createPublicClient({ chain: ACTIVE_CHAIN, transport: http(process.env.CHAT_RPC_URL || ACTIVE_CHAIN.rpcUrls.default.http[0]) }));

function secret(): string | null {
  const s = process.env.CHAT_TOKEN_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) return "dev-only-insecure-chat-secret"; // local dev only
  return null;
}
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (s: string, p: string) => createHmac("sha256", s).update(p).digest();

export type TokenPayload = { a: string; exp: number };
export function issueToken(addr: string, now = Date.now()): { token: string; exp: number } | null {
  const s = secret(); if (!s) return null;
  const p = b64(JSON.stringify({ a: addr.toLowerCase(), exp: now + CHAT_LIMITS.tokenTtlMs } satisfies TokenPayload));
  return { token: `${p}.${b64(mac(s, p))}`, exp: now + CHAT_LIMITS.tokenTtlMs };
}
export function verifyToken(tok: string | null | undefined, now = Date.now()): TokenPayload | null {
  const s = secret(); if (!s || !tok) return null;
  const [p, m] = tok.split(".");
  if (!p || !m) return null;
  const want = mac(s, p), got = Buffer.from(m, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try { const j = JSON.parse(Buffer.from(p, "base64url").toString()) as TokenPayload; return j.exp > now && isAddr(j.a) ? j : null; } catch { return null; }
}
export const chatSecretConfigured = () => !!secret();

export async function verifyLogin(body: { addr?: string; ts?: number; sig?: string; owner?: string }): Promise<string | null> {
  const addr = String(body.addr ?? ""), ts = Number(body.ts);
  if (!isAddr(addr) || !Number.isFinite(ts) || Math.abs(Date.now() - ts) > 10 * 60_000) return null;
  return verifyWalletSignature(addr, chatLoginMessage(addr, ts), String(body.sig ?? ""), body.owner);
}

/**
 * Verify `msg` was signed for `addr`: EOA / ERC-1271 / ERC-6492 via viem verifyMessage, or a DISCIPLE LightAccount
 * (counterfactual ok) whose OWNER signed keccak(msg) raw, checked via factory.getAddress(owner, 0) === addr.
 * Returns the lowercase address or null. Shared by chat login and username claims.
 */
export async function verifyWalletSignature(addr: string, msg: string, sigIn: string, owner?: string | null): Promise<string | null> {
  const sig = sigIn as Hex;
  if (!isAddr(addr) || !/^0x[0-9a-fA-F]+$/.test(sig)) return null;
  const pc = serverPc();
  if (owner && isAddr(owner)) {
    const rec = await recoverMessageAddress({ message: { raw: keccak256(stringToBytes(msg)) }, signature: sig }).catch(() => null);
    if (!rec || rec.toLowerCase() !== owner.toLowerCase()) return null;
    const sa = await pc.readContract({ address: LIGHT_ACCOUNT_V2_FACTORY, abi: factoryAbi, functionName: "getAddress", args: [rec, BigInt(0)] }).catch(() => null);
    return sa && sa.toLowerCase() === addr.toLowerCase() ? addr.toLowerCase() : null;
  }
  const ok = await pc.verifyMessage({ address: addr as Address, message: msg, signature: sig }).catch(() => false);
  return ok ? addr.toLowerCase() : null;
}

/* ---------- display identity: username store + badge ---------- */
// Same registry as /api/profile/username (lib/server/usernames: Upstash, local file fallback). Best effort.
async function usernameOf(addr: string): Promise<string | undefined> {
  try { return (await registryUsernameOf(addr)) ?? undefined; } catch { return undefined; }
}
const creatorCache = new Map<string, { c: string | null; at: number }>();
async function creatorOf(coin: string): Promise<string | null> {
  const hit = creatorCache.get(coin); if (hit && Date.now() - hit.at < 10 * 60_000) return hit.c;
  const r = await serverPc().readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "creatorOf", args: [coin as Address] }).catch(() => null);
  const c = r ? String(r).toLowerCase() : null;
  creatorCache.set(coin, { c: c && isAddr(c) ? c : null, at: Date.now() });
  return creatorCache.get(coin)!.c;
}
const mods = () => new Set((process.env.CHAT_MODS || "").toLowerCase().split(/[\s,]+/).filter(isAddr));

export async function fromFor(addr: string, coin: string): Promise<ChatFrom> {
  const [name, creator] = await Promise.all([usernameOf(addr), creatorOf(coin)]);
  const badge: ChatBadge | undefined = mods().has(addr) ? "mod" : creator === addr ? "creator" : undefined;
  return { addr, ...(name ? { name } : {}), ...(badge ? { badge } : {}) };
}
