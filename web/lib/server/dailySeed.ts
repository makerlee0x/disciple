import "server-only";
/**
 * Daily flight secrets (bot protection, maker 2026-11-13). A day's seed mixes in a server-only salt, so nobody can work
 * out a day's market from the date and solve it offline before flying. The browser gets the seed when it starts a run,
 * together with a signed start ticket; a scored run only counts with a valid ticket for that device, submitted no sooner
 * than a real flight takes.
 *
 * The secret is DAILY_SEED_SECRET when set, else a random one made once and kept in KV (daily:secret).
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { kv, type Kv } from "./kv";
import { dailySeed, dailySeconds } from "../sim/daily";

let secretP: Promise<string> | null = null;
async function secret(s: Kv): Promise<string> {
  const env = process.env.DAILY_SEED_SECRET; if (env && env.length >= 16) return env;
  if (!secretP) secretP = (async () => {
    const have = await s.get("daily:secret"); if (have) return have;
    const fresh = randomBytes(32).toString("hex"); await s.setNX("daily:secret", fresh);
    return (await s.get("daily:secret")) || fresh;
  })().catch((e) => { secretP = null; throw e; });
  return secretP;
}
const mac = (key: string, msg: string) => createHmac("sha256", key).update(msg).digest("hex");

/** the server's seed of daily `id` */
export async function serverDailySeed(id: number, s: Kv = kv()): Promise<number> {
  return dailySeed(id, mac(await secret(s), `daily:salt:${id}`).slice(0, 32));
}

/** a run takes the whole flight in real time (1×): a submit sooner than this after its ticket is not a real flight */
export const MIN_FLIGHT_MS = (dailySeconds() - 5) * 1000;
/** a ticket older than this has gone stale (a paused tab, a run left open) */
export const TICKET_TTL_MS = 45 * 60_000;

export async function issueTicket(id: number, runId: string, now = Date.now(), s: Kv = kv()): Promise<string> {
  return `${now}.${mac(await secret(s), `daily:ticket:${id}:${runId}:${now}`)}`;
}
export type TicketCheck = { ok: true; issuedAt: number } | { ok: false; error: string };
export async function checkTicket(id: number, runId: string, ticket: unknown, now = Date.now(), s: Kv = kv()): Promise<TicketCheck> {
  if (typeof ticket !== "string" || !/^\d{12,14}\.[0-9a-f]{64}$/.test(ticket)) return { ok: false, error: "Start the flight from the game to score it." };
  const [ts, sig] = ticket.split("."), at = Number(ts);
  const want = Buffer.from(mac(await secret(s), `daily:ticket:${id}:${runId}:${at}`), "hex"), got = Buffer.from(sig, "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, error: "Start the flight from the game to score it." };
  if (now - at < MIN_FLIGHT_MS) return { ok: false, error: "That flight ended too fast to score." };
  if (now - at > TICKET_TTL_MS) return { ok: false, error: "This flight's start ticket ran out. Fly it again." };
  return { ok: true, issuedAt: at };
}
