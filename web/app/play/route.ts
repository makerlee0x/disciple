/**
 * GET /play: "Play now" from the lobby top bar (signed out). Drops the visitor into the lobby's hero rocket (the #1
 * trending live flight, else the newest), the same rocket the landing hero's Play now opens. No live rocket: the
 * launch builder.
 */
import { NextResponse } from "next/server";
import { getHomeData } from "@/lib/server/home";
import { flightHref } from "@/components/home/rocketBits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const data = await getHomeData(4_000);
  const hero = data.coins.find((c) => c.token === data.hero && !c.graduated) ?? data.coins.find((c) => !c.graduated) ?? null;
  return NextResponse.redirect(new URL(hero ? flightHref(hero) : "/create", req.url), 307);
}
