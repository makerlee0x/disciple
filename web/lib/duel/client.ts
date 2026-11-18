/** Browser side of the duel API (/api/duel/*). Every call carries the Privy session; none throws. */
import { privyAccessToken } from "@/lib/aa/sessionState";
import type { LengthMs, TierId, TradeAction } from "./rules";
import type { DuelEvent, DuelRoom } from "./types";

export type Res<T> = ({ ok: true } & T) | { ok: false; reason: string; status?: number };
export interface RoomRes { room: DuelRoom; events: DuelEvent[]; now: number }

/** Duel-only demo page (/duel): every call uses the signed guest cookie instead of a Privy token (lib/server/duelGuest). */
let guest = false;
export const setDuelGuest = (on: boolean) => { guest = on; };

async function call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, auth = true): Promise<Res<T>> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth && guest) headers["x-duel-guest"] = "1";
    else if (auth) { const t = await privyAccessToken(); if (!t) return { ok: false, reason: "Sign in to duel.", status: 401 }; headers.authorization = `Bearer ${t}`; }
    const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) return { ok: false, reason: (j && typeof j.reason === "string" && j.reason) || "Couldn't reach the duel server.", status: r.status };
    return j as { ok: true } & T;
  } catch { return { ok: false, reason: "Couldn't reach the duel server." }; }
}

export const duelApi = {
  guest: () => call<{ pid: string; name: string }>("POST", "/api/duel/guest", {}, false),
  me: () => call<{ pid: string; name: string; rating: { r: number; w: number; l: number; streak: number }; active: DuelRoom | null }>("GET", "/api/duel/me"),
  poll: (tier: TierId, len: LengthMs, casual = false) => call<{ room?: DuelRoom; waitedMs?: number; window?: number; botOfferMs: number }>("POST", "/api/duel/queue", { tier, len, ...(casual ? { mode: "casual" } : {}) }),
  cancel: (tier: TierId, len: LengthMs, casual = false) => call<object>("DELETE", "/api/duel/queue", { tier, len, ...(casual ? { mode: "casual" } : {}) }),
  invite: (tier: TierId, len: LengthMs, fuel?: number) => call<{ room: DuelRoom; code: string; path: string; share?: string | null }>("POST", "/api/duel/invite", fuel ? { tier, len, fuel } : { tier, len }),
  join: (code: string) => call<{ room: DuelRoom }>("POST", "/api/duel/join", { code }),
  /** ping a pilot to join your open friend room (lib/server/duel/challenge, the /vs/<pilot> rematch request) */
  request: (to: string, code: string) => call<{ sent: string }>("POST", "/api/duel/request", { to, code }),
  room: (id: string, after = 0) => call<RoomRes>("GET", `/api/duel/room/${id}?after=${after}`, undefined, false),
  op: (id: string, body: { op: "ready" | "leave" | "rematch" | "report" } | { op: "trade"; action: TradeAction; usd: number } | { op: "chat"; text: string } | { op: "trick"; kind: "spin" | "flip" }, after = 0) =>
    call<RoomRes>("POST", `/api/duel/room/${id}`, { ...body, after }),
};

/** Follow one room: SSE first, polling GET as the fallback. Calls onRoom with fresh room state, onEvent once per seq. */
export interface Follow { stop(): void; seq(): number; ingest(evs: DuelEvent[]): void }
export function followRoom(id: string, onEvent: (e: DuelEvent) => void, onRoom: (r: DuelRoom, now: number) => void, onPrice?: (p: number, ts: number) => void): Follow {
  let seq = 0, stopped = false, es: EventSource | null = null, poll: ReturnType<typeof setTimeout> | null = null;
  let live = false, over = false, overAt = 0;
  const seen = (e: DuelEvent) => { if (e.seq <= seq) return; seq = e.seq; onEvent(e); };
  const refresh = async () => {
    const r = await duelApi.room(id, seq);
    if (stopped || !r.ok) return;
    if ((r.room.status === "done" || r.room.status === "cancelled") && !over) { over = true; overAt = Date.now(); es?.close(); es = null; live = false; }
    onRoom(r.room, r.now); r.events.forEach(seen);
  };
  const openStream = () => {
    if (stopped || over || typeof EventSource === "undefined") return;
    es = new EventSource(`/api/duel/room/${id}/stream?after=${seq}`);
    es.onopen = () => { live = true; };
    es.onerror = () => { live = false; };
    es.addEventListener("ev", (m) => { try { const e = JSON.parse((m as MessageEvent).data) as DuelEvent; seen(e); if (e.type === "start" || e.type === "join" || e.type === "ready" || e.type === "leave" || e.type === "rematch" || e.type === "end") void refresh(); } catch { /* bad frame */ } });
    es.addEventListener("price", (m) => { try { const j = JSON.parse((m as MessageEvent).data); onPrice?.(j.p, j.ts); } catch { /* bad frame */ } });
    es.addEventListener("end", () => { es?.close(); es = null; live = false; void refresh(); });
  };
  // KV budget (2026-11-16): poll every 2.5 s only while the stream is down, 10 s while it's up; a finished room is polled
  // every 4 s (to catch a rematch) for 3 minutes, then not at all
  const loop = () => {
    if (stopped) return;
    if (over && Date.now() - overAt > 180_000) return;
    poll = setTimeout(async () => { await refresh(); loop(); }, over ? 4000 : live ? 10_000 : 2500);
  };
  void refresh().then(openStream);
  loop();
  return {
    stop: () => { stopped = true; es?.close(); if (poll) clearTimeout(poll); },
    seq: () => seq,
    ingest: (evs) => { if (!stopped) evs.forEach(seen); },
  };
}
