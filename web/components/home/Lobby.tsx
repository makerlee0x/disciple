"use client";
/**
 * Lobby, below door one (HomeHero): door two (JOIN A FLIGHT, a live rocket to drop into, with Shuffle) beside today's
 * missions, then the shelves: Climbing now, About to reach orbit, Fresh off the pad. Every number comes from the same
 * HomeData the hero paints with (chain launches + indexed trades), refreshed by the hero's poll ("dsc:home-data").
 * A shelf with nothing to show is left out; with no rockets at all only the missions panel shows.
 */
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fmtUsd } from "@/lib/config";
import { difficultyOf } from "@/lib/difficulty";
import { isStoreSrc } from "@/lib/coinImages";
import {
  climbingNow, fmtAgeShort, freshOffPad, nearOrbit, rankTrending, thumbSrc, tierProgress,
  type HomeCoin, type HomeData,
} from "@/lib/home/trending";
import { withBase } from "@/lib/base-path";
import { blankXp, usePilotWallet, useXp } from "@/lib/xpClient";
import PairArt from "@/components/pairart/PairArt";
import Icon from "@/components/icons/Icon";
import MissionsPanel from "@/components/xp/MissionsPanel";
import s from "./lobby.module.css";

/** Flight page link (same query the feed builds). */
export function flightHref(c: HomeCoin) {
  const q = new URLSearchParams();
  q.set("coin", c.token);
  q.set("launched", "1");
  if (c.icon) q.set("icon", c.icon);
  if (c.pairSym) q.set("pair", c.pairSym);
  q.set("nm", c.name);
  q.set("cs", c.ticker);
  return `/coin/${c.token}?${q.toString()}`;
}

const orbitPct = (c: HomeCoin) => (c.graduated ? 100 : Math.max(0, Math.min(100, (c.progressBps ?? 0) / 100)));
const pct = (v: number) => `${v >= 10 ? Math.round(v) : v.toFixed(1)}%`;

function Art({ c, className }: { c: HomeCoin; className?: string }) {
  return (
    <span className={`${s.art}${className ? " " + className : ""}`} aria-hidden>
      {isStoreSrc(c.icon)
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={c.icon} alt="" loading="lazy" decoding="async" />
        : <PairArt tk={c.ticker} tint="#E8EAEE" size="list" fluid />}
    </span>
  );
}

function Diff({ c }: { c: HomeCoin }) {
  const d = difficultyOf(c.mode, c.graduated);
  return d ? <span className={`dsc3-badge dsc3-badge-${d.key} ${s.diff}`}>{d.label}</span> : null;
}

function Shelf({ id, title, sub, children }: { id: string; title: string; sub: string; children: ReactNode }) {
  return (
    <section className={s.shelf} aria-labelledby={id}>
      <header className={s.shelfHd}>
        <h2 id={id} className="dsc3-h2">{title}</h2>
        <p>{sub}</p>
      </header>
      {children}
    </section>
  );
}

