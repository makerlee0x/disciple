"use client";
/**
 * In-flight objective card (approved prototype "Flight feel", maker Nov 13): today's and this week's missions from /api/xp,
 * under the ALTITUDE card, the next unfinished one highlighted. Progress comes from the server (the cron scores the fills);
 * the engine adds live hints for the two missions that play out in seconds (disciple:objlive): "Start a run" counts the
 * pilots who boosted after you, "Hold through a bomb" counts down the 10 minutes. A hint never pays: the card says
 * "confirming" until the server agrees. Pilot HUD on desktop only (Pro keeps YOUR BAG in this slot; phones have the pill).
 */
import { useEffect, useMemo, useState } from "react";
import { HUD, hudCard, hudLabel } from "@/lib/game/hudStyle";
import { useHudMode } from "@/lib/game/hudMode";
import { usePilotWallet, useXp } from "@/lib/xpClient";
import { dayPeriod, missionById, missionsFor, weekPeriod, type MissionKind, type MissionStatus } from "@/lib/xp";

const NEW_KINDS = new Set<MissionKind>(["start_run", "first_crew", "hold_bomb", "cash_out_higher"]);
const ROWS = 3, NARROW = 760;
type Live = { run: { n: number; until: number } | null; hold: { until: number } | null };

const mmss = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s} s`; };

function hint(m: MissionStatus, kind: MissionKind | undefined, live: Live, aboard: boolean, now: number): { sub: string; f: number; localDone?: boolean } {
  const f = m.target > 0 ? m.progress / m.target : 0;
  switch (kind) {
    case "start_run": {
      const r = live.run && live.run.until > now ? live.run : null;
      if (r && r.n >= 3) return { sub: "3 pilots followed you", f: 1, localDone: true };
      return r ? { sub: `${r.n} of 3 pilots followed you · ${mmss(r.until - now)}`, f: r.n / 3 } : { sub: "Boost, then 3 pilots boost within 60 s", f };
    }
    case "hold_bomb": {
      const h = live.hold;
      if (h && h.until <= now) return { sub: "Held through it", f: 1, localDone: true };
      if (h) return { sub: `Bomb hit. Stay aboard ${mmss(h.until - now)} more`, f: 1 - (h.until - now) / 600_000 };
      return { sub: aboard ? "Aboard. Waiting for a 5%+ dump" : "Board, then survive a 5%+ dump", f };
    }
    case "first_crew": return { sub: "Boost a rocket before its 10th pilot", f };
    case "cash_out_higher": return { sub: "Ride up a tier, then sell half or more above your entry", f };
    case "ride_tier": return { sub: aboard ? "Stay aboard to the next altitude" : "Board and ride a rocket up one altitude", f };
    case "boost_rockets": return { sub: `${m.progress} of ${m.target} rockets boosted`, f };
    case "boost_usd": return { sub: `$${m.progress} of $${m.target} boosted`, f };
    case "boost_modes": return { sub: `${m.progress} of 3 modes boosted`, f };
    case "boost_fresh": return { sub: "Boost a rocket launched under an hour ago", f };
    case "drop_bomb": return { sub: "Dump 2%+ after 10 minutes aboard", f };
    case "hold_24h": return { sub: "Keep $25+ of one rocket for a day", f };
    case "launch": return { sub: "Launch your own rocket", f };
    case "orbit_aboard": return { sub: "Be aboard when a rocket reaches orbit", f };
    default: return { sub: "", f };
  }
}

export default function FlightObjectives({ replay, practice }: { replay: boolean; practice: boolean }) {
  const hud = useHudMode();
  const wallet = usePilotWallet();
  const { xp } = useXp(wallet);
  const [live, setLive] = useState<Live>({ run: null, hold: null });
  const [aboard, setAboard] = useState(false);
  const [top, setTop] = useState(160);
  const [narrow, setNarrow] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const onLive = (e: Event) => { const d = (e as CustomEvent<Live>).detail; if (d) setLive({ run: d.run ?? null, hold: d.hold ?? null }); };
    const onPos = (e: Event) => setAboard(((e as CustomEvent<{ size?: number }>).detail?.size ?? 0) > 0);
    const onCol = (e: Event) => { const b = Number((e as CustomEvent<{ hdrB?: number }>).detail?.hdrB); if (b > 0) setTop(Math.round(b) + 12); };
    const onSize = () => setNarrow(innerWidth <= NARROW);
    onSize();
    addEventListener("disciple:objlive", onLive); addEventListener("disciple:position", onPos); addEventListener("disciple:hudcol", onCol); addEventListener("resize", onSize);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { removeEventListener("disciple:objlive", onLive); removeEventListener("disciple:position", onPos); removeEventListener("disciple:hudcol", onCol); removeEventListener("resize", onSize); clearInterval(t); };
  }, []);

  // today's + this week's missions; signed out = the same draw at zero progress
  const missions = useMemo(() => {
    const blank = (ms: ReturnType<typeof missionsFor>): MissionStatus[] => ms.map((m) => ({ id: m.id, title: m.title, xp: m.xp, progress: 0, target: m.target, done: false }));
    return xp ? [...xp.daily.missions, ...xp.weekly.missions] : [...blank(missionsFor(dayPeriod(now))), ...blank(missionsFor(weekPeriod(now)))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xp, Math.floor(now / 3600_000)]);

  if (replay || narrow || hud === "pro" || !missions.length) return null;

  const rows = missions.map((m) => { const kind = missionById(m.id)?.kind; return { m, kind, ...hint(m, kind, live, aboard, now) }; });
  // unfinished first (today before this week), finished after; three rows
  const shown = [...rows.filter((r) => !r.m.done && !r.localDone), ...rows.filter((r) => r.m.done || r.localDone)].slice(0, ROWS);
  const main = shown.find((r) => !r.m.done && !r.localDone);

  return (
    <aside aria-label="Flight objectives" data-testid="flight-objectives"
      style={{ ...hudCard, position: "fixed", top, left: "calc(var(--ap-rail-w, 64px) + 20px)", zIndex: 30, width: 300, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, backdropFilter: "blur(6px)", pointerEvents: "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span style={{ ...hudLabel, fontSize: 12 }}>Flight objectives</span>
        <span style={{ font: `500 11px/1.3 ${HUD.ui}`, color: HUD.dim }}>{practice ? "Practice · counts on live rockets" : wallet ? "XP lands in ~2 min" : "Sign in to earn XP"}</span>
      </div>
      {shown.map(({ m, kind, sub, f, localDone }) => {
        const done = m.done || !!localDone, isMain = main?.m.id === m.id;
        return (
          <div key={m.id} data-mission={m.id}
            style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 9px", borderRadius: 9, transition: "border-color .3s, background .3s",
              background: done ? "rgba(95,240,160,.08)" : isMain ? "rgba(242,193,78,.07)" : "rgba(255,255,255,.04)",
              border: `1px solid ${done ? "rgba(95,240,160,.5)" : isMain ? "rgba(242,193,78,.4)" : "transparent"}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <span style={{ font: `700 16px/1.05 ${HUD.game}`, letterSpacing: ".02em", color: HUD.text }}>{m.title}</span>
              <span style={{ font: `700 13px/1 ${HUD.game}`, color: done ? HUD.up : HUD.gold, whiteSpace: "nowrap" }}>+{m.xp} XP{kind && NEW_KINDS.has(kind) ? " · new" : ""}</span>
            </div>
            <div style={{ font: `500 11px/1.3 ${HUD.ui}`, color: HUD.dim }}>{done ? (m.done ? "Done · XP added" : "Done · confirming") : sub}</div>
            <div aria-hidden="true" style={{ height: 4, borderRadius: 3, background: "rgba(255,255,255,.12)", overflow: "hidden", marginTop: 2 }}>
              <i style={{ display: "block", height: "100%", width: `${Math.round(Math.max(0, Math.min(1, done ? 1 : f)) * 100)}%`, background: done ? HUD.up : HUD.gold, transition: "width .4s" }} />
            </div>
          </div>
        );
      })}
    </aside>
  );
}
