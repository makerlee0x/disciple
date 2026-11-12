export const runtime = "nodejs";
/** X OAuth redirect target. Finishes the link and sends the browser back with ?x=linked|taken|denied|expired|error. */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { finishLink, safeReturnTo } from "@/lib/server/xLink";
import { X_RESULT_PARAM, type XResult } from "@/lib/xLink";

export const dynamic = "force-dynamic";

function back(origin: string, returnTo: string, result: XResult) {
  const u = new URL(safeReturnTo(returnTo), origin);
  u.searchParams.set(X_RESULT_PARAM, result);
  return NextResponse.redirect(u, { status: 303 });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = url.origin;
  const rl = await hitLimit(kv(), `x:cb:ip:${clientIp(req.headers)}`, 20, 60);
  if (!rl.ok) return back(origin, "/profile", "error");
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  if (url.searchParams.get("error")) {
    // The player said no on X. Burn the state so it can't be replayed.
    if (state) await kv().getDel(`x:state:${state}`).catch(() => null);
    return back(origin, "/profile", "denied");
  }
  if (!state || !code) return back(origin, "/profile", "expired");
  const r = await finishLink(state, code, origin);
  return back(origin, r.returnTo, r.ok ? "linked" : r.reason);
}
