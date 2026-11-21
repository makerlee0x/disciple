"use client";
/**
 * /turbo/duel: Trading Duel. The screens (lobby, search, invite, ready check, the race, result) are the signed-off
 * prototype, shipped as public/turbo/duel/engine.js (window.DuelEngine). This component is its host: it does every
 * server call (lib/duel/client), feeds live BTC from the Turbo adapter, and passes the room's events through.
 * Practice bots run inside the engine and are always labelled as bots.
 */
import { mountTurboPill } from "@/lib/turbo/turboPill";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DuelPilots, { type PilotsHost } from "./DuelPilots";
import LobbySettings from "@/components/turbo/LobbySettings";
import { getTurboAdapter } from "@/lib/turbo";
import { onPrivy, privyAccessToken, privyAuthenticated, privyLogin } from "@/lib/aa/sessionState";
import { duelApi, followRoom, setDuelGuest, type Follow, type RoomRes, type Res } from "@/lib/duel/client";
import { DUEL_LEN_MS, parseCode, type LengthMs, type TierId, type TradeAction } from "@/lib/duel/rules";
import { trackFunnel } from "@/lib/funnelClient";
import { isFunnelStep } from "@/lib/funnel";
import { climbingNow, type HomeData } from "@/lib/home/trending";
import { DUEL_RANKED_LIVE, LEAGUES } from "@/lib/duel/season";
import { flightHref, pct } from "@/components/home/rocketBits";
import type { DuelEvent, DuelRoom } from "@/lib/duel/types";
import { getGameRadio } from "@/lib/game/radio";
import { EARN, RARITY_COLOR, RARITY_NAME, TRAILS, crateArt, frozenOf, itemById, trailId, type Opened } from "@/lib/collection";
import { COLLECTION_CHANGED_EVENT } from "@/lib/collectionClient";
import { withBase } from "@/lib/base-path";
import { DUEL_SKIES, EXTRA_SKIES, loadDuelEngine } from "./engineLoader";
import { LighterMatch, cashNote, lighterCash, lighterFetcher, lighterWanted } from "@/lib/lighter/duel";
import GeoBanner from "@/components/turbo/GeoBanner";
import { mountRealSwitch } from "@/lib/turbo/realSwitch";
import { FEE, LEV, PCTS, pctUsd, fuelOf, TIERS } from "@/lib/duel/rules";

const trailRgb = (id?: string) => TRAILS.find((t) => trailId(t.id) === id)?.rgb;
import { useTurboMusic } from "@/lib/game/turboMusic";
import { lighterPriceHost } from "@/lib/turbo/priceVenue";
import { streamLighterMids } from "@/lib/turbo/royalePrices";

type Tick = { ts: number; p: number };
interface EngineApi {
  /** real orders on Lighter for this match: hides the SIMULATOR pill in flight */
  real?(on: boolean): void;
  price(p: number, ts: number): void;
  setMe(rec: { w: number; l: number; rating: number; streak: number } | null, signed: boolean): void;
  setClock(serverNow: number): void;
  searching(waitedMs: number, window: number, botOffer: boolean): void;
  invite(code: string, url: string, share?: string): void;
  room(r: DuelRoom, me: string): void;
  event(e: DuelEvent): void;
  error(t: string): void;
  toLobby(): void;
  firstCrate(d: FirstCrate | null): void;
  destroy(): void;
}
declare global { interface Window { DuelEngine?: { mount(root: HTMLElement, host: unknown): EngineApi } } }

/** the first-win crate on the result card (engine firstCrate) */
type FirstCrate = { state: "locked" | "opened"; crate: string; open?: string; item?: string; name?: string; rar?: string; kind?: string; color?: string };
/** "1" = a first win is waiting for its crate (signed out when it happened); "done" = the welcome crate is open */
const FIRST_WIN_KEY = "disciple.firstwin.v1";
const fwGet = () => { try { return localStorage.getItem(FIRST_WIN_KEY); } catch { return "done"; } };
const fwSet = (v: string) => { try { localStorage.setItem(FIRST_WIN_KEY, v); } catch { /* private mode */ } };
const KIND: Record<string, string> = { skin: "Skin", trail: "Trail", tag: "Name tag", flourish: "Win flourish" };

