export const runtime = "nodejs";
/**
 * Username registry (Upstash via lib/server/usernames; local file fallback without KV env).
 * GET  ?u=name            → { available, reason? }
 * GET  ?address=0x…       → { username | null }
 * GET  ?resolve=name      → { address | null }        (reverse lookup username → wallet)
 * POST { username, address } → { ok, reason? }
 * TODO: require a signed message proving address ownership (still trusts the posted address).
 */
import { NextResponse } from "next/server";
import { RESERVED, USERNAME_RE } from "@/lib/profile";
import { claim, usernameOf, walletOf } from "@/lib/server/usernames";

export const dynamic = "force-dynamic";

const norm = (u: unknown) => String(u ?? "").trim().toLowerCase().replace(/^@/, "");
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");
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
  let body: { username?: string; address?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, reason: "Bad JSON" }, { status: 400 }); }
  const u = norm(body.username);
  const addr = String(body.address ?? "").toLowerCase();
  if (!USERNAME_RE.test(u) || RESERVED.has(u)) return NextResponse.json({ ok: false, reason: "Invalid username." }, { status: 400 });
  if (!isAddr(addr)) return NextResponse.json({ ok: false, reason: "Invalid address." }, { status: 400 });
  const r = await claim(u, addr);
  if (!r.ok) return NextResponse.json(r, { status: 409 });
  return NextResponse.json({ ok: true });
}
