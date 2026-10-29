/** POST { coin, text } + Authorization: Bearer <chat token> → SendResult. */
import { NextResponse } from "next/server";
import { chatStore } from "@/lib/server/chat/store";
import { fromFor, verifyToken } from "@/lib/server/chat/identity";
import { filterText } from "@/lib/chat/filter";
import { ulid } from "@/lib/chat/ulid";
import { isCoin, type ChatMsg, type SendResult } from "@/lib/chat/types";
import { INVITE_REQUIRED_MESSAGE, requireInviteWallet } from "@/lib/server/inviteGate";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const j = (r: SendResult, status = 200, headers?: Record<string, string>) => NextResponse.json(r, { status, headers });
export async function POST(req: Request) {
  const tok = verifyToken((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  if (!tok) return j({ ok: false, error: "no_identity" }, 401);
  // invite-only beta (lib/server/invites); off by default ⇒ no-op
  if (!(await requireInviteWallet(tok.a, "chat")).ok) return NextResponse.json({ ok: false, error: "invite_required", message: INVITE_REQUIRED_MESSAGE }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { coin?: string; text?: string };
  const coin = String(body.coin || "").toLowerCase();
  if (!isCoin(coin)) return NextResponse.json({ error: "bad_coin" }, { status: 400 });
  const f = filterText(body.text);
  if (!f.ok) return j({ ok: false, error: f.error }, 400);
  const st = chatStore();
  const now = Date.now();
  const rl = await st.rateTake(tok.a, now);
  if (!rl.ok) return j({ ok: false, error: "rate_limited", retryAfterMs: rl.retryAfterMs }, 429, { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) });
  const msg: ChatMsg = { id: ulid(now), coin, kind: "user", from: await fromFor(tok.a, coin), text: f.text, ts: now };
  await st.append(coin, msg);
  return j({ ok: true, msg });
}
