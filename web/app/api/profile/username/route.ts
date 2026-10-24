export const runtime = "nodejs";
/**
 * Username registry (Upstash via lib/server/usernames; local file fallback without KV env).
 * GET  ?u=name            → { available, reason? }
 * GET  ?address=0x…       → { username | null, nextAllowedAt | null }   (nextAllowedAt: ms epoch of the next allowed rename)
 * GET  ?resolve=name      → { address | null }        (reverse lookup username → wallet)
 * GET  ?nonce=1&address=0x… → { nonce, ttlSec }   (fresh random nonce per request, bound to address, 10 min;
 *                              never deletes/overwrites another nonce; consumed only by a successful claim)
 * POST { username, address, nonce, signature, owner? } → { ok, reason? }
 *   signature = wallet signMessage(claimMessage(...)) — EOA/1271/6492, or a DISCIPLE smart account's owner signing
 *   keccak(message) raw (pass `owner`). Verified with lib/server/chat/identity.verifyWalletSignature.
 *   One rename per 24h (lib/usernameCooldown): too soon → 429 { ok: false, reason, nextAllowedAt }. The timestamp
 *   (lastUsernameChangeAt) lives in KV with the wallet's profile meta (lib/server/profileMeta).
 */
import { NextResponse } from "next/server";
import { USERNAME_RE, validateUsername } from "@/lib/profile";
import { claim, usernameOf, walletOf } from "@/lib/server/usernames";
import { kv } from "@/lib/server/kv";
import { consumeNonce, issueNonce, nonceValid } from "@/lib/server/nonces";
import { verifyWalletSignature } from "@/lib/server/chat/identity";
import { claimMessage } from "@/lib/usernameClaim";
import { lastUsernameChangeAt, markUsernameChange } from "@/lib/server/profileMeta";
import { nextUsernameChangeAt, usernameChange } from "@/lib/usernameCooldown";
import { PROFILE_COPY } from "@/lib/copy/profile";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";
import { INVITE_REQUIRED_MESSAGE, requireInviteWallet } from "@/lib/server/inviteGate";

const NONCE_TTL = 600;
const NONCE_PREFIX = "user:nonce";

export const dynamic = "force-dynamic";

const norm = (u: unknown) => String(u ?? "").trim().toLowerCase().replace(/^@/, "");
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const tooMany = (retry: number) =>
  NextResponse.json({ ok: false, reason: "Too many requests, try again shortly." }, { status: 429, headers: { "retry-after": String(retry) } });

export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");
  if (url.searchParams.get("nonce") !== null) {
    if (!address || !isAddr(address)) return NextResponse.json({ error: "address required" }, { status: 400 });
    const rl = await hitLimit(kv(), `user:nonce:ip:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.usernameNoncePerIp.limit, PUBLIC_GET_LIMITS.usernameNoncePerIp.windowSec);
    if (!rl.ok) return tooMany(rl.retryAfterSec);
    const nonce = await issueNonce(kv(), NONCE_PREFIX, address, NONCE_TTL);
    return NextResponse.json({ nonce, ttlSec: NONCE_TTL }, { headers: { "cache-control": "no-store" } });
  }
  // Lookups (?address / ?resolve / ?u=) share one bucket — caps enumeration without blocking a normal profile page.
  const look = await hitLimit(kv(), `user:lookup:ip:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.usernameLookupPerIp.limit, PUBLIC_GET_LIMITS.usernameLookupPerIp.windowSec);
  if (!look.ok) return tooMany(look.retryAfterSec);
  if (address) {
    if (!isAddr(address)) return NextResponse.json({ username: null, nextAllowedAt: null });
    const [username, last] = await Promise.all([usernameOf(address), lastUsernameChangeAt(address).catch(() => null)]);
    return NextResponse.json({ username, nextAllowedAt: nextUsernameChangeAt(last, Date.now()) }, { headers: { "cache-control": "no-store" } });
  }
  const resolve = url.searchParams.get("resolve");
  if (resolve !== null) {
    const r = norm(resolve);
    return NextResponse.json({ address: USERNAME_RE.test(r) ? await walletOf(r) : null });
  }
  const u = norm(url.searchParams.get("u"));
  const badU = validateUsername(u);
  if (badU) return NextResponse.json({ available: false, reason: badU });
  const taken = !!(await walletOf(u));
  return NextResponse.json({ available: !taken, reason: taken ? "Username taken." : undefined });
}

export async function POST(req: Request) {
  let body: { username?: string; address?: string; nonce?: string; signature?: string; owner?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, reason: "Bad JSON" }, { status: 400 }); }
  const u = norm(body.username);
  const addr = String(body.address ?? "").toLowerCase();
  // Same rules as the edit form (lib/profile.validateUsername): 3–20 chars a–z 0–9 _, not reserved. Only a NEW claim is
  // checked here; an existing name is never re-validated, so nobody's current profile breaks.
  const badU = validateUsername(u);
  if (badU) return NextResponse.json({ ok: false, reason: badU }, { status: 400 });
  if (!isAddr(addr)) return NextResponse.json({ ok: false, reason: "Invalid address." }, { status: 400 });
  // Wallet-signed claim: single-use server nonce + signature over claimMessage.
  const nonce = String(body.nonce ?? "");
  if (!(await nonceValid(kv(), NONCE_PREFIX, nonce, addr))) return NextResponse.json({ ok: false, reason: "Sign-in expired. Try again." }, { status: 401 });
  const who = await verifyWalletSignature(addr, claimMessage(u, addr, nonce), String(body.signature ?? ""), body.owner ?? null);
  if (who !== addr) return NextResponse.json({ ok: false, reason: "Signature didn't match this wallet." }, { status: 401 });
  // invite-only beta (lib/server/invites), checked after the signature so it can't be probed; off by default ⇒ no-op
  if (!(await requireInviteWallet(addr, "username")).ok) return NextResponse.json({ ok: false, reason: INVITE_REQUIRED_MESSAGE, error: "invite_required" }, { status: 403 });
  // 24h rename cooldown, checked after the signature (so a stranger can't probe it) and before the claim.
  const now = Date.now();
  const change = usernameChange({ prev: await usernameOf(addr), next: u, lastChangeAt: await lastUsernameChangeAt(addr), now });
  if (change.kind === "wait") {
    return NextResponse.json({ ok: false, reason: PROFILE_COPY["username.cooldown.error"], nextAllowedAt: change.nextAllowedAt }, { status: 429 });
  }
  const r = await claim(u, addr);
  if (!r.ok) return NextResponse.json(r, { status: 409 });
  if (change.kind === "allowed") await markUsernameChange(addr, now);
  // single use, consumed only by a successful claim (a concurrent replay of the same signed claim is the same
  // name for the same wallet, i.e. idempotent; any later replay finds no nonce)
  await consumeNonce(kv(), NONCE_PREFIX, nonce, addr);
  return NextResponse.json({ ok: true });
}
