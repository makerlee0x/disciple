"use client";

import { useEffect, useMemo, useState } from "react";
import { localUsername } from "@/lib/profile";
import BrandedRocket from "@/components/BrandedRocket";
import PairArt from "@/components/pairart/PairArt";
import { sampleArtFor } from "@/lib/pairArt";
import {
  CrosshairChart, RangeToggle, sliceRange, type RangeKey, Donut, Gauge, Heatmap, Histogram, 
  PlaystyleMeter, RadarChart, Sparkline, StatRing,
} from "./Charts";
import { PERSONAS, SAMPLE_DATA_LABEL, buildPersonaStats, type PersonaId } from "@/lib/mock/sample-trades";
import { fmtUsd } from "@/lib/config";
import { PERSONA_BADGES, identityRuleText, personaBadge } from "@/lib/identity";
import { prestigeFromPoints } from "@/lib/prestige";
import { withBase } from "@/lib/base-path";
import SettingsModal from "./SettingsModal";
import ShareModal, { type ShareTarget } from "@/components/share/ShareModal";
import { onWallet } from "@/lib/wallet";

function fmtKpi(v: number, format: string) {
  if (format === "usd") return (v >= 0 ? "" : "-") + fmtUsd(Math.abs(v));
  if (format === "pct") return `${v.toFixed(1)}%`;
  if (format === "hours") {
    if (v < 1) return `${Math.round(v * 60)}m`;
    if (v < 48) return `${v.toFixed(1)}h`;
    return `${(v / 24).toFixed(1)}d`;
  }
  return v.toFixed(0);
}

function fmtRing(v: number, format: string) {
  if (format === "usd") return fmtUsd(v);
  if (format === "multiple") return `${v.toFixed(1)}x`;
  if (format === "rank") return `#${Math.round(v)}`;
  return Math.round(v).toLocaleString();
}

type SortKey = "ticker" | "tier" | "entries" | "pnl" | "winRate" | "avgHold" | "bombs";

/** Deterministic sample stats for a username (until the indexer serves real history). */
function samplePersonaFor(username?: string): PersonaId {
  if (!username) return "believer";
  const ids = Object.keys(PERSONAS) as PersonaId[];
  let h = 0;
  for (const c of username) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ids[h % ids.length];
}

