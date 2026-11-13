export const runtime = "nodejs";
/**
 * Free play XP (lib/xp FREE_PLAY_XP). Signed-in pilots only (Privy session: Authorization: Bearer <access token>).
 * POST { wallet, daily: { id, device } }                 → pays the device's stored, server-verified daily run once
 * POST { wallet, practice: { difficulty, seed, inputs } } → re-flies the practice run on the default config and pays it once
 * → { ok, xp, already, paidToday, perDay, capped, totalXp, level } | { ok: false, reason }
 * All Free play XP stops at FREE_PLAY_XP.perDay per UTC day. A daily run can be saved by one wallet only.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { authenticate, bearer, privyEnv } from "@/lib/server/privyAuth";
import { awardFreePlay } from "@/lib/server/xp";
import { bindOwner, readRun, runIdOf } from "@/lib/server/daily";
import { FREE_PLAY_XP, freePlayXp } from "@/lib/xp";
import { dailyToday, validInputs, verifyPractice } from "@/lib/sim/daily";
import { PLAYER, type DifficultyId } from "@/lib/sim/config";
import type { PlayerInput } from "@/lib/sim/run";

export const dynamic = "force-dynamic";
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const out = (status: number, b: Record<string, unknown>) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });
const DIFFS: DifficultyId[] = ["pve", "pvp", "trench"];

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `fp:xp:ip:${clientIp(req.headers)}`, 30, 60);
  if (!rl.ok) return out(429, { ok: false, reason: "Too many requests, try again shortly." });
  const raw = await req.text(); if (raw.length > 60_000) return out(413, { ok: false, reason: "Run too big." });
  let body: { wallet?: unknown; daily?: { id?: unknown; device?: unknown }; practice?: { difficulty?: unknown; seed?: unknown; inputs?: unknown } };
  try { body = JSON.parse(raw); } catch { return out(400, { ok: false, reason: "Bad JSON" }); }
  if (!isAddr(body?.wallet)) return out(400, { ok: false, reason: "wallet required" });
  const auth = await authenticate(bearer(req.headers), privyEnv());
  if (!auth.ok) return out(auth.status, { ok: false, reason: auth.reason });
  const wallet = body.wallet.toLowerCase();
  if (!auth.user.wallets.map((x) => x.toLowerCase()).includes(wallet)) return out(403, { ok: false, reason: "That wallet isn't on your account." });
  const wl = await hitLimit(kv(), `fp:xp:w:${wallet}`, 20, 60);
  if (!wl.ok) return out(429, { ok: false, reason: "Too many requests, try again shortly." });

  if (body.daily) {
    const id = Number(body.daily.id), device = body.daily.device, today = dailyToday();
    if (!Number.isInteger(id) || id < Math.max(1, today - FREE_PLAY_XP.claimDays) || id > today) return out(400, { ok: false, reason: "That daily can't be saved any more." });
    if (typeof device !== "string" || !/^[A-Za-z0-9-]{16,64}$/.test(device)) return out(400, { ok: false, reason: "bad device" });
    const run = await readRun(id, runIdOf(device));
    if (!run) return out(404, { ok: false, reason: "No scored daily on this device." });
    if (!(await bindOwner(id, run.runId, wallet))) return out(409, { ok: false, reason: "This run is saved to another pilot." });
    const r = await awardFreePlay(wallet, `fp:d:${id}`, freePlayXp("daily", run.score), `Daily flight #${id}`);
    return r.ok ? out(200, { ...r, perDay: FREE_PLAY_XP.perDay, runId: run.runId }) : out(409, r);
  }
  if (body.practice) {
    const { difficulty, seed, inputs } = body.practice;
    if (!DIFFS.includes(difficulty as DifficultyId) || !Number.isInteger(seed) || (seed as number) < 0 || (seed as number) >= 2 ** 32) return out(400, { ok: false, reason: "bad run" });
    if (!validInputs(inputs, PLAYER.defaultMinutes * 60, true)) return out(400, { ok: false, reason: "bad run" });
    const score = verifyPractice(difficulty as DifficultyId, seed as number, inputs as PlayerInput[]);
    const day = new Date().toISOString().slice(0, 10);
    const r = await awardFreePlay(wallet, `fp:p:${day}:${difficulty}:${seed}`, freePlayXp("practice", score), "Free play practice");
    return r.ok ? out(200, { ...r, perDay: FREE_PLAY_XP.perDay, multiple: score.multiple }) : out(409, r);
  }
  return out(400, { ok: false, reason: "daily or practice required" });
}
