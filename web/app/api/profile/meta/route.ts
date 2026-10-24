export const runtime = "nodejs";
/**
 * Profile meta: picture / bio / country flag, keyed by wallet (lib/server/profileMeta). Same auth as the username claim
 * (/api/profile/username): single-use server nonce + wallet signature over profileMetaMessage, which covers every field.
 * GET  ?address=0x…          → { pfp, pfpUrl, bio, flag }
 * GET  ?nonce=1&address=0x…  → { nonce, ttlSec }
 * POST { address, pfp, bio, flag, nonce, signature, owner? } → { ok, reason? }
 *   pfp = id of an image that passed /api/moderate-image (must exist in the moderated image store) or "".
 *   bio must already be canonical (sanitizeBio) and ≤ BIO_MAX; flag = ISO 3166-1 alpha-2 or "".
 * Per-IP + per-wallet fixed-window limits (lib/server/limits, same as /api/moderate-image).
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { consumeNonce, issueNonce, nonceValid } from "@/lib/server/nonces";
import { verifyWalletSignature } from "@/lib/server/chat/identity";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { getImage } from "@/lib/server/imageStore";
import { metaOf, setMeta } from "@/lib/server/profileMeta";
import { normalizeFlag, pfpUrl, profileMetaMessage, sanitizeBio, validateMeta, type ProfileMeta } from "@/lib/profileMeta";

const NONCE_TTL = 600;
const NONCE_PREFIX = "meta:nonce";
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const tooMany = (retry: number) =>
  NextResponse.json({ ok: false, reason: "Too many requests, try again shortly." }, { status: 429, headers: { "retry-after": String(retry) } });

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = (url.searchParams.get("address") || "").toLowerCase();
  if (!isAddr(address)) return NextResponse.json({ error: "address required" }, { status: 400 });
  if (url.searchParams.get("nonce") !== null) {
    const rl = await hitLimit(kv(), `meta:nonce:ip:${clientIp(req.headers)}`, 30, 60);
    if (!rl.ok) return tooMany(rl.retryAfterSec);
    const nonce = await issueNonce(kv(), NONCE_PREFIX, address, NONCE_TTL);
    return NextResponse.json({ nonce, ttlSec: NONCE_TTL }, { headers: { "cache-control": "no-store" } });
  }
  const m = await metaOf(address).catch(() => ({ pfp: "", bio: "", flag: "" }));
  return NextResponse.json({ ...m, pfpUrl: pfpUrl(m.pfp) || null }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `meta:ip:${clientIp(req.headers)}`, 20, 60);
  if (!rl.ok) return tooMany(rl.retryAfterSec);
  let body: { address?: unknown; pfp?: unknown; bio?: unknown; flag?: unknown; nonce?: unknown; signature?: unknown; owner?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, reason: "Bad JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object") return NextResponse.json({ ok: false, reason: "Bad JSON" }, { status: 400 });
  const addr = String(body.address ?? "").toLowerCase();
  if (!isAddr(addr)) return NextResponse.json({ ok: false, reason: "Invalid address." }, { status: 400 });
  const rlA = await hitLimit(kv(), `meta:addr:${addr}`, 10, 60);
  if (!rlA.ok) return tooMany(rlA.retryAfterSec);

  const rawBio = typeof body.bio === "string" ? body.bio : "";
  const m: ProfileMeta = {
    pfp: typeof body.pfp === "string" ? body.pfp.trim().toLowerCase() : "",
    bio: sanitizeBio(rawBio),
    flag: normalizeFlag(typeof body.flag === "string" ? body.flag : ""),
  };
  // The signed message covers the exact posted bio, so it must already be canonical (no silent rewrite after signing).
  if (m.bio !== rawBio) return NextResponse.json({ ok: false, reason: "Invalid bio." }, { status: 400 });
  const bad = validateMeta(m);
  if (bad) return NextResponse.json({ ok: false, reason: bad }, { status: 400 });

  const nonce = String(body.nonce ?? "");
  if (!(await nonceValid(kv(), NONCE_PREFIX, nonce, addr))) return NextResponse.json({ ok: false, reason: "Sign-in expired. Try again." }, { status: 401 });
  const owner = typeof body.owner === "string" ? body.owner : null;
  const who = await verifyWalletSignature(addr, profileMetaMessage(addr, m, nonce), String(body.signature ?? ""), owner);
  if (who !== addr) return NextResponse.json({ ok: false, reason: "Signature didn't match this wallet." }, { status: 401 });
  // Pictures only from the moderated store: /api/moderate-image stores an image only on an "allow" verdict.
  if (m.pfp && !(await getImage(m.pfp).catch(() => null))) return NextResponse.json({ ok: false, reason: "Picture not found. Upload it again." }, { status: 400 });
  if (!(await consumeNonce(kv(), NONCE_PREFIX, nonce, addr))) return NextResponse.json({ ok: false, reason: "Sign-in expired. Try again." }, { status: 401 });
  await setMeta(addr, m);
  return NextResponse.json({ ok: true });
}