const SKIES = DUEL_SKIES;
const loadEngine = loadDuelEngine;

/** REMATCH with no answer for this long: the rival gets a duel request push instead (they probably left). */
const REMATCH_PUSH_MS = 20_000;

/** `guest`: the duel-only demo page (/duel). No sign-in: a guest pilot from /api/duel/guest, bots and friend links only. */
export default function DuelScreen({ guest = false, embed = false }: { guest?: boolean; embed?: boolean } = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const [gear, setGear] = useState(false);
  // bumped by the Simulator / Real money switch: the duel is set up again in place, no page reload
  const [run, setRun] = useState(0);
  // friends + rivals (DuelPilots), portalled into the engine's VS FRIEND pane once a signed-in pilot is known
  const [pilots, setPilots] = useState<{ slot: HTMLElement; host: PilotsHost } | null>(null);
  const pilotsHost = useRef<PilotsHost | null>(null);
  useTurboMusic();
  useEffect(() => {
    let dead = false, api: EngineApi | null = null, me: string | null = null, myName: string | null = null, roomId: string | null = null;
    let rematchT: ReturnType<typeof setTimeout> | null = null;
    let fol: Follow | null = null, qTimer: ReturnType<typeof setTimeout> | null = null, queued: { tier: TierId; len: LengthMs; casual: boolean } | null = null;
    let pendingCode = parseCode(new URLSearchParams(location.search).get("c"));
    // /turbo/duel?request=<pilot> (from /vs/<pilot> when they're not waiting): open a friend room and ping them to join it
    let pendingRequest = (() => { const v = new URLSearchParams(location.search).get("request"); return v && /^[a-z0-9_]{1,42}$/i.test(v) ? v.toLowerCase() : null; })();
    const hist: Tick[] = [];

    // live BTC, kept 90 s back so the chart is full when a duel starts
    // When the duel server scores on Lighter (lib/server/duel/price), the chart is Lighter's BTC too, so both match
    const onTick = (price: number, at: number) => {
      const ts = at || Date.now(); hist.push({ ts, p: price });
      while (hist.length && hist[0].ts < ts - 90_000) hist.shift();
      api?.price(price, ts);
    };
    let pxDead = false, stopPx = () => {};
    void lighterPriceHost().then((h) => {
      if (pxDead) return;
      stopPx = h ? streamLighterMids((m) => { if (m.BTC) onTick(m.BTC, Date.now()); }, h) : getTurboAdapter().subscribePrice("BTC", (t) => onTick(t.price, t.ts));
    });
    const stopPrice = () => { pxDead = true; stopPx(); };

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
    // Lighter (hidden, ?lighter=1): each press is also a real order on the pilot's own Lighter account (lib/lighter/duel)
    const lighterOn = !guest && lighterWanted();
    let lx: LighterMatch | null = null, lxFor: string | null = null, lxStatus: string | null = null, lxBombs: number | null = null;
    // button i → $ of fuel, the way the engine sizes a press (ALL keeps the fee back, like rules openStep)
    const sizesFor = (fuel: number) => PCTS.map((p) => (p === 0 ? fuel / (1 + LEV * FEE) : pctUsd(p, fuel)));
    /** real money: Turbo cash must cover the match before it starts (lib/lighter/duel lighterCash) */
    const covered = async (fuel: number | undefined) => {
      if (!lighterOn || !me || !fuel) return true;
      const c = await lighterCash(lighterFetcher(me), fuel, LEV);
      if (!c.ok) api?.error(cashNote(c.need));
      return c.ok;
    };
    const lighterRoom = async (room: DuelRoom) => {
      if (!lighterOn || !me) return;
      const book = room.books[me];
      if ((room.status === "lobby" || room.status === "live") && lxFor !== room.id) {
        lx?.stop(); lx = null; lxFor = room.id; lxBombs = null; api?.real?.(false);
        const f = lighterFetcher(me);
        if (!(await LighterMatch.ready(f))) { if (lxStatus !== "no") { lxStatus = "no"; api?.error(await LighterMatch.notReadyWhy(f)); } return; }
        // a joined link skips the lobby check: still never trade real money the NUKE can't close before Lighter liquidates
        const cash = await lighterCash(f, book?.fuel ?? fuelOf(room), LEV);
        if (!cash.ok) { api?.error(cashNote(cash.need)); return; }
        if (lxFor !== room.id || dead) return;
        lx = new LighterMatch(f, "BTC", sizesFor, book?.fuel ?? fuelOf(room)); lx.start(); lxStatus = "on";
        api?.real?.(true);   // the flight's SIMULATOR pill comes off only now (maker 2026-11-20)
        void lx.arm("duel", room.id); // the duel's own buzzer closes the real position server-side
      }
      if (lx && book) {
        // a NUKE is a liquidation: the server's book dropped the position, so the real one closes too, fully
        if (lxBombs != null && book.bombs > lxBombs && room.status === "live") void lx.closeAll();
        lxBombs = book.bombs;
        lx.fuel(book.fuel);
      }
      if (lx && (room.status === "done" || room.status === "cancelled")) { const x = lx; lx = null; lxFor = null; api?.real?.(false); await x.closeAll(); x.stop(); }
    };
    const unfollow = () => {
      if (rematchT) { clearTimeout(rematchT); rematchT = null; } fol?.stop(); fol = null; roomId = null;
      api?.real?.(false);
      if (lx) { const x = lx; lx = null; lxFor = null; void x.closeAll().finally(() => x.stop()); }
    };
    const follow = (id: string) => {
      if (roomId === id) return; unfollow(); roomId = id;
      fol = followRoom(id, (e) => api?.event(e), (room, now) => {
        if (dead || !me) return;
        void loadShips(room.players.map((p) => p.pid));
        rival = room.players.find((p) => p.pid !== me)?.pid ?? null; api?.setClock(now); api?.room(room, me);
        void lighterRoom(room);
        if (room.status === "done" && room.rematch?.roomId && room.rematch.roomId !== id) follow(room.rematch.roomId);
        if (room.status === "cancelled") unfollow();
      });
    };
    const stopQueue = () => { if (qTimer) clearTimeout(qTimer); qTimer = null; const q = queued; queued = null; return q; };
    const pollQueue = async () => {
      if (!queued || dead) return;
      const r = await duelApi.poll(queued.tier, queued.len, queued.casual);
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
      if (!guest && !privyAuthenticated()) { me = null; setPilots(null); api?.setMe(null, false); if (pendingRequest) api?.error(`Sign in to send @${pendingRequest} a duel request.`); return; }
      const r = await duelApi.me();
      if (dead) return;
      if (!r.ok) { me = null; setPilots(null); api?.setMe(null, false); return; }
      if (!guest && ref.current && pilotsHost.current) {
        const pane = ref.current.querySelector<HTMLElement>('[data-pane="friend"]:not(.budget)');
        let slot = pane?.querySelector<HTMLElement>(".dp-slot") ?? null;
        if (pane && !slot) { slot = document.createElement("div"); slot.className = "dp-slot"; pane.appendChild(slot); }
        if (slot) { const host = pilotsHost.current; setPilots((p) => (p?.slot === slot ? p : { slot: slot!, host })); }
      }
      me = r.pid; myName = r.name; void loadShips([r.pid]); if (fwGet() === "1") void claimFirstWin(); api?.setMe({ w: r.rating.w, l: r.rating.l, rating: r.rating.r, streak: r.rating.streak }, true);
      if (r.active) follow(r.active.id);
      else if (pendingCode) { const c = pendingCode; pendingCode = null; const j = await duelApi.join(c); if (j.ok) { trackFunnel("duel_join"); follow(j.room.id); } else api?.error(j.reason); }
      else if (pendingRequest) { const to = pendingRequest; pendingRequest = null; await requestDuel(to); }
    };
    /** open a friend room and ping `to` (a username or wallet) to join it: /vs/<pilot>'s request, and DUEL on a friend or rival */
    const requestDuel = async (to: string) => {
      const inv = await duelApi.invite("pro", DUEL_LEN_MS);
      if (!inv.ok) { api?.error(inv.reason); return; }
      api?.invite(inv.code, location.origin + inv.path, inv.share ? location.origin + inv.share : undefined); follow(inv.room.id);
      const sent = await duelApi.request(to, inv.code);
      trackFunnel("duel_request");
      if (!sent.ok) api?.error(sent.reason);
    };
    pilotsHost.current = {
      challenge: (slug: string) => { void requestDuel(slug); },
      join: (code: string) => { void host.join(code); },
    };
    // the welcome crate pays on the pilot's first win (lib/server/collection firstWinCrate) and opens on the result card
    let claiming = false;
    const claimFirstWin = async () => {
      if (claiming || guest || fwGet() === "done" || !privyAuthenticated()) return;
      claiming = true;
      try {
        const t = await privyAccessToken();
        if (!t) return;
        const r = await fetch(withBase("/api/collection"), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t}` }, body: JSON.stringify({ op: "firstwin" }) });
        const j = (await r.json().catch(() => null)) as { ok?: boolean; reason?: string; opened?: Opened } | null;
        if (j?.ok && j.opened) {
          fwSet("done"); dispatchEvent(new Event(COLLECTION_CHANGED_EVENT));
          const o = j.opened, it = o.item ? itemById(o.item.id) ?? o.item : null;
          const art = it ? frozenOf(it).art.split(" ")[0] : "";
          api?.firstCrate({ state: "opened", crate: withBase(crateArt(o.crate.tier)), open: withBase(crateArt(o.crate.tier, true)),
            item: art && it?.kind !== "flourish" ? withBase(art) : undefined, name: it?.name ?? "Nothing this time",
            rar: it ? RARITY_NAME[it.rar] : RARITY_NAME[o.crate.tier], kind: it ? KIND[it.kind] : undefined, color: it ? RARITY_COLOR[it.rar] : undefined });
        } else if (j?.reason === "claimed") { fwSet("done"); api?.firstCrate(null); }
      } catch { /* the crate waits for the next win */ } finally { claiming = false; }
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
      // the share card's "@NAME WON" (engine shareCard); null signed out
      myName: () => (me ? myName : null),
      league: (id: string) => LEAGUES.find((l) => l.id === id) ?? null,
      assets: { ...Object.fromEntries(["rocket", ...SKIES].map((k) => [k, `/turbo/duel/${k}.webp`])), ...EXTRA_SKIES, art: "/art/modes/duel.webp" },
      history: () => hist.filter((h) => h.ts > Date.now() - 60_000),
      guest,
      embed,
      signIn: () => { if (guest) { guestReady = false; void refreshMe(); return; } try { privyLogin(); } catch (e) { api?.error((e as Error).message); } },
      quickMatch: async (tier: TierId, len: LengthMs, casual?: boolean) => {
        if (!(await covered(TIERS[tier]?.fuel))) return;
        stopQueue(); queued = { tier, len, casual: !!casual }; void pollQueue();
      },
      cancelSearch: () => { const q = stopQueue(); if (q) void duelApi.cancel(q.tier, q.len, q.casual); },
      createLink: async (tier: TierId, len: LengthMs, fuel?: number) => {
        if (!(await ensureGuest())) return;
        if (guest && !me) await refreshMe();
        if (!(await covered(fuel ?? TIERS[tier]?.fuel))) return;
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
      rankedLive: DUEL_RANKED_LIVE,
      first: (() => { const u = new URL(location.href); const on = u.searchParams.get("first") === "1"; if (on) { u.searchParams.delete("first"); history.replaceState(history.state, "", u.toString()); } return on; })(),
      join: async (code: string) => { if (!(await ensureGuest())) return; if (guest && !me) await refreshMe(); const r = await duelApi.join(code); if (r.ok) { trackFunnel("duel_join"); follow(r.room.id); } else api?.error(r.reason); },
      // Turbo funnel moments from the engine (lib/funnel TURBO_STEPS); anything else is ignored
      track: (k: string) => { if (isFunnelStep(k)) trackFunnel(k); },
      ready: async () => { const r = await op({ op: "ready" }); if (r.error) api?.error(r.error); },
      leave: async () => { const id = roomId; unfollow(); if (id) await duelApi.op(id, { op: "leave" }); },
      rematch: async () => {
        const r = await op({ op: "rematch" }); if (r.error) { api?.error(r.error); return; }
        // rematch push (launch funnel item 11): if the rival hasn't tapped REMATCH in 20 s they've likely left, so open a
        // friend room and send them a duel request push (the same /api/duel/request as /vs/<pilot>), which opens that room
        const from = roomId, them = rival;
        if (guest || !from || !them || !/^0x[0-9a-f]{40}$/i.test(them)) return;
        if (rematchT) clearTimeout(rematchT);
        rematchT = setTimeout(async () => {
          rematchT = null;
          if (dead || roomId !== from) return;   // the rematch started (follow moved on) or the pilot left the result card
          const inv = await duelApi.invite("pro", DUEL_LEN_MS);
          if (!inv.ok || dead) return;
          api?.invite(inv.code, location.origin + inv.path, inv.share ? location.origin + inv.share : undefined); follow(inv.room.id);
          const sent = await duelApi.request(them, inv.code);
          if (sent.ok) trackFunnel("duel_request");
        }, REMATCH_PUSH_MS);
      },
      toLobby: () => { unfollow(); void refreshMe(); },
      // i = size button, fuelAfter = the fuel the screen shows after the press (both only used for the Lighter order)
      trade: async (action: TradeAction, usd: number, i?: number, fuelAfter?: number) => {
        const real = lx && typeof i === "number" && i >= 0 ? lx.press(action, i, fuelAfter ?? 0) : null;
        const r = await op({ op: "trade", action, usd });
        if (real) void real.then((x) => { if ("error" in x) api?.error(x.error); });
        return r;
      },
      chat: (text: string) => op({ op: "chat", text }),
      report: async () => { if (!roomId) return { error: "Not in a duel." }; const r = await duelApi.op(roomId, { op: "report" }); return r.ok ? {} : { error: r.reason }; },
      trick: (kind: "spin" | "flip") => { void op({ op: "trick", kind }); },
      // the duel mute button also silences the game radio if it carried over from another screen
      // engine showResult on a win (bot or ranked): the first one drops the welcome crate on the result card
      won: () => {
        if (guest || fwGet() === "done") return;
        fwSet("1");
        if (privyAuthenticated() && me) void claimFirstWin();
        else api?.firstCrate({ state: "locked", crate: withBase(crateArt(EARN.welcome)) });
      },
      myShip: () => lookOf(me, rival),
      shipOf: (pid: string) => lookOf(pid, me),
      mute: (m: boolean) => { try { const r = getGameRadio(); if (m) r.pause(); else r.clearPause(); } catch { /* no radio */ } },
      settings: () => setGear(true),   // the lobby gear (components/turbo/LobbySettings)
    };

    let offSwitch = () => {};
    let offPill = () => {};   // Turbo cash pill in the lobby header (lib/turbo/turboPill)
    loadEngine().then(() => {
      if (dead || !ref.current || !window.DuelEngine) return;
      api = window.DuelEngine.mount(ref.current, host);
      if (!guest) offSwitch = mountRealSwitch(ref.current, () => setRun((n) => n + 1));
      if (!guest) offPill = mountTurboPill(ref.current);
      void refreshMe();
    }).catch(() => { if (ref.current) ref.current.textContent = "Couldn't load the duel. Refresh to try again."; });
    setDuelGuest(guest);
    const offPrivy = guest ? () => {} : onPrivy(() => { void refreshMe(); });

    return () => { dead = true; pilotsHost.current = null; setPilots(null); offSwitch(); offPill(); setDuelGuest(false); stopQueue(); unfollow(); stopPrice(); offPrivy(); api?.destroy(); };
  }, [run]);
  return <><GeoBanner /><div ref={ref} /><LobbySettings mode="duel" open={gear} onClose={() => setGear(false)} />{pilots && createPortal(<DuelPilots host={pilots.host} />, pilots.slot)}</>;
}
