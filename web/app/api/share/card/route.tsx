/**
 * GET /api/share/card?wallet&coin[&format=story|og][&ticker][&username][&demo=1]
 * PNG share card for one position (story 1080×1920, og 1080×1080). Numbers are computed server-side from indexed
 * fills (pnlForPosition), never taken from the query. No fills / demo=1 → stamped SAMPLE DATA card.
 */
import { ImageResponse } from "next/og";
import type { Address } from "viem";
import { CardEl, SIZES, geist, geistMono, grain, type CardData } from "@/lib/server/share/card";
import { pnlForPosition } from "@/lib/server/share/pnl";
import { demoFills, DEMO_MCAP } from "@/lib/server/share/demo";
import { pnlFromFills } from "@/lib/sharePnl";
import { usernameOf } from "@/lib/server/usernames";
import { refLabel } from "@/lib/referral";
import { serverPc } from "@/lib/server/chat/identity";
import { tokenAbi } from "@/lib/abi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const isAddr = (a: string | null): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
const clean = (s: string | null, re: RegExp) => (s && re.test(s) ? s : null);

export async function GET(req: Request) {
  const u = new URL(req.url);
  const format = u.searchParams.get("format") === "og" ? "og" : "story";
  const coin = u.searchParams.get("coin") || "0x0000000000000000000000000000000000000000";
  const wallet = u.searchParams.get("wallet");
  const at = Number(u.searchParams.get("at")) || Date.now();
  let ticker = clean(u.searchParams.get("ticker")?.toUpperCase().replace(/^\$/, "") ?? null, /^[A-Z0-9]{1,12}$/) || "ROCKET";
  let username = clean(u.searchParams.get("username")?.toLowerCase() ?? null, /^[a-z0-9_]{3,20}$/);

  let pnl = null as Awaited<ReturnType<typeof pnlForPosition>> | null;
  if (u.searchParams.get("demo") !== "1" && isAddr(wallet) && isAddr(coin)) {
    pnl = await pnlForPosition(wallet, coin, at).catch(() => null);
    username = (await usernameOf(wallet).catch(() => null)) ?? null; // server truth beats the query
    const sym = await serverPc().readContract({ address: coin as Address, abi: tokenAbi, functionName: "symbol" }).catch(() => null);
    if (typeof sym === "string" && sym) ticker = sym.toUpperCase().slice(0, 12);
  }
  const sample = !pnl || pnl.kind === "none";
  const w = isAddr(wallet) ? wallet.toLowerCase() : "0x000000000000000000000000000000000000dead";
  if (sample) pnl = pnlFromFills(w, coin, demoFills(w, coin, at), DEMO_MCAP, at);
  const d: CardData = { pnl: pnl!, ticker, username, refLabel: refLabel(username, isAddr(wallet) ? wallet : null, u.host === "localhost:3000" || u.host.endsWith(".vercel.app") ? u.host : "disciple.vip"), sample };
  const [f, fm, g] = await Promise.all([geist(), geistMono(), grain()]);
  return new ImageResponse(<CardEl d={d} format={format} grainUri={g} />, {
    ...SIZES[format],
    fonts: [{ name: "Geist", data: f, weight: 900 }, { name: "GeistMono", data: fm, weight: 700 }],
    headers: { "cache-control": "public, max-age=60, s-maxage=60" },
  });
}
