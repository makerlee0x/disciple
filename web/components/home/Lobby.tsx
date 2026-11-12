"use client";
/**
 * The lobby (brand v3 lobby mockup, https://claude.ai/artifact/7wmDkSPQft2uUxTB1j99ZL): door one (`hero`, HomeHero's
 * LAUNCH A ROCKET card, about 3/4 of the row) beside a column with door two (JOIN A FLIGHT: a live rocket to drop into,
 * with Shuffle) and today's missions; then the shelves (Climbing now, About to reach orbit, Fresh off the pad) and the
 * header for every rocket. Every number comes from the HomeData the hero paints with (chain launches + indexed trades),
 * refreshed by the hero's poll ("dsc:home-data"). A shelf with nothing to show is left out.
 */
import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { fmtUsd } from "@/lib/config";
import { difficultyOf } from "@/lib/difficulty";
import { isStoreSrc } from "@/lib/coinImages";
import {
  climbingNow, fmtAgeShort, freshOffPad, nearOrbit, rankTrending, ROCKET_SRC, tierProgress,
  type HomeCoin, type HomeData,
} from "@/lib/home/trending";
import { withBase } from "@/lib/base-path";
import { blankXp, usePilotWallet, useXp } from "@/lib/xpClient";
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

/** Each rocket's light colour (its bloom, tier tag and badge), fixed per coin. Mockup palette. */
const LIGHTS = ["#70D9CC", "#B7A0FB", "#FF7A3D", "#DA9CED", "#5BBFE8", "#73B1E6", "#FFD84D", "#5FF0A0", "#44D4E2", "#F3DFA8"];
function lightOf(token: string) {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 16777619);
  return LIGHTS[(h >>> 0) % LIGHTS.length];
}
const lit = (c: HomeCoin) => ({ ["--c" as string]: lightOf(c.token) }) as CSSProperties;
const orbitPct = (c: HomeCoin) => (c.graduated ? 100 : Math.max(0, Math.min(100, (c.progressBps ?? 0) / 100)));
const pct = (v: number) => `${v >= 10 ? Math.round(v) : v.toFixed(1)}%`;
const initial = (c: HomeCoin) => (c.name.trim()[0] ?? c.ticker[0] ?? "?").toUpperCase();

/** The coin's mark: its own (moderated) image, else its initial on its light colour. */
function Mark({ c, className }: { c: HomeCoin; className?: string }) {
  return (
    <span className={`${s.mark}${className ? " " + className : ""}`} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {isStoreSrc(c.icon) ? <img src={c.icon} alt="" loading="lazy" decoding="async" /> : initial(c)}
    </span>
  );
}

/** The chrome rocket on its own light, with the coin's mark on the hull. */
function Rocket({ c, className }: { c: HomeCoin; className?: string }) {
  return (
    <span className={`${s.rocket}${className ? " " + className : ""}`} aria-hidden>
      <span className={s.bloom} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={s.rocketImg} src={withBase(ROCKET_SRC)} alt="" loading="lazy" decoding="async" />
      <Mark c={c} className={s.hull} />
    </span>
  );
}

function Diff({ c, className }: { c: HomeCoin; className?: string }) {
  const d = difficultyOf(c.mode, c.graduated);
  return d ? <span className={`dsc3-badge dsc3-badge-${d.key}${className ? " " + className : ""}`}>{d.label}</span> : null;
}

function ShelfHead({ id, title, sub, children }: { id: string; title: string; sub: string; children?: ReactNode }) {
  return (
    <header className={s.shelfHd}>
      <div className={s.shelfT}>
        <h2 id={id} className="dsc3-h2">{title}</h2>
        <p>{sub}</p>
      </div>
      {children}
    </header>
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
    <section className={`dsc3-panel ${s.join}`} aria-labelledby="lobby-join-title" data-testid="lobby-join" style={lit(c)}>
      <span className={s.joinBloom} aria-hidden />
      <span className={s.live}><i aria-hidden />Live now{crew ? ` · ${crew.toLocaleString("en-US")} ${crew === 1 ? "pilot" : "pilots"} aboard` : ""}</span>
      <h2 id="lobby-join-title" className={s.joinTitle}>Join a flight</h2>
      <Link href={flightHref(c)} prefetch={false} className={s.ride} aria-label={`${c.name}, open its flight`}>
        <Rocket c={c} className={s.rideRocket} />
        <span className={s.rideTx}>
          <b>{c.name}</b>
          <span className={s.rideSub}>{c.ticker} · Tier {tier.index + 1} · {tier.title}</span>
          {orbit != null && (
            <span className="dsc3-bar dsc3-bar-climb" role="progressbar" aria-label="Progress to orbit" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(orbit)}>
              <i style={{ width: `${orbit}%` }} />
            </span>
          )}
          {(orbit != null || chg != null) && (
            <span className={s.rideNums}>
              {orbit != null ? `${pct(orbit)} to orbit` : null}
              {orbit != null && chg != null ? " · " : null}
              {chg != null ? <em className={chg >= 0 ? s.up : s.dn}>{chg >= 0 ? "+" : "−"}{pct(Math.abs(chg))} today</em> : null}
            </span>
          )}
        </span>
      </Link>
      <div className={s.joinActions}>
        <Link href={flightHref(c)} prefetch={false} className={`dsc3-btn dsc3-btn-white ${s.dropIn}`} data-testid="lobby-drop-in">Drop in</Link>
        {pool.length > 1 && (
          <button type="button" className={s.shuffle} onClick={() => setI((n) => n + 1)} aria-label="Show another live rocket" data-testid="lobby-shuffle">
            <Icon name="shuffle" size={15} /> Shuffle
          </button>
        )}
      </div>
    </section>
  );
}

