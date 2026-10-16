/** GET /api/share/pnl?wallet&coin → PositionPnl (end = now for open positions). */
import { NextResponse } from "next/server";
import { pnlForPosition } from "@/lib/server/share/pnl";
import { indexTrades } from "@/lib/server/trades";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const isAddr = (a: string | null): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);

export async function GET(req: Request) {
  const u = new URL(req.url);
  const wallet = u.searchParams.get("wallet"), coin = u.searchParams.get("coin");
  if (!isAddr(wallet) || !isAddr(coin)) return NextResponse.json({ error: "wallet and coin required" }, { status: 400 });
  await indexTrades(5_000).catch(() => {});
  return NextResponse.json(await pnlForPosition(wallet, coin));
}
