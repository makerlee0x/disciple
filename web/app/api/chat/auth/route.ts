/** POST { addr, ts, sig, owner? } → { token, exp, addr }. See lib/server/chat/identity.ts. */
import { NextResponse } from "next/server";
import { chatSecretConfigured, issueToken, verifyLogin } from "@/lib/server/chat/identity";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  if (!chatSecretConfigured()) return NextResponse.json({ error: "chat_not_configured" }, { status: 503 });
  const body = await req.json().catch(() => ({}));
  const addr = await verifyLogin(body);
  if (!addr) return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  const t = issueToken(addr)!;
  return NextResponse.json({ ...t, addr });
}
