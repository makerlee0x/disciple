/**
 * Lighter (Turbo's backup venue to Nova). Off unless LIGHTER_ENABLED=1. Signed-in pilots only (same gate as duels).
 * GET  → { ok, network, step, account, collateral, positions, feeBp }   step: deposit | key | tier | approve | ready
 * POST { op }
 *   key-start | approve-start          → { message }   the player's wallet signs it (personal_sign)
 *   key-finish | approve-finish { sig } → { hash }
 *   tier                                → { ok }        moves the account to Plus
 *   open { market, side: long|short, usd } → { hash, base, price, lev }
 *   close { market }                    → { hash }
 */
import { kv } from "@/lib/server/kv";
import { hitLimit } from "@/lib/server/limits";
import { body, out, pilotOf } from "@/lib/server/duel/http";
import { DuelError } from "@/lib/server/duel/store";
import { lighterConfig, isLighterMarket } from "@/lib/server/lighter/config";
import { LighterError } from "@/lib/server/lighter/rest";
import { closeMarket, finishSigned, openMarket, setTier, startApprove, startKey, status } from "@/lib/server/lighter/player";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function lfail(e: unknown) {
  if (e instanceof LighterError || e instanceof DuelError) return out(e.status >= 400 && e.status < 600 ? e.status : 502, { ok: false, reason: e.message });
  console.error("[lighter]", e);
  return out(500, { ok: false, reason: "Lighter didn't answer. Try again." });
}
function on() {
  const cfg = lighterConfig();
  if (!cfg.enabled) throw new LighterError(404, "Lighter isn't on.");
  return cfg;
}

export async function GET(req: Request) {
  try {
    const cfg = on(); const me = await pilotOf(req, { guestOk: false });
    return out(200, { ok: true, network: cfg.network, feeBp: cfg.partnerFee / 100, ...(await status(cfg, me.pid)) });
  } catch (e) { return lfail(e); }
}

export async function POST(req: Request) {
  try {
    const cfg = on(); const me = await pilotOf(req, { guestOk: false });
    const rl = await hitLimit(kv(), `lighter:${me.pid}`, 40, 10);
    if (!rl.ok) throw new LighterError(429, "Too many at once.");
    const b = await body<{ op?: unknown; sig?: unknown; market?: unknown; side?: unknown; usd?: unknown }>(req);
    switch (b.op) {
      case "key-start": return out(200, { ok: true, ...(await startKey(cfg, me.pid)) });
      case "approve-start": return out(200, { ok: true, ...(await startApprove(cfg, me.pid)) });
      case "key-finish": case "approve-finish": {
        if (typeof b.sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(b.sig)) throw new LighterError(400, "Bad signature.");
        return out(200, { ok: true, ...(await finishSigned(cfg, me.pid, b.op === "key-finish" ? "key" : "approve", b.sig)) });
      }
      case "tier": await setTier(cfg, me.pid); return out(200, { ok: true });
      case "open": {
        const usd = Number(b.usd);
        if (!isLighterMarket(b.market) || (b.side !== "long" && b.side !== "short") || !(usd >= 1 && usd <= 10_000)) throw new LighterError(400, "Bad order.");
        return out(200, { ok: true, ...(await openMarket(cfg, me.pid, b.market, b.side, usd)) });
      }
      case "close": {
        if (!isLighterMarket(b.market)) throw new LighterError(400, "Bad market.");
        return out(200, { ok: true, ...(await closeMarket(cfg, me.pid, b.market)) });
      }
      default: throw new LighterError(400, "Unknown op.");
    }
  } catch (e) { return lfail(e); }
}
