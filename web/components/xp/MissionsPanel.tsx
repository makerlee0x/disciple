"use client";
/** Daily (and optionally weekly) missions with progress and the reset timer. Same 3 for every pilot each period. */
import { useEffect, useState, type ReactNode } from "react";
import { missionById, type MissionStatus, type XpSummary } from "@/lib/xp";
import { untilLabel } from "@/lib/xpClient";

function Mission({ m }: { m: MissionStatus }) {
  const pct = m.target ? Math.min(100, (m.progress / m.target) * 100) : 0;
  const usd = missionById(m.id)?.kind === "boost_usd";
  const count = m.target > 1 ? (usd ? `$${Math.floor(m.progress)} of $${m.target}` : `${Math.floor(m.progress)} of ${m.target}`) : null;
  return (
    <li className={`xp-mission${m.done ? " done" : ""}`} data-testid={`mission-${m.id}`}>
      <div className="xp-mission-top">
        <span className="xp-mission-title">{m.title}</span>
        <span className="xp-mission-xp">{m.done ? "Done" : `+${m.xp.toLocaleString("en-US")} XP`}</span>
      </div>
      <div className="dsc3-bar dsc3-bar-thin dsc3-bar-climb" role="progressbar" aria-valuemin={0} aria-valuemax={m.target} aria-valuenow={m.progress} aria-label={m.title}>
        <i style={{ width: `${pct}%` }} />
      </div>
      {count && !m.done && <span className="xp-mission-count">{count}</span>}
    </li>
  );
}

export default function MissionsPanel({ xp, weekly = false, title = "Daily missions", footer, className }: { xp: XpSummary | null; weekly?: boolean; title?: string; footer?: ReactNode; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  if (!xp) return null;
  return (
    <section className={`dsc3-panel xp-missions${className ? " " + className : ""}`} aria-label={title} data-testid="missions-panel">
      <header className="xp-missions-head">
        <h2 className="dsc3-h3">{title}</h2>
        <span className="xp-reset">New in {untilLabel(xp.daily.resetsAt, now)}</span>
      </header>
      <ul className="xp-mission-list">{xp.daily.missions.map((m) => <Mission key={m.id} m={m} />)}</ul>
      {weekly && (
        <>
          <header className="xp-missions-head xp-missions-head-week">
            <h2 className="dsc3-h3">Weekly missions</h2>
            <span className="xp-reset">New in {untilLabel(xp.weekly.resetsAt, now)}</span>
          </header>
          <ul className="xp-mission-list">{xp.weekly.missions.map((m) => <Mission key={m.id} m={m} />)}</ul>
        </>
      )}
      {footer}
    </section>
  );
}
