/**
 * GET /api/share/card?wallet&coin[&format=story|og][&ticker][&username][&demo=1][&skin&coin_skin&thruster][&demoMcap]
 * PNG share card (story 1080×1920, og 1080×1080) drawn by lib/share/scene.ts on the tier sky of the end mcap.
 * Numbers come from indexed fills (pnlForPosition), never the query; loadout params are cosmetic only.
 * No fills / demo=1 → stamped SAMPLE DATA card.
 */
import type { Address } from "viem";
import { pnlForPosition } from "@/lib/server/share/pnl";
import { demoFills, DEMO_MCAP } from "@/lib/server/share/demo";
import { renderSharePng } from "@/lib/server/share/render";
import { pnlFromFills } from "@/lib/sharePnl";
import { usernameOf } from "@/lib/server/usernames";
import { refLabel } from "@/lib/referral";
import { serverPc } from "@/lib/server/chat/identity";
import { tokenAbi } from "@/lib/abi";
import type { SceneData } from "@/lib/share/scene";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const isAddr = (a: string | null): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
const clean = (s: string | null | undefined, re: RegExp) => (s && re.test(s) ? s : null);

export async function GET(req: Request) {
  const u = new URL(req.url), q = u.searchParams;
  const format = q.get("format") === "og" ? "og" : "story";
  const coin = q.get("coin") || "0x0000000000000000000000000000000000000000";
  const wallet = q.get("wallet");
  const at = Number(q.get("at")) || Date.now();
  let ticker = clean(q.get("ticker")?.toUpperCase().replace(/^\$/, ""), /^[A-Z0-9]{1,12}$/) || "ROCKET";
  let username = clean(q.get("username")?.toLowerCase(), /^[a-z0-9_]{3,20}$/);
  let pnl = null as Awaited<ReturnType<typeof pnlForPosition>> | null;
  if (q.get("demo") !== "1" && isAddr(wallet) && isAddr(coin)) {
    pnl = await pnlForPosition(wallet, coin, at).catch(() => null);
    username = (await usernameOf(wallet).catch(() => null)) ?? null;
    const sym = await serverPc().readContract({ address: coin as Address, abi: tokenAbi, functionName: "symbol" }).catch(() => null);
    if (typeof sym === "string" && sym) ticker = sym.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || ticker;
  }
  const sample = !pnl || pnl.kind === "none";
  const w = isAddr(wallet) ? wallet.toLowerCase() : "0x000000000000000000000000000000000000dead";
  if (sample) {
    const dm = Math.min(5e9, Math.max(7e3, Number(q.get("demoMcap")) || DEMO_MCAP));
    pnl = pnlFromFills(w, coin, demoFills(w, coin, at, dm), dm, at);
  }
  const host = u.host.startsWith("localhost") || u.host.endsWith(".vercel.app") ? u.host : "disciple.vip";
  const d: SceneData = {
    gainUsd: pnl!.gainUsd, gainPct: pnl!.gainPct, kind: pnl!.kind, ticker, mcapStart: pnl!.mcapStartUsd, mcapEnd: pnl!.mcapEndUsd,
    endTs: pnl!.endTs || at, username, refLabel: refLabel(username, isAddr(wallet) ? wallet : null, host), sample,
    fills: pnl!.fills.map((f) => ({ side: f.side, mcapUsd: f.mcapUsd })),
  };
  const png = await renderSharePng(d, { skin: q.get("skin") || undefined, coin: q.get("nose") || undefined, thruster: q.get("thruster") || undefined }, format);
  return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "public, max-age=60, s-maxage=60" } });
}