export default function ProfileDashboard({ mode = "private", username }: { mode?: "private" | "public"; username?: string }) {
  const isPrivate = mode === "private";
  const persona = samplePersonaFor(username);
  const [me, setMe] = useState("");
  useEffect(() => { if (isPrivate) setMe(localUsername()); }, [isPrivate]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [share, setShare] = useState<ShareTarget | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  // Private: the signed-in wallet. Public: reverse lookup username → wallet.
  useEffect(() => {
    if (isPrivate) return onWallet((a) => setWallet(a ? a.toLowerCase() : null));
    if (!username) return;
    let alive = true;
    fetch(`/api/profile/username?resolve=${encodeURIComponent(username)}`).then((r) => r.json())
      .then((j: { address?: string | null }) => { if (alive) setWallet(j.address ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [isPrivate, username]);
  const [pnlRange, setPnlRange] = useState<RangeKey>("30d");
  const [volRange, setVolRange] = useState<RangeKey>("30d");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "pnl", dir: "desc" });
  const data = useMemo(() => buildPersonaStats(persona), [persona]);
  const { identity } = data;

  const rockets = useMemo(() => {
    const rows = [...data.rockets];
    const dir = sort.dir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      switch (sort.key) {
        case "ticker": return a.ticker.localeCompare(b.ticker) * dir;
        case "tier": return (a.tierIndex - b.tierIndex) * dir;
        case "entries": return (a.entries - b.entries) * dir;
        case "pnl": return (a.pnl - b.pnl) * dir;
        case "winRate": return (a.winRate - b.winRate) * dir;
        case "avgHold": return (a.avgHoldHours - b.avgHoldHours) * dir;
        case "bombs": return (a.bombs - b.bombs) * dir;
        default: return 0;
      }
    });
    return rows;
  }, [data.rockets, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));

  const volSeries = useMemo(
    () => data.volumeByDay.map((d) => ({ t: Date.parse(d.day + "T12:00:00Z"), v: d.volume })),
    [data.volumeByDay],
  );
  const pnlPts = useMemo(() => sliceRange(data.cumulativePnl, pnlRange, "level"), [data.cumulativePnl, pnlRange]);
  const volPts = useMemo(() => sliceRange(volSeries, volRange, "flow"), [volSeries, volRange]);

  const border = data.rank.border;
  const badge = PERSONA_BADGES[personaBadge(identity)];
  const prestige = prestigeFromPoints(data.points);

  return (
    <div className="profile-page">
      <header className="profile-head">
        <div>
          <h1>{isPrivate ? "Your Profile" : `@${username}`}</h1>
          <div className="sub">{isPrivate ? "PILOT OVERVIEW · CASH & ACCOUNT LIVE IN SETTINGS" : "PUBLIC PILOT PROFILE"}</div>
        </div>
        {isPrivate && (
          <button type="button" className="ds-btn gold profile-settings-btn" onClick={() => setSettingsOpen(true)}>⚙ Settings</button>
        )}
      </header>
      {share && <ShareModal target={share} onClose={() => setShare(null)} />}
      {isPrivate && <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />}
      <span className="tag mock">{SAMPLE_DATA_LABEL} · stats below are SAMPLE until the indexer is live</span>

      <section className="profile-banner" style={{ boxShadow: `0 0 0 1px ${border}, 0 0 40px rgba(201,206,214,0.12)` }}>
        <div className="banner-frame" style={{ borderColor: border }}>
          <div className="banner-rocket"><BrandedRocket height={160} icon={data.showcaseIcon} /></div>
          <div className="banner-meta">
            <div className="banner-handle">{isPrivate ? (me ? `@${me}` : data.handle) : `@${username}`}</div>
            <div className="persona-badge" title={`${badge.label} — earned from your playstyle. ${badge.blurb}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={withBase(badge.icon)} alt="" width={28} height={28} />
              <span>{badge.label}</span>
            </div>
            <div className="banner-title" title={identityRuleText(identity.primary.id)}>{identity.primary.label}</div>
            <div className="banner-tags">
              {identity.secondary.map((t) => (
                <span key={t.id} className="id-tag" title={identityRuleText(t.id)}>{t.label}</span>
              ))}
            </div>
            <p className="banner-blurb">{identity.primary.blurb}</p>
            <div className="banner-rank">
              <span className="rank-pill" style={{ borderColor: border, color: border }}>{data.rank.label}</span>
              <span className="muted">Rank tier · {data.points.toLocaleString()} pts</span>
            </div>
          </div>
          <div className="banner-level">
            <div className="level-badge" style={{ borderColor: border }} title={`Prestige ${prestige.prestige} · ${prestige.prestigeName}`}>
              <span className="lvl">P{prestige.prestige} · LVL</span><span className="num">{prestige.level}</span>
            </div>
            <div className="prestige-name">{prestige.prestigeName} prestige</div>
            <div className="xp-bar" title={`Next: ${prestige.nextLabel}`}>
              <div className="xp-fill" style={{ width: `${prestige.progress * 100}%` }} />
              <span>{prestige.into.toLocaleString()} / {prestige.need.toLocaleString()} pts → {prestige.nextLabel}</span>
            </div>
            <div className="top-badges">
              {data.topBadges.length === 0 ? <span className="muted">No badges unlocked yet</span> : data.topBadges.map((b) => (
                <div key={b.id} className={`mini-badge r-${b.rarity.toLowerCase()}`} title={b.name}>✦<span>{b.name}</span></div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="chart-card rockets-card">
        <div className="table-head"><h3>Holdings · Rockets</h3><span className="muted">current positions · sortable</span></div>
        <div className="rockets-table-wrap">
          <table className="rockets-table">
            <thead><tr>
              {([["ticker","Rocket"],["tier","Tier"],["entries","Entries"],["pnl","PnL"],["winRate","Win"],["avgHold","Avg hold"],["bombs","Bombs"]] as [SortKey,string][]).map(([k,label]) => (
                <th key={k}><button type="button" onClick={() => toggleSort(k)}>{label}{sort.key === k ? (sort.dir === "asc" ? " ^" : " v") : ""}</button></th>
              ))}
              <th>Badges</th>
              <th aria-label="Share" />
            </tr></thead>
            <tbody>
              {rockets.map((r) => (
                <tr key={r.token}>
                  <td><div className="hold-tok"><PairArt {...sampleArtFor(r.ticker)} tk={r.ticker} size="list" px={36} /><div><strong>{r.ticker}</strong><div className="muted tiny">{r.name}</div></div></div></td>
                  <td><span className="tier-chip">{r.tierName}</span></td>
                  <td>{r.entries}</td>
                  <td className={r.pnl >= 0 ? "pos" : "neg"}>{fmtUsd(r.pnl)}</td>
                  <td><Donut value={r.winRate} /></td>
                  <td>{fmtKpi(r.avgHoldHours, "hours")}</td>
                  <td>{r.bombs}</td>
                  <td><div className="row-badges">{r.badges.map((b) => <span key={b} className="id-tag">{b}</span>)}</div></td>
                  <td>
                    {/* Rows are still sample data; the modal checks the wallet's indexed fills and stamps SAMPLE when there are none. */}
                    <button type="button" className="ds-btn share-btn" aria-label={`Share this ${r.ticker} trade`}
                      onClick={() => setShare({ coin: r.token, ticker: r.ticker, wallet, username: (isPrivate ? me : username) || null })}>
                      Share this trade
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="kpi-grid">
        {data.kpis.map((k) => (
          <div key={k.key} className="kpi-card">
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value">{fmtKpi(k.total, k.format)}</div>
            <div className="kpi-sub">30d {fmtKpi(k.d30, k.format)}</div>
            <Sparkline a={k.sparkTotal} b={k.spark30} />
          </div>
        ))}
      </section>

      <section className="rings-gauges">
        <div className="rings-row">
          {data.rings.map((r, i) => (
            <StatRing key={r.key} value={fmtRing(r.value, r.format)} label={r.label} sub={r.sub}
              progress={Math.min(0.95, Math.abs(r.value) / Math.max(1, r.max))}
              color={i % 2 === 0 ? "#C9CED6" : "#c9b6f2"} />
          ))}
        </div>
        <div className="gauges-row">
          <Gauge value={data.pointsBehindFirst} label="Points behind #1" max={Math.max(data.pointsBehindFirst * 1.2, 100)} color="#ff7eb9" />
          <Gauge value={data.pointsToNextRank} label="To next rank" max={Math.max(data.pointsToNextRank * 1.4, 100)} color="#7ec8ff" />
        </div>
      </section>

      <section className="charts-grid">
        <div className="chart-card">
          <div className="chart-head"><h3>Cumulative PnL</h3><RangeToggle value={pnlRange} onChange={setPnlRange} /></div>
          <CrosshairChart points={pnlPts} hourly={pnlRange === "1d"} formatY={(v) => (v < 0 ? "-" : "") + fmtUsd(Math.abs(v))} color="#c9b6f2" />
        </div>
        <div className="chart-card">
          <div className="chart-head"><h3>{volRange === "1d" ? "Volume by hour" : "Volume by day"}</h3><RangeToggle value={volRange} onChange={setVolRange} /></div>
          <CrosshairChart kind="bar" points={volPts} hourly={volRange === "1d"} formatY={(v) => fmtUsd(v)} color="#C9CED6" />
        </div>
        <div className="chart-card"><h3>Hold-time distribution</h3><Histogram items={data.holdHist} /></div>
        <div className="chart-card"><h3>PnL calendar</h3><Heatmap days={data.pnlCalendar} /></div>
      </section>

      <section className="style-grid">
        <div className="chart-card">
          <h3>Playstyle · PvE vs PvP</h3>
          <PlaystyleMeter pve={data.pveScore} pvp={data.pvpScore} />
          <div className="playstyle-detail">
            <div><strong>Crew climb</strong><ul>
              <li>Boosting {data.playstyle.fueling}</li><li>Holding {data.playstyle.holding}</li>
              <li>Crews {data.playstyle.crewJoins}</li><li>Grads {data.playstyle.graduations}</li>
            </ul></div>
            <div><strong>Bomb bay</strong><ul>
              <li>Bombs {data.playstyle.bombs}</li><li>Impact {data.playstyle.impact}</li>
              <li>Dumps {data.playstyle.dumpsIntoPumps}</li><li>Flips {data.playstyle.quickFlips}</li>
            </ul></div>
          </div>
        </div>
        <div className="chart-card">
          <h3>Trait radar</h3>
          <div className="radar-wrap">
            <RadarChart axes={[
              { label: "Conviction", value: data.traits.conviction },
              { label: "Aggression", value: data.traits.aggression },
              { label: "Timing", value: data.traits.timing },
              { label: "Sniping", value: data.traits.sniping },
              { label: "Diamond", value: data.traits.diamondHands },
              { label: "Crew", value: data.traits.crewSpirit },
            ]} />
          </div>
        </div>
      </section>

      <section className="ct-grid">
        <div className="ct-card"><span>Rugged count</span><strong>{data.ct.ruggedCount}</strong></div>
        <div className="ct-card"><span>Rounds tripped</span><strong>{data.ct.roundsTripped}</strong></div>
        <div className="ct-card win"><span>Biggest W</span><strong>{fmtUsd(data.ct.biggestW)}</strong></div>
        <div className="ct-card loss"><span>Biggest L</span><strong>{fmtUsd(data.ct.biggestL)}</strong></div>
        <div className="ct-card"><span>Fumbled bag</span><strong>{fmtUsd(data.ct.fumbledBag)}</strong></div>
        <div className="ct-card"><span>Time in trenches</span><strong>{(data.ct.timeInTrenchesHours / 24).toFixed(1)}d</strong></div>
        <div className="ct-card"><span>Ape score</span><strong>{data.ct.apeScore}</strong></div>
        <div className="ct-card"><span>Graduations witnessed</span><strong>{data.ct.graduationsWitnessed}</strong></div>
      </section>


      <section className="chart-card">
        <h3>Recent activity</h3>
        <ul className="activity-feed">
          {data.activity.slice(0, 18).map((a) => (
            <li key={a.id}>
              <span className={`act-kind ${a.kind}`}>{a.kind}</span>
              <span className="act-text">{a.text}</span>
              {a.usd != null ? <span className="act-usd">{fmtUsd(a.usd)}</span> : null}
              <span className="act-time muted">{new Date(a.ts).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
