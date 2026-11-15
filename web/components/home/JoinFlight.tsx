"use client";
/**
 * Join a flight (maker 2026-11-15): today's #1 rocket by 24h volume, as a cinematic card. The launch/live art plate behind,
 * a live market-cap chart of its last 24h (indexed fills, /api/trades, polled), the crew that's been trading it (profile
 * pictures where set, else their light colour), and Drop in. The whole card opens the flight. Nothing flying: the same
 * plate, pointing at Host a launch and Free play. No sprite here (sprite only in flight).
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { withBase } from "@/lib/base-path";
import { rankTrending, tierProgress, type HomeCoin } from "@/lib/home/trending";
import { fetchProfileMeta } from "@/lib/profileMetaClient";
import { pfpUrl } from "@/lib/profileMeta";
import { altShort, flightHref, lightOf, lit, Mark, orbitPct, pct } from "./rocketBits";
import s from "./joinFlight.module.css";

const ART = "/art/launch/live.webp";
const POLL_MS = 10_000;
const DAY = 864e5;
const FACES = 5;

type Pt = { t: number; v: number };
type Fill = { ts: number; mcapUsd: number; trader: string };

/** #1 by 24h volume among live rockets; no volume anywhere ⇒ the newest live one. */
export function pickJoin(coins: HomeCoin[]): HomeCoin | null {
  const live = coins.filter((c) => !c.graduated);
  return rankTrending(live)[0] ?? [...live].sort((a, b) => b.block - a.block)[0] ?? null;
}

/** last-24h mcap points (oldest first) + the latest traders (newest first, unique) */
function useLive(c: HomeCoin | null) {
  const [pts, setPts] = useState<Pt[] | null>(null);
  const [crew, setCrew] = useState<string[]>([]);
  const token = c?.token ?? "";
  useEffect(() => {
    if (!token) return;
    let alive = true;
    setPts(null); setCrew([]);
    const read = () =>
      fetch(withBase(`/api/trades?coin=${token}&order=desc&limit=600`))
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { fills?: Fill[] } | null) => {
          if (!alive || !j?.fills) return;
          const desc = [...j.fills].sort((a, b) => b.ts - a.ts);
          const from = Date.now() - DAY;
          const day = desc.filter((f) => f.ts >= from && f.mcapUsd > 0);
          setPts(day.reverse().map((f) => ({ t: f.ts, v: f.mcapUsd })));
          const seen = new Set<string>(); const who: string[] = [];
          for (const f of desc) { const a = f.trader?.toLowerCase(); if (a && !seen.has(a)) { seen.add(a); who.push(a); if (who.length >= FACES) break; } }
          setCrew(who);
        })
        .catch(() => {});
    read();
    const id = setInterval(() => { if (document.visibilityState === "visible") read(); }, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [token]);
  return { pts, crew };
}

