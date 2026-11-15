"use client";
/* Flight sounds for the main trading flight (recorded CC0 pack, lib/game/sfx). The engine fires disciple:sfx {k}:
     ignite  a BOOST (boost_small, boost_big from $50) or a DUMP (bomb_fall) press
     fill    the trade landed (trade_fill_buy / trade_fill_sell)        fail   it didn't (tx_fail)
     bomb    a dump bomb goes off, by tier: GRENADE … NUKE (bomb_grenade … nuke)
     zone    a new tier (zone_up); tier 0 = wingmen drafting in (crew_join)
     trick   spin / flip (trick_whoosh)                                 orbit  you reached orbit (ath_reached)
   and, while disciple:thrustsfx is on, ~10×/s disciple:thrust {v, pending}: the engine hum follows the flame, and soft
   blips loop while a trade is pending. The ambience bed is wind (AppSounds), and turns to the thin-air hum at orbit.
   All of it runs at the Sound effects level from Settings. */
import { useEffect } from "react";
import { playSfx, setBed, startLoop, type LoopHandle } from "@/lib/game/sfx";

const BOMBS = ["bomb_grenade", "bomb_bunker", "bomb_warhead", "bomb_moab", "bomb_atom", "nuke"];

export default function FlightSfx() {
  useEffect(() => {
    let hum: LoopHandle | null = null, pend: LoopHandle | null = null, humV = -1, pendOn = false;
    const on = (e: Event) => {
      const d = ((e as CustomEvent).detail || {}) as { k?: string; side?: string; usd?: number; tier?: number };
      switch (d.k) {
        case "ignite": playSfx(d.side === "sell" ? "bomb_fall" : (d.usd || 0) >= 50 ? "boost_big" : "boost_small", { gapMs: 40 }); break;
        case "fill": playSfx(d.side === "sell" ? "trade_fill_sell" : "trade_fill_buy", { gapMs: 40 }); break;
        case "fail": playSfx("tx_fail"); break;
        case "bomb": playSfx(BOMBS[Math.max(0, Math.min(BOMBS.length - 1, d.tier || 0))], { gapMs: 30 }); break;
        case "zone": playSfx(d.tier ? "zone_up" : "crew_join"); break;
        case "trick": playSfx("trick_whoosh"); break;
        case "orbit": playSfx("ath_reached"); setBed("amb_orbit_hum"); break;
      }
    };
    const onThrust = (e: Event) => {
      const d = ((e as CustomEvent).detail || {}) as { v?: number; pending?: number };
      const v = Math.round((0.14 + 0.22 * Math.max(0, Math.min(1, d.v || 0))) * 40) / 40;
      if (!hum) hum = startLoop("engine_loop");
      if (v !== humV) { humV = v; hum.set(v, 0.9 + 0.35 * (d.v || 0)); }
      const p = !!d.pending;
      if (p !== pendOn) {
        pendOn = p;
        if (p) { pend = startLoop("tx_pending"); pend.set(0.5); } else { pend?.stop(); pend = null; }
      }
    };
    addEventListener("disciple:sfx", on);
    addEventListener("disciple:thrust", onThrust);
    const ask = () => dispatchEvent(new CustomEvent("disciple:thrustsfx", { detail: { on: true } }));
    ask(); const iv = setInterval(ask, 2000);   // the engine script may load after this mounts
    return () => {
      clearInterval(iv);
      removeEventListener("disciple:sfx", on);
      removeEventListener("disciple:thrust", onThrust);
      dispatchEvent(new CustomEvent("disciple:thrustsfx", { detail: { on: false } }));
      hum?.stop(); pend?.stop();
    };
  }, []);
  return null;
}
