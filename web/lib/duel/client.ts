/** Browser side of the duel API (/api/duel/*). Every call carries the Privy session; none throws. */
import { privyAccessToken } from "@/lib/aa/sessionState";
import type { LengthMs, TierId, TradeAction } from "./rules";
import type { DuelEvent, DuelRoom } from "./types";

export type Res<T> = ({ ok: true } & T) | { ok: false; reason: string; status?: number };
export interface RoomRes { room: DuelRoom; events: DuelEvent[]; now: number }

async function call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, auth = true): Promise<Res<T>> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth) { const t = await privyAccessToken(); if (!t) return { ok: false, reason: "Sign in to duel.", status: 401 }; headers.authorization = `Bearer ${t}`; }
    const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) return { ok: false, reason: (j && typeof j.reason === "string" && j.reason) || "Couldn't reach the duel server.", status: r.status };
    return j as { ok: true } & T;
  } catch { return { ok: false, reason: "Couldn't reach the duel server." }; }
}

export const duelApi = {
  me: () => call<{ pid: string; name: string; rating: { r: number; w: number; l: number; streak: number }; active: DuelRoom | null }>("GET", "/api/duel/me"),
  poll: (tier: TierId, len: LengthMs) => call<{ room?: DuelRoom; waitedMs?: number; window?: number; botOfferMs: number }>("POST", "/api/duel/queue", { tier, len }),
  cancel: (tier: TierId, len: LengthMs) => call<object>("DELETE", "/api/duel/queue", { tier, len }),
  invite: (tier: TierId, len: LengthMs) => call<{ room: DuelRoom; code: string; path: string }>("POST", "/api/duel/invite", { tier, len }),
  join: (code: string) => call<{ room: DuelRoom }>("POST", "/api/duel/join", { code }),
  room: (id: string, after = 0) => call<RoomRes>("GET", `/api/duel/room/${id}?after=${after}`, undefined, false),
  op: (id: string, body: { op: "ready" | "leave" | "rematch" } | { op: "trade"; action: TradeAction; usd: number } | { op: "chat"; text: string } | { op: "trick"; kind: "spin" | "flip" }, after = 0) =>
    call<RoomRes>("POST", `/api/duel/room/${id}`, { ...body, after }),
};

/** Follow one room: SSE first, polling GET as the fallback. Calls onRoom with fresh room state, onEvent once per seq. */
export interface Follow { stop(): void; seq(): number; ingest(evs: DuelEvent[]): void }
export function followRoom(id: string, onEvent: (e: DuelEvent) => void, onRoom: (r: DuelRoom, now: number) => void, onPrice?: (p: number, ts: number) => void): Follow {
  let seq = 0, stopped = false, es: EventSource | null = null, poll: ReturnType<typeof setInterval> | null = null;
  const seen = (e: DuelEvent) => { if (e.seq <= seq) return; seq = e.seq; onEvent(e); };
  const refresh = async () => {
    const r = await duelApi.room(id, seq);
    if (stopped || !r.ok) return;
    onRoom(r.room, r.now); r.events.forEach(seen);
  };
  const openStream = () => {
    if (stopped || typeof EventSource === "undefined") return;
    es = new EventSource(`/api/duel/room/${id}/stream?after=${seq}`);
    es.addEventListener("ev", (m) => { try { const e = JSON.parse((m as MessageEvent).data) as DuelEvent; seen(e); if (e.type === "start" || e.type === "join" || e.type === "ready" || e.type === "leave" || e.type === "rematch" || e.type === "end") void refresh(); } catch { /* bad frame */ } });
    es.addEventListener("price", (m) => { try { const j = JSON.parse((m as MessageEvent).data); onPrice?.(j.p, j.ts); } catch { /* bad frame */ } });
  };
  void refresh().then(openStream);
  poll = setInterval(() => { void refresh(); }, 2500); // also covers a dropped stream
  return {
    stop: () => { stopped = true; es?.close(); if (poll) clearInterval(poll); },
    seq: () => seq,
    ingest: (evs) => { if (!stopped) evs.forEach(seen); },
  };
}
