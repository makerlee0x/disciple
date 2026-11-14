"use client";
/**
 * /turbo/duel: Trading Duel. The screens (lobby, search, invite, ready check, the race, result) are the signed-off
 * prototype, shipped as public/turbo/duel/engine.js (window.DuelEngine). This component is its host: it does every
 * server call (lib/duel/client), feeds live BTC from the Turbo adapter, and passes the room's events through.
 * Practice bots run inside the engine and are always labelled as bots.
 */
import { useEffect, useRef } from "react";
import { getTurboAdapter } from "@/lib/turbo";
import { onPrivy, privyAuthenticated, privyLogin } from "@/lib/aa/sessionState";
import { duelApi, followRoom, type Follow, type RoomRes, type Res } from "@/lib/duel/client";
import { parseCode, type LengthMs, type TierId, type TradeAction } from "@/lib/duel/rules";
import type { DuelEvent, DuelRoom } from "@/lib/duel/types";

type Tick = { ts: number; p: number };
interface EngineApi {
  price(p: number, ts: number): void;
  setMe(rec: { w: number; l: number; rating: number; streak: number } | null, signed: boolean): void;
  setClock(serverNow: number): void;
  searching(waitedMs: number, window: number, botOffer: boolean): void;
  invite(code: string, url: string): void;
  room(r: DuelRoom, me: string): void;
  event(e: DuelEvent): void;
  error(t: string): void;
  toLobby(): void;
  destroy(): void;
}
declare global { interface Window { DuelEngine?: { mount(root: HTMLElement, host: unknown): EngineApi } } }

const SKIES = ["sky0", "sky1", "sky2", "sky3", "sky4"];
const ENGINE_SRC = "/turbo/duel/engine.js?v=1";

function loadEngine(): Promise<void> {
  if (window.DuelEngine) return Promise.resolve();
  return new Promise((res, rej) => {
    const el = document.createElement("script"); el.src = ENGINE_SRC; el.async = true;
    el.onload = () => res(); el.onerror = () => rej(new Error("engine")); document.head.appendChild(el);
  });
}

export default function DuelScreen() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let dead = false, api: EngineApi | null = null, me: string | null = null, roomId: string | null = null;
    let fol: Follow | null = null, qTimer: ReturnType<typeof setTimeout> | null = null, queued: { tier: TierId; len: LengthMs } | null = null;
    let pendingCode = parseCode(new URLSearchParams(location.search).get("c"));
    const hist: Tick[] = [];

    // live BTC, kept 90 s back so the chart is full when a duel starts
    const stopPrice = getTurboAdapter().subscribePrice("BTC", (t) => {
      const ts = t.ts || Date.now(); hist.push({ ts, p: t.price });
      while (hist.length && hist[0].ts < ts - 90_000) hist.shift();
      api?.price(t.price, ts);
    });

    const unfollow = () => { fol?.stop(); fol = null; roomId = null; };
    const follow = (id: string) => {
      if (roomId === id) return; unfollow(); roomId = id;
      fol = followRoom(id, (e) => api?.event(e), (room, now) => {
        if (dead || !me) return;
        api?.setClock(now); api?.room(room, me);
        if (room.status === "done" && room.rematch?.roomId && room.rematch.roomId !== id) follow(room.rematch.roomId);
        if (room.status === "cancelled") unfollow();
      });
    };
    const stopQueue = () => { if (qTimer) clearTimeout(qTimer); qTimer = null; const q = queued; queued = null; return q; };
    const pollQueue = async () => {
      if (!queued || dead) return;
      const r = await duelApi.poll(queued.tier, queued.len);
      if (!queued || dead) return;
      if (!r.ok) { stopQueue(); api?.error(r.reason); return; }
      if (r.room) { stopQueue(); follow(r.room.id); return; }
      api?.searching(r.waitedMs ?? 0, r.window ?? 50, (r.waitedMs ?? 0) >= r.botOfferMs);
      qTimer = setTimeout(pollQueue, 1500);
    };
    const refreshMe = async () => {
      if (!privyAuthenticated()) { me = null; api?.setMe(null, false); return; }
      const r = await duelApi.me();
      if (dead) return;
      if (!r.ok) { me = null; api?.setMe(null, false); return; }
      me = r.pid; api?.setMe({ w: r.rating.w, l: r.rating.l, rating: r.rating.r, streak: r.rating.streak }, true);
      if (r.active) follow(r.active.id);
      else if (pendingCode) { const c = pendingCode; pendingCode = null; const j = await duelApi.join(c); if (j.ok) follow(j.room.id); else api?.error(j.reason); }
    };
    /** a press: send it, show the server's echo at once (the stream would bring it ~250 ms later) */
    const op = async (body: Parameters<typeof duelApi.op>[1]): Promise<{ error?: string }> => {
      if (!roomId || !fol) return { error: "Not in a duel." };
      const f = fol, r: Res<RoomRes> = await duelApi.op(roomId, body, f.seq());
      if (!r.ok) return { error: r.reason };
      f.ingest(r.events); return {};
    };

    const host = {
      assets: Object.fromEntries(["rocket", ...SKIES].map((k) => [k, `/turbo/duel/${k}.webp`])),
      history: () => hist.filter((h) => h.ts > Date.now() - 60_000),
      signIn: () => { try { privyLogin(); } catch (e) { api?.error((e as Error).message); } },
      quickMatch: (tier: TierId, len: LengthMs) => { stopQueue(); queued = { tier, len }; void pollQueue(); },
      cancelSearch: () => { const q = stopQueue(); if (q) void duelApi.cancel(q.tier, q.len); },
      createLink: async (tier: TierId, len: LengthMs) => {
        const r = await duelApi.invite(tier, len);
        if (!r.ok) { api?.error(r.reason); return; }
        api?.invite(r.code, location.origin + r.path); follow(r.room.id);
      },
      join: async (code: string) => { const r = await duelApi.join(code); if (r.ok) follow(r.room.id); else api?.error(r.reason); },
      ready: async () => { const r = await op({ op: "ready" }); if (r.error) api?.error(r.error); },
      leave: async () => { const id = roomId; unfollow(); if (id) await duelApi.op(id, { op: "leave" }); },
      rematch: async () => { const r = await op({ op: "rematch" }); if (r.error) api?.error(r.error); },
      toLobby: () => { unfollow(); void refreshMe(); },
      trade: (action: TradeAction, usd: number) => op({ op: "trade", action, usd }),
      chat: (text: string) => op({ op: "chat", text }),
      trick: (kind: "spin" | "flip") => { void op({ op: "trick", kind }); },
    };

    loadEngine().then(() => {
      if (dead || !ref.current || !window.DuelEngine) return;
      api = window.DuelEngine.mount(ref.current, host);
      void refreshMe();
    }).catch(() => { if (ref.current) ref.current.textContent = "Couldn't load the duel. Refresh to try again."; });
    const offPrivy = onPrivy(() => { void refreshMe(); });

    return () => { dead = true; stopQueue(); unfollow(); stopPrice(); offPrivy(); api?.destroy(); };
  }, []);
  return <div ref={ref} />;
}
