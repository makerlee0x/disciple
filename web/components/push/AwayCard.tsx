"use client";
/**
 * Lobby "Since you were away" (main mode hook loop mockup board "Notifications", maker 2026-11-13): what happened on
 * rockets you flew since your last visit (orbit with you aboard, orbit or a new zone after you left) and your aboard
 * streak, with a link to the logbook. Never prices, never "buy" or "win it back". Dismiss remembers this browser's
 * last look (localStorage: a per-viewer convenience; a blocked store just shows the last 3 days again).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { privyAccessToken } from "@/lib/aa/sessionState";
import { devSample } from "@/lib/devSample";
import type { LogEntry } from "@/lib/logbook";
import type { Streak } from "@/lib/streaks";
import { titleCase } from "@/components/logbook/LogbookView";
import s from "./away.module.css";

const SEEN = "dsc:away:seen";
const WINDOW = 3 * 86_400_000;
type Line = { key: string; ticker: string; text: string; tone: "gold" | "info"; at: number };

const readSeen = () => { try { return Number(localStorage.getItem(SEEN)) || 0; } catch { return 0; } };
const writeSeen = (t: number) => { try { localStorage.setItem(SEEN, String(t)); } catch { /* private mode */ } };

export function awayLines(entries: readonly LogEntry[], since: number): Line[] {
  const out: Line[] = [];
  for (const e of entries) {
    const n = e.news;
    if (!n || n.at <= since) continue;
    if (n.kind === "orbit_aboard") out.push({ key: e.coin, ticker: e.ticker, text: "reached orbit with you aboard", tone: "gold", at: n.at });
    else if (n.kind === "orbit_after") out.push({ key: e.coin, ticker: e.ticker, text: "reached orbit after you left", tone: "info", at: n.at });
    else if (n.kind === "zone_after") out.push({ key: e.coin, ticker: e.ticker, text: `crossed the ${titleCase(n.zone ?? "")} after you left`, tone: "info", at: n.at });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 3);
}

export default function AwayCard({ wallet }: { wallet: string | null }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [streak, setStreak] = useState(0);
  const [gone, setGone] = useState(false);
  const sample = process.env.NODE_ENV === "development" && devSample();
  useEffect(() => {
    let alive = true;
    const since = Math.max(readSeen(), Date.now() - WINDOW);
    if (sample) {
      import("@/lib/mock/hookLoop").then((m) => { setLines(awayLines(m.sampleLogbook().entries, 0)); setStreak(m.sampleStreaks().aboard.current); });
      return;
    }
    if (!wallet) return;
    (async () => {
      const token = await privyAccessToken().catch(() => null);
      if (!token) return;
      const h = { authorization: `Bearer ${token}` };
      const [lb, st] = await Promise.all([
        fetch(`/api/logbook?wallet=${wallet}&peek=1`, { headers: h, cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<{ entries?: LogEntry[] } | null>,
        fetch(`/api/streaks?wallet=${wallet}`, { headers: h, cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<{ aboard?: Streak } | null>,
      ]);
      if (!alive) return;
      setLines(awayLines(lb?.entries ?? [], since));
      setStreak(st?.aboard?.current ?? 0);
    })();
    return () => { alive = false; };
  }, [wallet, sample]);

  if (gone || lines.length === 0) return null;
  return (
    <section className={s.card} aria-labelledby="away-h" data-testid="away-card">
      <div className={s.top}>
        <h2 id="away-h" className={s.h}>Since you were away</h2>
        <button type="button" className={s.x} aria-label="Dismiss" onClick={() => { writeSeen(Date.now()); setGone(true); }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      {lines.map((l) => <div key={l.key} className={s.line}><span className={l.tone === "gold" ? s.gold : s.info}>${l.ticker}</span> {l.text}</div>)}
      {streak >= 2 && <div className={s.line}>Aboard streak: <span className={s.gold}>{streak} days</span></div>}
      <Link href={sample ? "/logbook?sample=1" : "/logbook"} className={s.link} onClick={() => writeSeen(Date.now())}>Open your logbook</Link>
    </section>
  );
}