/** Door two: one live rocket to drop into. Shuffle walks the trending list (then the newest), never a graduated one. */
function JoinFlight({ coins }: { coins: HomeCoin[] }) {
  const pool = useMemo(() => {
    const live = coins.filter((c) => !c.graduated);
    const hot = rankTrending(live).slice(0, 8);
    return hot.length ? hot : [...live].sort((a, b) => b.block - a.block).slice(0, 8);
  }, [coins]);
  const [i, setI] = useState(0);
  const c = pool.length ? pool[i % pool.length] : null;
  if (!c) return null;
  const tier = tierProgress(c.mcapUsd);
  const crew = c.stats?.crew ?? null;
  const chg = c.stats?.chg24 ?? null;
  const orbit = c.progressBps == null && !c.graduated ? null : orbitPct(c);
  return (
    <section className={`dsc3-panel ${s.join}`} aria-labelledby="lobby-join-title" data-testid="lobby-join">
      <span className={s.joinBloom} aria-hidden />
      <span className={s.live}><i aria-hidden />Live now{crew ? ` · ${crew.toLocaleString("en-US")} ${crew === 1 ? "pilot" : "pilots"} aboard` : ""}</span>
      <h2 id="lobby-join-title" className={`dsc3-h1 ${s.joinTitle}`}>Join a flight</h2>
      <Link href={flightHref(c)} prefetch={false} className={s.ride} aria-label={`${c.name}, open its flight`}>
        <Art c={c} className={s.rideArt} />
        <span className={s.rideTx}>
          <b>{c.name}</b>
          <span>${c.ticker} · Tier {tier.index + 1} · {tier.title}</span>
        </span>
        <Diff c={c} />
      </Link>
      {(orbit != null || chg != null) && (
        <div className={s.joinBar}>
          {orbit != null && (
            <div className="dsc3-bar dsc3-bar-orbit" role="progressbar" aria-label="Progress to orbit" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(orbit)}>
              <i style={{ width: `${orbit}%` }} />
            </div>
          )}
          <span>
            {orbit != null ? `${pct(orbit)} to orbit` : null}
            {orbit != null && chg != null ? " · " : null}
            {chg != null ? <em className={chg >= 0 ? s.up : s.dn}>{chg >= 0 ? "+" : "−"}{pct(Math.abs(chg))} today</em> : null}
          </span>
        </div>
      )}
      <div className={s.joinActions}>
        <Link href={flightHref(c)} prefetch={false} className="dsc3-btn dsc3-btn-white" data-testid="lobby-drop-in">
          Drop in <Icon name="chevron-right" size={18} />
        </Link>
        {pool.length > 1 && (
          <button type="button" className="dsc3-btn dsc3-btn-ghost" onClick={() => setI((n) => n + 1)} aria-label="Show another live rocket" data-testid="lobby-shuffle">
            <Icon name="shuffle" size={16} /> Shuffle
          </button>
        )}
      </div>
    </section>
  );
}