export default function Lobby({ initial: init, hero }: { initial: HomeData; hero: ReactNode }) {
  const [data, setData] = useState(init);
  const [now, setNow] = useState(init.at || 0);
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

  return (
    <div className={s.lobby} data-testid="lobby">
      <div className={s.doors}>
        {hero}
        <div className={s.side}>
          <JoinFlight coins={coins} />
          <MissionsPanel
            xp={missions}
            className={s.missions}
            footer={<Link href="/achievements" className={s.more}>{xp ? "All missions and trophies" : "This week's missions"} <Icon name="chevron-right" size={14} /></Link>}
          />
        </div>
      </div>

      {climbing.length > 0 && (
        <section className={s.shelf} aria-labelledby="shelf-climbing">
          <ShelfHead id="shelf-climbing" title="Climbing now" sub="Biggest climbs today">
            <a href="#all-rockets" className={s.seeAll}>See all</a>
          </ShelfHead>
          <div className={s.tiles}>
            {climbing.map((c) => {
              const t = tierProgress(c.mcapUsd);
              return (
                <Link key={c.token} href={flightHref(c)} prefetch={false} className={s.tile} style={lit(c)} data-testid="shelf-climbing-tile">
                  <span className={s.tileSky}>
                    <Rocket c={c} className={s.tileRocket} />
                    <span className={s.tierTag}>Tier {t.index + 1}</span>
                    <Diff c={c} className={s.tileDiff} />
                  </span>
                  <span className={s.tileBody}>
                    <span className={s.tileName}><b>{c.name}</b><span>{c.ticker}</span></span>
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
        </section>
      )}

      {orbit.length > 0 && (
        <section className={s.shelf} aria-labelledby="shelf-orbit">
          <ShelfHead id="shelf-orbit" title="About to reach orbit" sub="Boost now and you're aboard when it graduates" />
          <div className={s.orbitGrid}>
            {orbit.map((c) => {
              const p = orbitPct(c);
              return (
                <Link key={c.token} href={flightHref(c)} prefetch={false} className={s.orbit} style={lit(c)} data-testid="shelf-orbit-card">
                  <Rocket c={c} className={s.orbitRocket} />
                  <span className={s.orbitTx}>
                    <span className={s.orbitTop}><b>{c.name}</b><span className={s.orbitPct}>{pct(p)}</span></span>
                    <span className="dsc3-bar dsc3-bar-orbit" aria-hidden><i style={{ width: `${p}%` }} /></span>
                    <span className={s.orbitFt}>{c.stats?.crew ? `${c.stats.crew.toLocaleString("en-US")} aboard · ` : ""}{fmtUsd(c.mcapUsd)} altitude</span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {fresh.length > 0 && (
        <section className={s.shelf} aria-labelledby="shelf-fresh">
          <ShelfHead id="shelf-fresh" title="Fresh off the pad" sub="The newest launches" />
          <div className={s.freshRow}>
            {fresh.map((c) => (
              <Link key={c.token} href={flightHref(c)} prefetch={false} className={s.fresh} style={lit(c)} data-testid="shelf-fresh-row">
                <Mark c={c} className={s.freshMark} />
                <span className={s.freshTx}>
                  <b>{c.name}</b>
                  <span>
                    {c.launchedAt && now ? `${fmtAgeShort(now - c.launchedAt)} ago` : c.ticker}
                    {c.stats?.crew ? ` · ${c.stats.crew.toLocaleString("en-US")} aboard` : ""}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {coins.length > 0 && (
        <header className={`${s.shelfHd} ${s.allHd}`} id="all-rockets">
          <div className={s.shelfT}><h2 className="dsc3-h2">All rockets</h2></div>
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
