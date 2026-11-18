/**
 * Lighter (Turbo's backup venue to Nova). Off unless LIGHTER_ENABLED=1. Signed-in pilots only (same gate as duels).
 * GET  → { ok, network, step, account, collateral, positions, feeBp, mins }   step: deposit | key | tier | approve | ready
 * POST { op }
 *   key-start | approve-start          → { message }   the player's wallet signs it (personal_sign)
 *   key-finish | approve-finish { sig } → { hash }
 *   tier                                → { ok }        moves the account to Plus
 *   open { market, side: long|short, usd } → { hash, base, price, lev }
 *   close { market }                    → { hash }
 *   warm                                → loads key, signer, market and nonce into this instance before a duel
 *   presign { market, sizes: [usd…] (or usd), used?: { nonce, kind, i }, floor? } → ticket: the next long, short and close, signed at one
 *                                         nonce with a short expiry; the browser sends the one it taps straight to Lighter
 *   deposit-address { usd? }            → { address, minNew, min, outUsd?, feeUsd? }  where to send USDG on Robinhood
 *                                         Chain: Lighter RH's intent address, or on Lighter main a Relay deposit address
 *                                         for exactly `usd` (USDC lands on the wallet's Arbitrum intent address)
 *   deposit-status                      → { state: none|processing|completed|unknown }
 *   withdraw-info                       → { usd, fee, min }  Turbo cash that can go back to Cash now (lib/server/lighter/withdraw)
 *   withdraw-start { usd, to, raw? }    → { message, usd, fee }  the player's wallet signs it (Lighter needs the owner's L1 sig).
 *                                         Lighter main: through Relay back to Cash, or raw = USDC to the player's own wallet (test)
 *   withdraw-finish { sig }             → { usd, to }  fast withdrawal sent; Lighter pays `to` (USDG on Robinhood Chain)
 *   arm { kind: duel|climb|royale, id, markets?, ms? } → the buzzer closes this match's Lighter positions server-side
 *                                         (duel: when the room settles; climb / royale: a server timer of ms, at most 4.5 min)
 *   relay { txType, txInfo }            → { hash }   fallback when the browser can't reach Lighter: sends a pre-signed order
 *   open / close / warm answer with ms: { auth, read, send, server, total } (server-side timings)
 */
import { kv } from "@/lib/server/kv";
import { after } from "next/server";
import { getRoom } from "@/lib/server/duel/store";
import { OT_MS } from "@/lib/duel/rules";
import { armMatch, buzzer, sleep } from "@/lib/server/lighter/match";
import { depositAddress, depositChain, depositMins, depositStatus } from "@/lib/server/lighter/bridge";
import { finishWithdraw, startWithdraw, withdrawable } from "@/lib/server/lighter/withdraw";
import { noteTurboIn, noteTurboOut } from "@/lib/server/cashHistory";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { body, out, pilotOf, requirePass } from "@/lib/server/duel/http";
import { DuelError } from "@/lib/server/duel/store";
import { lighterConfig, isLighterMarket } from "@/lib/server/lighter/config";
import { LighterError } from "@/lib/server/lighter/rest";
import { closeMarket, finishSigned, tierInfo, openMarket, MAX_SIZES, presign, relay, setTier, startApprove, startKey, status, warm, type Used } from "@/lib/server/lighter/player";
export const runtime = "nodejs";
/** Lighter refuses signed txs from US IPs, and our other functions run in iad1 (Washington) */
export const preferredRegion = "fra1";
export const dynamic = "force-dynamic";
/** arm's timer for Climb / Royale runs in after() for the match length */
export const maxDuration = 300;

function lfail(e: unknown) {
  if (e instanceof LighterError || e instanceof DuelError) return out(e.status >= 400 && e.status < 600 ? e.status : 502, { ok: false, reason: e.message });
  console.error("[lighter]", e);
  // the cause rides along (cut short) so a failed step can be traced from the page; no keys or tokens reach these messages
  const why = e instanceof Error ? `${e.name === "Error" ? "" : `${e.name}: `}${e.message}`.slice(0, 160) : "";
  return out(500, { ok: false, reason: `Lighter didn't answer. Try again.${why ? ` (${why})` : ""}` });
}
function on() {
  const cfg = lighterConfig();
  if (!cfg.enabled) throw new LighterError(404, "Lighter isn't on.");
  return cfg;
}