export default function Lobby({ initial }: { initial: HomeData }) {
  const [data, setData] = useState(initial);
  const [now, setNow] = useState(initial.at || 0);
  useEffect(() => {
    setNow(Date.now());
    const h = (e: Event) => { setData((e as CustomEvent<HomeData>).detail); setNow(Date.now()); };
    window.addEventListener("dsc:home-data", h);
    return () => window.removeEventListener("dsc:home-data", h);
  }, []);
  const wallet = usePilotWallet();
  const { xp } = useXp(wallet);
  const missions = useMemo(() => xp ?? blankXp(now || Date.now()), [xp, now]);

  const coins = data.coins;
  const climbing = useMemo(() => climbingNow(coins, 5), [coins]);
  const orbit = useMemo(() => nearOrbit(coins), [coins]);
  const fresh = useMemo(() => freshOffPad(coins), [coins]);
  const hasJoin = coins.some((c) => !c.graduated);

  return (
    <div className={s.lobby} data-testid="lobby">
      <div className={`${s.doors}${hasJoin ? "" : " " + s.doorsSolo}`}>
        {hasJoin && <JoinFlight coins={coins} />}
        <MissionsPanel
          xp={missions}
          className={s.missions}
          footer={<Link href="/achievements" className={s.more}>{xp ? "All missions and trophies" : "See this week's missions"} <Icon name="chevron-right" size={14} /></Link>}
        />
      </div>

      {climbing.length > 0 && (
        <Shelf id="shelf-climbing" title="Climbing now" sub="Biggest climbs today. Boost one and ride it up.">
          <div className={s.tiles}>
            {climbing.map((c) => {
              const t = tierProgress(c.mcapUsd);
              return (
                <Link key={c.token} href={flightHref(c)} prefetch={false} className={`dsc3-tile ${s.tile}`} data-testid="shelf-climbing-tile">
                  <span className={s.tileSky} style={{ backgroundImage: `url(${withBase(thumbSrc(t.index))})` }} aria-hidden>
                    <span className={s.tierTag}>Tier {t.index + 1}</span>
                    <Art c={c} className={s.tileArt} />
                    <Diff c={c} />
                  </span>
                  <span className={s.tileBody}>
                    <span className={s.tileName}><b>{c.name}</b><span>${c.ticker}</span></span>
                    <span className={s.tileNums}>
                      <span>{fmtUsd(c.mcapUsd)} altitude</span>
                      <em className={s.up}>+{pct(c.stats!.chg24!)}</em>
                    </span>
                    {c.stats?.crew ? <span className={s.tileCrew}><Icon name="crew" size={14} />{c.stats.crew.toLocaleString("en-US")} aboard</span> : null}
                  </span>
                </Link>
              );
            })}
          </div>
        </Shelf>
      )}

      {orbit.length > 0 && (
        <Shelf id="shelf-orbit" title="About to reach orbit" sub="Boost now and you're aboard when it graduates.">
          <div className={s.orbitGrid}>
            {orbit.map((c) => {
              const p = orbitPct(c);
              return (
                <Link key={c.token} href={flightHref(c)} prefetch={false} className={`dsc3-tile ${s.orbit}`} data-testid="shelf-orbit-card">
                  <span className={s.orbitTop}>
                    <Art c={c} className={s.orbitArt} />
                    <span className={s.orbitName}><b>{c.name}</b><span>${c.ticker}</span></span>
                    <span className={s.orbitPct}>{pct(p)}</span>
                  </span>
                  <span className="dsc3-bar dsc3-bar-orbit" aria-hidden><i style={{ width: `${p}%` }} /></span>
                  <span className={s.orbitFt}>
                    {c.stats?.crew ? `${c.stats.crew.toLocaleString("en-US")} aboard · ` : ""}{fmtUsd(c.mcapUsd)} altitude
                  </span>
                </Link>
              );
            })}
          </div>
        </Shelf>
      )}

      {fresh.length > 0 && (
        <Shelf id="shelf-fresh" title="Fresh off the pad" sub="The newest launches. Get aboard early.">
          <div className={s.freshGrid}>
            {fresh.map((c) => (
              <Link key={c.token} href={flightHref(c)} prefetch={false} className={`dsc3-tile ${s.fresh}`} data-testid="shelf-fresh-row">
                <Art c={c} className={s.freshArt} />
                <span className={s.freshTx}>
                  <b>{c.name}</b>
                  <span>
                    {c.launchedAt && now ? `${fmtAgeShort(now - c.launchedAt)} ago` : `$${c.ticker}`}
                    {c.stats?.crew ? ` · ${c.stats.crew.toLocaleString("en-US")} aboard` : ""}
                  </span>
                </span>
                <Diff c={c} />
              </Link>
            ))}
          </div>
        </Shelf>
      )}

      {coins.length > 0 && (
        <header className={`${s.shelfHd} ${s.allHd}`}>
          <h2 className="dsc3-h2">All rockets</h2>
        </header>
      )}
    </div>
  );
}

const STEPS = [
  { n: "01", t: "Launch", d: "Build a rocket and open the hatch." },
  { n: "02", t: "Join", d: "Drop into any live flight." },
  { n: "03", t: "Climb", d: "Boost lifts the whole crew. Dump drops a bomb." },
  { n: "04", t: "Reach orbit", d: "Climb past the Kármán Line and the rocket graduates." },
];

/** The four beats of a match, at the foot of the lobby (full guide on How to play). */
export function LobbySteps() {
  return (
    <nav className={s.steps} aria-label="How to play">
      {STEPS.map((x) => (
        <Link key={x.n} href="/how-it-works" className={s.stepCell}>
          <span className={s.stepN}>{x.n}</span>
          <b>{x.t}</b>
          <span>{x.d}</span>
        </Link>
      ))}
    </nav>
  );
}
