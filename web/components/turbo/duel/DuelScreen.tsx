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
import { duelApi, followRoom, setDuelGuest, type Follow, type RoomRes, type Res } from "@/lib/duel/client";
import { DUEL_LEN_MS, parseCode, type LengthMs, type TierId, type TradeAction } from "@/lib/duel/rules";
import { trackFunnel } from "@/lib/funnelClient";
import { isFunnelStep } from "@/lib/funnel";
import { climbingNow, type HomeData } from "@/lib/home/trending";
import { LEAGUES } from "@/lib/duel/season";
import { flightHref, pct } from "@/components/home/rocketBits";
import type { DuelEvent, DuelRoom } from "@/lib/duel/types";
import { getGameRadio } from "@/lib/game/radio";
import { TRAILS, trailId } from "@/lib/collection";

const trailRgb = (id?: string) => TRAILS.find((t) => trailId(t.id) === id)?.rgb;
import { useTurboMusic } from "@/lib/game/turboMusic";

type Tick = { ts: number; p: number };
interface EngineApi {
  price(p: number, ts: number): void;
  setMe(rec: { w: number; l: number; rating: number; streak: number } | null, signed: boolean): void;
  setClock(serverNow: number): void;
  searching(waitedMs: number, window: number, botOffer: boolean): void;
  invite(code: string, url: string, share?: string): void;
  room(r: DuelRoom, me: string): void;
  event(e: DuelEvent): void;
  error(t: string): void;
  toLobby(): void;
  destroy(): void;
}
declare global { interface Window { DuelEngine?: { mount(root: HTMLElement, host: unknown): EngineApi } } }

const SKIES = ["sky0", "sky1", "sky2", "sky3", "sky4"];
/** extra plates for the random sky each duel (engine SKY_THEMES) */
const EXTRA_SKIES = { skyEth: "/turbo/sky-eth.webp", skyBtc: "/turbo/sky-btc.webp", skyPad: "/home/pad/sky-1280.webp" };
const ENGINE_SRC = "/turbo/duel/engine.js?v=38";

function loadEngine(): Promise<void> {
  if (window.DuelEngine) return Promise.resolve();
  return new Promise((res, rej) => {
    const el = document.createElement("script"); el.src = ENGINE_SRC; el.async = true;
    el.onload = () => res(); el.onerror = () => rej(new Error("engine")); document.head.appendChild(el);
  });
}

