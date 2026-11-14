/**
 * POST /api/account/delete  { confirm: "DELETE" }  with a Privy bearer token → removes the pilot's DISCIPLE data and their
 * Privy login (lib/server/deleteAccount). Settings → Delete account calls it, then signs out.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { deleteAccount } from "@/lib/server/deleteAccount";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const out = (status: number, b: unknown) => NextResponse.json(b, { status, headers: { "cache-control": "private, no-store" } });

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `acctdel:ip:${clientIp(req.headers)}`, 5, 600);
  if (!rl.ok) return out(429, { error: "Too many tries. Wait a few minutes." });
  const b = (await req.json().catch(() => ({}))) as { confirm?: unknown };
  if (b.confirm !== "DELETE") return out(400, { error: "Type DELETE to confirm." });
  const pe = privyEnv();
  const a = await authenticate(bearer(req.headers), pe);
  if (!a.ok) return out(a.status, { error: a.reason });
  const r = await deleteAccount(a.user, pe);
  return r.ok ? out(200, r) : out(502, { error: r.reason });
}
