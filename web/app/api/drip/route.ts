/** Protocol-funded ETH top-ups are disabled, including on testnet. */
import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(_req: Request) {
  void _req;
  return NextResponse.json({ ok: false, reason: "gas sponsorship disabled" }, { status: 410 });
}