/** `guest`: the duel-only demo page (/duel). No sign-in: a guest pilot from /api/duel/guest, bots and friend links only. */
export default function DuelScreen({ guest = false }: { guest?: boolean } = {}) {
  const ref = useRef<HTMLDivElement>(null);
  useTurboMusic();
  useEffect(() => {
    let dead = false, api: EngineApi | null = null, me: string | null = null, roomId: string | null = null;
    let fol: Follow | null = null, qTimer: ReturnType<typeof setTimeout> | null = null, queued: { tier: TierId; len: LengthMs } | null = null;
    let pendingCode = parseCode(new URLSearchParams(location.search).get("c"));
    // /turbo/duel?request=<pilot> (from /vs/<pilot> when they're not waiting): open a friend room and ping them to join it
    let pendingRequest = (() => { const v = new URLSearchParams(location.search).get("request"); return v && /^[a-z0-9_]{1,42}$/i.test(v) ? v.toLowerCase() : null; })();
    const hist: Tick[] = [];

    // live BTC, kept 90 s back so the chart is full when a duel starts
    const stopPrice = getTurboAdapter().subscribePrice("BTC", (t) => {
      const ts = t.ts || Date.now(); hist.push({ ts, p: t.price });
      while (hist.length && hist[0].ts < ts - 90_000) hist.shift();
      api?.price(t.price, ts);
    });

    // Hangar looks (lib/collection: skin, trail, name tag): yours, and a real rival's, from /api/looks; the engine reads them as each duel starts
    type Fx = { burn: number; seed: number; trak?: number };
    type Art = { skin?: string; geo?: unknown; plume?: string; bits?: string; rgb?: string; flourish?: string };
    const ships = new Map<string, { skin: string; rgb?: string; trail?: string; tag?: string; flourish?: string; fx?: { skin?: Fx; trail?: Fx }; art?: Art }>();
    const loadShips = async (pids: string[]) => {
      const want = pids.filter((p) => p && !ships.has(p));
      if (!want.length) return;
      try {
        const j = (await (await fetch(`/api/looks?wallets=${want.join(",")}`)).json()) as { looks?: Record<string, { skin?: string; trail?: string; tag?: string; flourish?: string; fx?: { skin?: Fx; trail?: Fx }; art?: Art }> };
        // art: new items from the live catalogue carry their own art URLs (and a new hull its shape)
        for (const [w, l] of Object.entries(j.looks ?? {})) if (l.skin) ships.set(w, { skin: l.skin, rgb: l.art?.rgb ?? trailRgb(l.trail), trail: l.trail, tag: l.tag, flourish: l.flourish, fx: l.fx, art: l.art });
      } catch { /* the chrome rocket flies */ }
    };
    // /duel demo guests own no Hangar looks, so each guest flies a skin picked from their id, and a guest rival never
    // shares your hull (maker 2026-11-16: "make sure they're two different looking rockets")
    const G_HULLS = ["bullet", "hauler", "needle", "pulp", "shuttle", "twin-booster", "wedge"];
    const G_PAINTS = ["red-classic", "sky-blue", "safety-orange", "teal-racer", "white-gloss", "racing-green", "amethyst", "hazard", "carbon-gold", "koi"];
    const hashOf = (t: string) => { let h = 2166136261; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619); return h >>> 0; };
    const baseHull = (pid: string) => hashOf(pid) % G_HULLS.length;
    /** same answer on both screens: if both guests land on one hull, the higher id moves to another */
    const guestLook = (pid: string, other: string | null) => {
      const h = hashOf(pid); let hi = baseHull(pid);
      if (other && other.startsWith("g_") && pid > other && hi === baseHull(other)) hi = (hi + 1 + (h >>> 8) % (G_HULLS.length - 1)) % G_HULLS.length;
      return { skin: `${G_HULLS[hi]}--${G_PAINTS[(h >>> 16) % G_PAINTS.length]}` };
    };
    let rival: string | null = null;
    const lookOf = (pid: string | null, other: string | null) => (pid ? ships.get(pid) ?? (pid.startsWith("g_") ? guestLook(pid, other) : null) : null);
    const unfollow = () => { fol?.stop(); fol = null; roomId = null; };
    const follow = (id: string) => {
      if (roomId === id) return; unfollow(); roomId = id;
      fol = followRoom(id, (e) => api?.event(e), (room, now) => {
        if (dead || !me) return;
        void loadShips(room.players.map((p) => p.pid));
        rival = room.players.find((p) => p.pid !== me)?.pid ?? null; api?.setClock(now); api?.room(room, me);
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
    // guest pilot (the /duel demo): fetched once, and again before any friend-link action if the first try failed
    let guestReady = false;
    const ensureGuest = async (): Promise<boolean> => {
      if (!guest || guestReady) return true;
      const g = await duelApi.guest();
      if (!g.ok) { api?.error(g.reason); return false; }
      guestReady = true; return true;
    };
    const refreshMe = async () => {
      if (guest && !(await ensureGuest())) { if (!dead) { me = null; api?.setMe(null, false); } return; }
      if (!guest && !privyAuthenticated()) { me = null; api?.setMe(null, false); if (pendingRequest) api?.error(`Sign in to send @${pendingRequest} a duel request.`); return; }
      const r = await duelApi.me();
      if (dead) return;
      if (!r.ok) { me = null; api?.setMe(null, false); return; }
      me = r.pid; void loadShips([r.pid]); api?.setMe({ w: r.rating.w, l: r.rating.l, rating: r.rating.r, streak: r.rating.streak }, true);
      if (r.active) follow(r.active.id);
      else if (pendingCode) { const c = pendingCode; pendingCode = null; const j = await duelApi.join(c); if (j.ok) { trackFunnel("duel_join"); follow(j.room.id); } else api?.error(j.reason); }
      else if (pendingRequest) {
        const to = pendingRequest; pendingRequest = null;
        const inv = await duelApi.invite("pro", DUEL_LEN_MS);
        if (!inv.ok) { api?.error(inv.reason); return; }
        api?.invite(inv.code, location.origin + inv.path, inv.share ? location.origin + inv.share : undefined); follow(inv.room.id);
        const sent = await duelApi.request(to, inv.code);
        trackFunnel("duel_request");
        if (!sent.ok) api?.error(sent.reason);
      }
    };
    /** a press: send it, show the server's echo at once (the stream would bring it ~250 ms later) */
    const op = async (body: Parameters<typeof duelApi.op>[1]): Promise<{ error?: string }> => {
      if (!roomId || !fol) return { error: "Not in a duel." };
      const f = fol, r: Res<RoomRes> = await duelApi.op(roomId, body, f.seq());
      if (!r.ok) return { error: r.reason };
      f.ingest(r.events); return {};
    };

    // cross-link (maker 2026-11-16, "we need cross links"): the result card points at a real rocket climbing right now.
    // One /api/home read per visit; the /duel demo page (guests) stays duel-only.
    let climb: { sym: string; line: string; href: string } | null = null;
    if (!guest) void fetch("/api/home").then((r) => (r.ok ? r.json() : null)).then((d: HomeData | null) => {
      const c = d ? climbingNow(d.coins, 1)[0] ?? d.coins.find((x) => x.token === d.hero && !x.graduated) : null;
      if (!c) return;
      const chg = c.stats?.chg24, k = c.mcapUsd >= 1e6 ? `$${(c.mcapUsd / 1e6).toFixed(1)}M` : `$${Math.round(c.mcapUsd / 1e3)}K`;
      climb = { sym: (c.ticker || c.name).toUpperCase(), line: chg != null && chg > 0 ? `+${pct(chg)} today · ${k}` : `climbing · ${k}`, href: flightHref(c) };
    }).catch(() => {});

    const host = {
      climbing: () => climb,
      league: (id: string) => LEAGUES.find((l) => l.id === id) ?? null,
      assets: { ...Object.fromEntries(["rocket", ...SKIES].map((k) => [k, `/turbo/duel/${k}.webp`])), ...EXTRA_SKIES, art: "/art/modes/duel.webp" },
      history: () => hist.filter((h) => h.ts > Date.now() - 60_000),
      guest,
      signIn: () => { if (guest) { guestReady = false; void refreshMe(); return; } try { privyLogin(); } catch (e) { api?.error((e as Error).message); } },
      quickMatch: (tier: TierId, len: LengthMs) => { stopQueue(); queued = { tier, len }; void pollQueue(); },
      cancelSearch: () => { const q = stopQueue(); if (q) void duelApi.cancel(q.tier, q.len); },
      createLink: async (tier: TierId, len: LengthMs, fuel?: number) => {
        if (!(await ensureGuest())) return;
        if (guest && !me) await refreshMe();
        const r = await duelApi.invite(tier, len, fuel);
        if (!r.ok) { api?.error(r.reason); return; }
        api?.invite(r.code, location.origin + r.path, r.share ? location.origin + r.share : undefined); follow(r.room.id);
      },
      // the result card's SHARE (engine shareResult): a fresh friend link the shared post points at; the room is followed so a
      // friend who taps it pulls this pilot into the match
      challengeLink: async (tier: TierId, len: LengthMs, fuel?: number): Promise<string | null> => {
        if (!(await ensureGuest())) return null;
        const r = await duelApi.invite(tier, len, fuel);
        if (!r.ok) return null;
        // posts get the permanent /vs/<pilot> link (never expires, carries ?ref=); guests keep the room link
        follow(r.room.id); return location.origin + (r.share || r.path);
      },
      // first launch of the app: WelcomeIntro sends a new pilot to /turbo/duel?first=1 and the engine starts a bot duel
      first: (() => { const u = new URL(location.href); const on = u.searchParams.get("first") === "1"; if (on) { u.searchParams.delete("first"); history.replaceState(history.state, "", u.toString()); } return on; })(),
      join: async (code: string) => { if (!(await ensureGuest())) return; if (guest && !me) await refreshMe(); const r = await duelApi.join(code); if (r.ok) { trackFunnel("duel_join"); follow(r.room.id); } else api?.error(r.reason); },
      // Turbo funnel moments from the engine (lib/funnel TURBO_STEPS); anything else is ignored
      track: (k: string) => { if (isFunnelStep(k)) trackFunnel(k); },
      ready: async () => { const r = await op({ op: "ready" }); if (r.error) api?.error(r.error); },
      leave: async () => { const id = roomId; unfollow(); if (id) await duelApi.op(id, { op: "leave" }); },
      rematch: async () => { const r = await op({ op: "rematch" }); if (r.error) api?.error(r.error); },
      toLobby: () => { unfollow(); void refreshMe(); },
      trade: (action: TradeAction, usd: number) => op({ op: "trade", action, usd }),
      chat: (text: string) => op({ op: "chat", text }),
      report: async () => { if (!roomId) return { error: "Not in a duel." }; const r = await duelApi.op(roomId, { op: "report" }); return r.ok ? {} : { error: r.reason }; },
      trick: (kind: "spin" | "flip") => { void op({ op: "trick", kind }); },
      // the duel mute button also silences the game radio if it carried over from another screen
      myShip: () => lookOf(me, rival),
      shipOf: (pid: string) => lookOf(pid, me),
      mute: (m: boolean) => { try { const r = getGameRadio(); if (m) r.pause(); else r.clearPause(); } catch { /* no radio */ } },
    };

    loadEngine().then(() => {
      if (dead || !ref.current || !window.DuelEngine) return;
      api = window.DuelEngine.mount(ref.current, host);
      void refreshMe();
    }).catch(() => { if (ref.current) ref.current.textContent = "Couldn't load the duel. Refresh to try again."; });
    setDuelGuest(guest);
    const offPrivy = guest ? () => {} : onPrivy(() => { void refreshMe(); });

    return () => { dead = true; setDuelGuest(false); stopQueue(); unfollow(); stopPrice(); offPrivy(); api?.destroy(); };
  }, []);
  return <div ref={ref} />;
}
