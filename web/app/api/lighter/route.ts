/**
 * Lighter (Turbo's backup venue to Nova). Off unless LIGHTER_ENABLED=1. Signed-in pilots only (same gate as duels).
 * GET  → { ok, network, step, account, collateral, positions, feeBp }   step: deposit | key | tier | approve | ready
 * POST { op }
 *   key-start | approve-start          → { message }   the player's wallet signs it (personal_sign)
 *   key-finish | approve-finish { sig } → { hash }
 *   tier                                → { ok }        moves the account to Plus
 *   open { market, side: long|short, usd } → { hash, base, price, lev }
 *   close { market }                    → { hash }
 *   warm                                → loads key, signer, market and nonce into this instance before a duel
 *   presign { market, usd, used?: { nonce, kind }, floor? } → ticket: the next long, short and close, signed at one
 *                                         nonce with a short expiry; the browser sends the one it taps straight to Lighter
 *   relay { txType, txInfo }            → { hash }   fallback when the browser can't reach Lighter: sends a pre-signed order
 *   open / close / warm answer with ms: { auth, read, send, server, total } (server-side timings)
 */
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { body, out, pilotOf, requirePass } from "@/lib/server/duel/http";
import { DuelError } from "@/lib/server/duel/store";
import { lighterConfig, isLighterMarket } from "@/lib/server/lighter/config";
import { LighterError } from "@/lib/server/lighter/rest";
import { closeMarket, finishSigned, openMarket, presign, relay, setTier, startApprove, startKey, status, warm, type Used } from "@/lib/server/lighter/player";
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

/** Trades are the hot path: token check is local (Privy user cached), the rate limit runs alongside it, no username read. */
async function fastPilot(req: Request): Promise<string> {
  requirePass(req);
  const [auth, rl] = await Promise.all([authenticate(bearer(req.headers), privyEnv()), hitLimit(kv(), `lighter:ip:${clientIp(req.headers)}`, 60, 10)]);
  if (!rl.ok) throw new LighterError(429, "Too many at once.");
  if (!auth.ok) throw new LighterError(auth.status, "Sign in first.");
  const wallets = auth.user.wallets.map((w) => w.toLowerCase());
  const want = req.headers.get("x-wallet")?.toLowerCase();
  const pid = want && wallets.includes(want) ? want : wallets[0];
  if (!pid) throw new LighterError(403, "Your account needs a wallet.");
  return pid;
}

export async function POST(req: Request) {
  const t0 = performance.now();
  try {
    const cfg = on();
    const b = await body<{ op?: unknown; sig?: unknown; market?: unknown; side?: unknown; usd?: unknown; used?: unknown; floor?: unknown; txType?: unknown; txInfo?: unknown }>(req);
    if (b.op === "open" || b.op === "close" || b.op === "warm" || b.op === "presign" || b.op === "relay") {
      const pid = await fastPilot(req);
      const authMs = Math.round(performance.now() - t0);
      const r = b.op === "warm" ? (await warm(cfg, pid), {}) : b.op === "open" ? await openGuarded(cfg, pid, b) : b.op === "close" ? await closeGuarded(cfg, pid, b)
        : b.op === "presign" ? await presignGuarded(cfg, pid, b) : await relayGuarded(cfg, pid, b);
      const total = Math.round(performance.now() - t0);
      const res = out(200, { ok: true, ...r, ms: { auth: authMs, ...("ms" in r ? (r.ms as object) : {}), total } });
      res.headers.set("server-timing", `auth;dur=${authMs}, total;dur=${total}`);
      return res;
    }
    const me = await pilotOf(req, { guestOk: false });
    const rl = await hitLimit(kv(), `lighter:${me.pid}`, 40, 10);
    if (!rl.ok) throw new LighterError(429, "Too many at once.");
    switch (b.op) {
      case "key-start": return out(200, { ok: true, ...(await startKey(cfg, me.pid)) });
      case "approve-start": return out(200, { ok: true, ...(await startApprove(cfg, me.pid)) });
      case "key-finish": case "approve-finish": {
        if (typeof b.sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(b.sig)) throw new LighterError(400, "Bad signature.");
        return out(200, { ok: true, ...(await finishSigned(cfg, me.pid, b.op === "key-finish" ? "key" : "approve", b.sig)) });
      }
      case "tier": await setTier(cfg, me.pid); return out(200, { ok: true });
      default: throw new LighterError(400, "Unknown op.");
    }
  } catch (e) { return lfail(e); }
}

type Cfg = ReturnType<typeof lighterConfig>;
function openGuarded(cfg: Cfg, pid: string, b: { market?: unknown; side?: unknown; usd?: unknown }) {
  const usd = Number(b.usd);
  if (!isLighterMarket(b.market) || (b.side !== "long" && b.side !== "short") || !(usd >= 1 && usd <= 10_000)) throw new LighterError(400, "Bad order.");
  return openMarket(cfg, pid, b.market, b.side, usd);
}
function closeGuarded(cfg: Cfg, pid: string, b: { market?: unknown }) {
  if (!isLighterMarket(b.market)) throw new LighterError(400, "Bad market.");
  return closeMarket(cfg, pid, b.market);
}
function presignGuarded(cfg: Cfg, pid: string, b: { market?: unknown; usd?: unknown; used?: unknown; floor?: unknown }) {
  const usd = Number(b.usd);
  if (!isLighterMarket(b.market) || !(usd >= 1 && usd <= 10_000)) throw new LighterError(400, "Bad order.");
  const u = b.used as Partial<Used> | undefined;
  const used = u && Number.isSafeInteger(u.nonce) && (u.nonce as number) >= 0 && (u.kind === "long" || u.kind === "short" || u.kind === "close") ? (u as Used) : undefined;
  const floor = Number.isSafeInteger(b.floor) && (b.floor as number) >= 0 ? (b.floor as number) : 0;
  return presign(cfg, pid, b.market, usd, used, floor);
}
function relayGuarded(cfg: Cfg, pid: string, b: { txType?: unknown; txInfo?: unknown }) {
  if (!Number.isSafeInteger(b.txType) || typeof b.txInfo !== "string" || b.txInfo.length > 4000) throw new LighterError(400, "Bad order.");
  return relay(cfg, pid, b.txType as number, b.txInfo);
}
