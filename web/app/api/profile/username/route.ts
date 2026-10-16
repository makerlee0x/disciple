export const runtime = "nodejs";
/**
 * Username registry (Upstash via lib/server/usernames; local file fallback without KV env).
 * GET  ?u=name            → { available, reason? }
 * GET  ?address=0x…       → { username | null }
 * GET  ?resolve=name      → { address | null }        (reverse lookup username → wallet)
 * GET  ?nonce=1&address=0x… → { nonce, ttlSec }   (single-use, 10 min; sign claimMessage(username, address, nonce))
 * POST { username, address, nonce, signature, owner? } → { ok, reason? }
 *   signature = wallet signMessage(claimMessage(...)) — EOA/1271/6492, or a DISCIPLE smart account's owner signing
 *   keccak(message) raw (pass `owner`). Verified with lib/server/chat/identity.verifyWalletSignature.
 */
import { NextResponse } from "next/server";
import { RESERVED, USERNAME_RE } from "@/lib/profile";
import { randomBytes } from "crypto";
import { claim, usernameOf, walletOf } from "@/lib/server/usernames";
import { kv } from "@/lib/server/kv";
import { verifyWalletSignature } from "@/lib/server/chat/identity";
import { claimMessage } from "@/lib/usernameClaim";

const NONCE_TTL = 600;
const nonceKey = (a: string) => `user:nonce:${a.toLowerCase()}`;

export const dynamic = "force-dynamic";

const norm = (u: unknown) => String(u ?? "").trim().toLowerCase().replace(/^@/, "");
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");
  if (url.searchParams.get("nonce") !== null) {
    if (!address || !isAddr(address)) return NextResponse.json({ error: "address required" }, { status: 400 });
    const nonce = randomBytes(16).toString("hex");
    await kv().del(nonceKey(address));
    await kv().setNX(nonceKey(address), nonce, NONCE_TTL);
    return NextResponse.json({ nonce, ttlSec: NONCE_TTL }, { headers: { "cache-control": "no-store" } });
  }
  if (address) return NextResponse.json({ username: isAddr(address) ? await usernameOf(address) : null });
  const resolve = url.searchParams.get("resolve");
  if (resolve !== null) {
    const r = norm(resolve);
    return NextResponse.json({ address: USERNAME_RE.test(r) ? await walletOf(r) : null });
  }
  const u = norm(url.searchParams.get("u"));
  if (!USERNAME_RE.test(u)) return NextResponse.json({ available: false, reason: "3–20 chars: a–z, 0–9, underscore." });
  if (RESERVED.has(u)) return NextResponse.json({ available: false, reason: "That name is reserved." });
  const taken = !!(await walletOf(u));
  return NextResponse.json({ available: !taken, reason: taken ? "Username taken." : undefined });
}

export async function POST(req: Request) {
  let body: { username?: string; address?: string; nonce?: string; signature?: string; owner?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, reason: "Bad JSON" }, { status: 400 }); }
  const u = norm(body.username);
  const addr = String(body.address ?? "").toLowerCase();
  if (!USERNAME_RE.test(u) || RESERVED.has(u)) return NextResponse.json({ ok: false, reason: "Invalid username." }, { status: 400 });
  if (!isAddr(addr)) return NextResponse.json({ ok: false, reason: "Invalid address." }, { status: 400 });
  // Wallet-signed claim: single-use server nonce + signature over claimMessage.
  const nonce = String(body.nonce ?? "");
  const stored = await kv().get(nonceKey(addr));
  if (!stored || !nonce || stored !== nonce) return NextResponse.json({ ok: false, reason: "Sign-in expired. Try again." }, { status: 401 });
  await kv().del(nonceKey(addr)); // single use, even if the signature is bad
  const who = await verifyWalletSignature(addr, claimMessage(u, addr, nonce), String(body.signature ?? ""), body.owner ?? null);
  if (who !== addr) return NextResponse.json({ ok: false, reason: "Signature didn't match this wallet." }, { status: 401 });
  const r = await claim(u, addr);
  if (!r.ok) return NextResponse.json(r, { status: 409 });
  return NextResponse.json({ ok: true });
}