function Face({ a }: { a: string }) {
  const [img, setImg] = useState("");
  useEffect(() => { let on = true; fetchProfileMeta(a).then((m) => { if (on) setImg(pfpUrl(m.pfp)); }).catch(() => {}); return () => { on = false; }; }, [a]);
  return (
    <i className={s.face} style={{ background: lightOf(a) }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {img ? <img src={withBase(img)} alt="" loading="lazy" decoding="async" /> : null}
    </i>
  );
}

const W = 600, H = 180;
function Chart({ pts }: { pts: Pt[] }) {
  const path = useMemo(() => {
    if (pts.length < 2) return null;
    const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
    const pad = (hi - lo || hi * 0.1 || 1) * 0.12;
    lo -= pad; hi += pad;
    const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
    const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
    // a step line: mcap only moves on a trade
    let d = `M0 ${y(pts[0].v).toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].t).toFixed(1)} V${y(pts[i].v).toFixed(1)}`;
    const end = { x: x(pts[pts.length - 1].t), y: y(pts[pts.length - 1].v) };
    return { line: d, area: `${d} V${H} H0 Z`, end };
  }, [pts]);
  if (!path) return <div className={s.chartEmpty}>Waiting for the first trades of the day…</div>;
  return (
    <svg className={s.chart} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="jf-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--c, #5FF0A0)" stopOpacity=".38" />
          <stop offset="1" stopColor="var(--c, #5FF0A0)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={path.area} fill="url(#jf-area)" />
      <path d={path.line} fill="none" stroke="var(--c, #5FF0A0)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle className={s.ping} cx={path.end.x} cy={path.end.y} r="9" />
      <circle cx={path.end.x} cy={path.end.y} r="4.5" fill="var(--c, #5FF0A0)" />
    </svg>
  );
}

export default function JoinFlight({ coins }: { coins: HomeCoin[] }) {
  const c = useMemo(() => pickJoin(coins), [coins]);
  const { pts, crew } = useLive(c);
  const art = { ["--art" as string]: `url(${withBase(ART)})` };

  if (!c) return (
    <section className={`${s.card} ${s.empty}`} style={art} aria-labelledby="lobby-join-title" data-testid="lobby-join" data-empty="1">
      <span className={s.plate} aria-hidden />
      <div className={s.top}><span className={s.live}><i aria-hidden className={s.off} />Nothing flying yet</span></div>
      <div className={s.foot}>
        <h2 id="lobby-join-title" className={s.title}>Join a flight</h2>
        <p className={s.emptyTx}>No rockets are in the air right now. Host the first launch and your crew flies it up, or warm up in Free play.</p>
        <div className={s.actions}>
          <Link href="/create" className={s.drop} data-testid="lobby-host">Host a launch</Link>
          <Link href="/flight/sim" className={s.ghost}>Free play</Link>
        </div>
      </div>
    </section>
  );

  const tier = tierProgress(c.mcapUsd);
  const aboard = c.stats?.crew ?? null;
  const vol = c.stats?.vol24 ?? 0;
  const chg = c.stats?.chg24 ?? null;
  const orbit = c.progressBps == null ? null : orbitPct(c);
  const more = aboard != null ? Math.max(0, aboard - crew.length) : 0;
  return (
    <Link
      href={flightHref(c)}
      prefetch={false}
      className={s.card}
      style={{ ...art, ...lit(c) }}
      aria-labelledby="lobby-join-title"
      data-testid="lobby-join"
    >
      <span className={s.plate} aria-hidden />
      <div className={s.top}>
        <span className={s.live}><i aria-hidden />{vol > 0 ? "Top rocket today" : "Live now"}</span>
        <span className={s.stats}>
          {chg != null && <span className={`${s.chg} ${chg >= 0 ? s.up : s.dn}`}>{chg >= 0 ? "+" : "−"}{pct(Math.abs(chg))}<span className={s.today}> today</span></span>}
          <span className={s.alt}>{altShort(c.mcapUsd)}</span>
        </span>
      </div>

      <div className={s.chartBox}>
        {pts ? <Chart pts={pts} /> : <div className={s.chartEmpty}>Reading the market…</div>}
      </div>

      <div className={s.foot}>
        <h2 id="lobby-join-title" className={s.kicker}>Join a flight</h2>
        <div className={s.nameRow}>
          <Mark c={c} className={s.mark} />
          <b className={s.name}>{c.name}</b>
        </div>
        <span className={s.sub}>${c.ticker} · Tier {tier.index + 1} · {tier.title}{vol > 0 ? ` · ${altShort(vol)} traded today` : ""}</span>
        {orbit != null && (
          <span className={s.bar} role="progressbar" aria-label="Progress to orbit" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(orbit)}>
            <i style={{ width: `${orbit}%` }} />
          </span>
        )}
        <div className={s.actions}>
          <span className={s.crew}>
            {crew.length > 0 && <span className={s.faces} aria-hidden>{crew.map((a) => <Face key={a} a={a} />)}{more > 0 && <i className={`${s.face} ${s.more}`}>+{more > 99 ? "99" : more}</i>}</span>}
            <span>{aboard ? `${aboard.toLocaleString("en-US")} ${aboard === 1 ? "pilot" : "pilots"} aboard` : orbit != null ? `${pct(orbit)} to orbit` : ""}</span>
          </span>
          <span className={s.drop} data-testid="lobby-drop-in">Drop in</span>
        </div>
      </div>
    </Link>
  );
}
