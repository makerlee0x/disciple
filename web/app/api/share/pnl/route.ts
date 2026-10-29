/** GET /api/share/pnl?wallet&coin[&demo=1&demoMcap] → PositionPnl (end = now for open positions). demo → sample fills, `next dev` only. */
import { NextResponse } from "next/server";
import { pnlForPosition } from "@/lib/server/share/pnl";
import { indexTrades } from "@/lib/server/trades";
import { demoFills, DEMO_MCAP } from "@/lib/server/share/demo";
import { pnlFromFills } from "@/lib/sharePnl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const isAddr = (a: string | null): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);

export async function GET(req: Request) {
  const u = new URL(req.url);
  const wallet = u.searchParams.get("wallet"), coin = u.searchParams.get("coin");
  if (process.env.NODE_ENV === "development" && u.searchParams.get("demo") === "1") {
    const w = isAddr(wallet) ? wallet.toLowerCase() : "0x000000000000000000000000000000000000dead", c = isAddr(coin) ? coin.toLowerCase() : "0x0";
    const dm = Math.min(5e9, Math.max(3333, Number(u.searchParams.get("demoMcap")) || DEMO_MCAP)), now = Number(u.searchParams.get("at")) || Date.now();
    return NextResponse.json({ ...pnlFromFills(w, c, demoFills(w, c, now, dm), dm, now), sample: true });
  }
  if (!isAddr(wallet) || !isAddr(coin)) return NextResponse.json({ error: "wallet and coin required" }, { status: 400 });
  await indexTrades(5_000).catch(() => {});
  return NextResponse.json(await pnlForPosition(wallet, coin));
}