export async function GET(req: Request) {
  try {
    const cfg = on(); const me = await pilotOf(req, { guestOk: false });
    return out(200, { ok: true, network: cfg.network, url: cfg.url, feeBp: cfg.partnerFee / 100, withdraw: cfg.payoutIsCash, mins: depositMins(cfg), ...(await status(cfg, me.pid)) });
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
    const b = await body<{ op?: unknown; sig?: unknown; market?: unknown; side?: unknown; usd?: unknown; sizes?: unknown; used?: unknown; floor?: unknown; txType?: unknown; txInfo?: unknown; kind?: unknown; id?: unknown; markets?: unknown; ms?: unknown; to?: unknown; raw?: unknown }>(req);
    if (b.op === "arm") {
      const pid = await fastPilot(req);
      return out(200, { ok: true, ...(await armGuarded(pid, b)) });
    }
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
      case "deposit-address": {
        const d = await depositAddress(me.pid, Number(b.usd) || undefined);
        await noteTurboIn(me.pid, d.address);   // the Flight log labels cash sent here as Turbo cash
        return out(200, { ok: true, ...d, ...depositMins(cfg), chainId: depositChain(cfg) });
      }
      case "deposit-status": return out(200, { ok: true, ...(await depositStatus(me.pid)) });
      case "tier-info": return out(200, { ok: true, ...(await tierInfo(cfg, me.pid)) });
      case "withdraw-info": return out(200, { ok: true, ...(await withdrawable(cfg, me.pid)) });
      case "withdraw-start": {
        const usd = Number(b.usd);
        if (!(usd > 0 && usd <= 100_000) || typeof b.to !== "string") throw new LighterError(400, "Bad amount.");
        return out(200, { ok: true, ...(await startWithdraw(cfg, me.pid, usd, b.to, b.raw === true)) });
      }
      case "withdraw-finish": {
        if (typeof b.sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(b.sig)) throw new LighterError(400, "Bad signature.");
        const w = await finishWithdraw(cfg, me.pid, b.sig);
        await noteTurboOut(me.pid, w.usd);   // the Flight log labels the cash that lands next as from Turbo
        return out(200, { ok: true, ...w });
      }
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
function presignGuarded(cfg: Cfg, pid: string, b: { market?: unknown; usd?: unknown; sizes?: unknown; used?: unknown; floor?: unknown }) {
  const sizes = (Array.isArray(b.sizes) ? b.sizes : [b.usd]).map(Number);
  if (!isLighterMarket(b.market) || !sizes.length || sizes.length > MAX_SIZES || !sizes.every((u) => u >= 0 && u <= 10_000) || !sizes.some((u) => u > 0)) throw new LighterError(400, "Bad order.");
  const u = b.used as Partial<Used> | undefined;
  const ok = u && Number.isSafeInteger(u.nonce) && (u.nonce as number) >= 0 && (u.kind === "long" || u.kind === "short" || u.kind === "close")
    && (u.i === undefined || (Number.isSafeInteger(u.i) && (u.i as number) >= 0 && (u.i as number) < MAX_SIZES));
  const used = ok ? { nonce: u.nonce as number, kind: u.kind as Used["kind"], i: u.i } : undefined;
  const floor = Number.isSafeInteger(b.floor) && (b.floor as number) >= 0 ? (b.floor as number) : 0;
  return presign(cfg, pid, b.market, sizes, used, floor);
}
function relayGuarded(cfg: Cfg, pid: string, b: { txType?: unknown; txInfo?: unknown }) {
  if (!Number.isSafeInteger(b.txType) || typeof b.txInfo !== "string" || b.txInfo.length > 4000) throw new LighterError(400, "Bad order.");
  return relay(cfg, pid, b.txType as number, b.txInfo);
}
const SOLO_MAX_MS = 270_000;
async function armGuarded(pid: string, b: { kind?: unknown; id?: unknown; markets?: unknown; ms?: unknown }) {
  const id = typeof b.id === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(b.id) ? b.id : null;
  if (!id) throw new LighterError(400, "Bad match.");
  if (b.kind === "duel") {
    const r = await getRoom(id);
    if (!r || !r.players.some((p) => p.pid === pid) || (r.status !== "lobby" && r.status !== "live")) throw new LighterError(409, "That duel isn't running.");
    // the duel settles itself (overtime included) and its store fires the buzzer; endAt only sets how long we remember
    const endAt = (r.endAt ?? Date.now() + 5 * 60_000) + OT_MS;
    await armMatch(pid, "duel", id, ["BTC"], endAt);
    return { endAt };
  }
  if (b.kind !== "climb" && b.kind !== "royale") throw new LighterError(400, "Bad match.");
  const ms = Number(b.ms);
  const markets = (Array.isArray(b.markets) ? b.markets : ["BTC"]).filter(isLighterMarket);
  if (!(ms > 0 && ms <= SOLO_MAX_MS) || !markets.length) throw new LighterError(400, "Bad match.");
  const a = await armMatch(pid, b.kind, id, markets, Date.now() + ms);
  if (!a) throw new LighterError(404, "Lighter isn't on.");
  // a re-arm (Royale on a new coin) adds its market and keeps the first timer; a first arm starts it
  if (a.fresh) after(async () => { await sleep(a.endAt - Date.now() + 1500); await buzzer(pid, id); });
  return { endAt: a.endAt };
}
