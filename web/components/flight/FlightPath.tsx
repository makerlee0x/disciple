"use client";
/* FLIGHT PATH (approved mockup "Desktop · Pilot HUD", Nov 12): Pilot's small altitude line, bottom right under the radio.
   The last 5 minutes of the engine's mark (disciple:mark), with the next zone as a dashed line. Pro shows the full
   ALTITUDE CHART instead, so this card is Pilot + desktop only. */
import { useEffect, useState } from "react";
import { useHudMode } from "@/lib/game/hudMode";
import { HUD } from "@/lib/game/hudStyle";
import { FLIGHT_TIERS, tierIndexAt } from "@/lib/flight/tiers";
import { isPhoneUI } from "@/lib/game/cardLayoutStore";

const WINDOW_MS = 5 * 60_000, STEP_MS = 2000, W = 250, H = 84;
type Pt = { t: number; m: number };

/** keep one sample per STEP_MS (the latest wins) inside the 5 minute window */
export function addSample(pts: Pt[], m: number, now = Date.now()): Pt[] {
  const keep = pts.filter((p) => now - p.t <= WINDOW_MS);
  const last = keep[keep.length - 1];
  if (last && now - last.t < STEP_MS) return [...keep.slice(0, -1), { t: last.t, m }];
  return [...keep, { t: now, m }];
}

export default function FlightPath() {
  const hud = useHudMode();
  const [pts, setPts] = useState<Pt[]>([]);
  const [phone, setPhone] = useState(false);
  useEffect(() => { const f = () => setPhone(isPhoneUI()); f(); addEventListener("resize", f); return () => removeEventListener("resize", f); }, []);
  useEffect(() => {
    const h = (e: Event) => { const m = Number((e as CustomEvent<{ mcap?: number }>).detail?.mcap); if (m > 0) setPts((p) => addSample(p, m)); };
    addEventListener("disciple:mark", h); return () => removeEventListener("disciple:mark", h);
  }, []);
  if (hud === "pro" || phone) return null;
  const cur = pts.length ? pts[pts.length - 1].m : 0;
  const next = cur > 0 ? FLIGHT_TIERS[tierIndexAt(cur) + 1] : undefined;
  const lo = pts.length ? Math.min(...pts.map((p) => p.m)) : 0, hi0 = pts.length ? Math.max(...pts.map((p) => p.m)) : 1;
  // the next zone's dashed line joins the plot only while the path still fills ≥ 35% of it (else the line reads flat)
  const hi = next && next.lo > hi0 && Math.max(hi0 - lo, hi0 * 0.01) / (next.lo - lo) >= 0.35 ? next.lo : hi0;
  const span = hi - lo || hi * 0.1 || 1, t0 = Date.now() - WINDOW_MS;
  const y = (m: number) => Math.round(H - 6 - ((m - lo) / span) * (H - 18));
  const x = (t: number) => Math.round(((t - t0) / WINDOW_MS) * W);
  const line = pts.map((p) => `${x(p.t)},${y(p.m)}`).join(" ");
  const nextY = next && next.lo <= hi ? y(next.lo) : null;
  const end = pts.length ? pts[pts.length - 1] : null;
  return (
    <div data-testid="flight-path" aria-label="Flight path, last 5 minutes" style={{ position: "fixed", right: 20, bottom: 20, width: 280, zIndex: 30, boxSizing: "border-box", padding: "12px 14px 10px",
      borderRadius: HUD.radius, background: HUD.glass, border: `1px solid ${HUD.border}`, color: HUD.text, fontFamily: HUD.ui, pointerEvents: "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ font: `700 14px/1 ${HUD.game}`, letterSpacing: "1.5px", color: HUD.champagne }}>FLIGHT PATH</span>
        <span style={{ font: `600 12px/1 ${HUD.game}`, letterSpacing: "1px", color: HUD.dim }}>5 MIN</span>
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block", marginTop: 6, overflow: "visible" }} aria-hidden>
        {nextY != null && <>
          <line x1={0} x2={W} y1={nextY} y2={nextY} stroke="rgba(243,223,168,.55)" strokeDasharray="3 4" />
          <text x={2} y={nextY - 5} fill="#F3DFA8" style={{ font: `700 10px ${HUD.game}`, letterSpacing: ".06em" }}>{next!.name}</text>
        </>}
        {pts.length > 1 && <polyline points={line} fill="none" stroke={HUD.up} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {end && <circle cx={x(end.t)} cy={y(end.m)} r={3.5} fill={HUD.gold} />}
        {!pts.length && <text x={0} y={H / 2} fill={HUD.dim} style={{ font: `12px ${HUD.ui}` }}>Waiting for the first trades…</text>}
      </svg>
    </div>
  );
}
