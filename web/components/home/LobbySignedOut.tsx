"use client";
/**
 * The lobby for signed-out visitors, which is also the landing page (lobby canvas board "Lobby, signed out",
 * https://claude.ai/artifact/7wmDkSPQft2uUxTB1j99ZL, signed off by maker 2026-11-13). Top to bottom: the cinematic
 * lift-off hero (RIDE IT TO ORBIT, Play now, Launch your own), the live ticker, How it plays (the flight screen in one
 * shot), Flying now (Live window cards), then Top pilots beside Launch your own. Signed-in players get the regular lobby
 * (components/home/HomeGate). Every name and number is live HomeData: chain launches + the indexed trades; a section
 * with nothing to show is left out or says so.
 */
import ModeSelect from "@/components/home/ModeSelect";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { withBase } from "@/lib/base-path";
import { displayName } from "@/lib/defaultUsername";
import { climbingNow, ROCKET_SRC, tierProgress, type HomeCoin, type HomeData } from "@/lib/home/trending";
import { EMPTY_PILOTS, PILOT_WINDOWS, type PilotWindow, type TickerItem } from "@/lib/home/topPilots";
import { tierAt } from "@/lib/flight/tiers";
import { afterPaint } from "./idle";
import LiveCard from "./LiveCard";
import { altShort, flightHref, lightOf, orbitPct, pct } from "./rocketBits";
import s from "./lobbySignedOut.module.css";

const HERO_SKY = "/home/sky/t6.webp";
const BAY_PLATE = "/hangar/plate-1280.webp";
const POLL_MS = 30_000;

const money = (v: number) => "$" + Math.round(v).toLocaleString("en-US");
const titleCase = (t: string) => t.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
const who = (t: { username?: string | null; trader: string }) => displayName(t.username, t.trader);

/** Keeps the numbers fresh after paint (same /api/home the signed-in lobby polls). */
function useLiveHome(init: HomeData) {
  const [data, setData] = useState(init);
  const [go, setGo] = useState(false);
  useEffect(() => afterPaint(() => setGo(true)), []);
  useEffect(() => {
    if (!go) return;
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch("/api/home");
        if (!r.ok) return;
        const d = (await r.json()) as HomeData;
        if (alive) { setData(d); window.dispatchEvent(new CustomEvent("dsc:home-data", { detail: d })); }
      } catch { /* keep the last numbers */ }
    };
    const iv = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [go]);
  return data;
}

/** One ticker line, game words only: "▲ Nova boosted Halo Runner +$25", "● Grenade hit Night Shift −3%". */
function TickLine({ t }: { t: TickerItem }) {
  if (t.kind === "boost") return <span><b className={s.up}>▲ {who(t)}</b> boosted {t.coinName} +{money(t.usd)}</span>;
  return <span><b className={s.dn}>● {titleCase(t.bomb ?? "Bomb")}</b> hit {t.coinName}{t.dropPct ? ` −${pct(t.dropPct)}` : ""}</span>;
}

function Hero({ data, hero }: { data: HomeData; hero: HomeCoin | null }) {
  const live = data.coins.filter((c) => !c.graduated);
  const pilots = live.reduce((n, c) => n + (c.stats?.crew ?? 0), 0);
  const tier = hero ? tierProgress(hero.mcapUsd) : null;
  const orbit = hero && (hero.progressBps != null || hero.graduated) ? orbitPct(hero) : null;
  // the three latest plays on the hero rocket float past it (boosts up, bombs in red)
  const plays = (data.ticker ?? []).filter((t) => hero && t.coin === hero.token).slice(0, 3);
  const play = hero ? flightHref(hero) : "/create";
  return (
    <section className={s.hero} aria-labelledby="so-hero-title" data-testid="so-hero">
      <div className={s.heroSky} style={{ backgroundImage: `url(${withBase(HERO_SKY)})` }} aria-hidden />
      <div className={s.heroGrade} aria-hidden />
      <div className={s.heroBack} aria-hidden />
      <div className={s.heroStreak} aria-hidden />
      <div className={s.heroFire} aria-hidden />
      <div className={s.heroShip} aria-hidden>
        <div className={s.lift}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={withBase(ROCKET_SRC)} alt="" fetchPriority="high" decoding="async" />
          <span className={s.flame} />
        </div>
      </div>
      <span className={`${s.smoke} ${s.smokeA}`} aria-hidden />
      <span className={`${s.smoke} ${s.smokeB}`} aria-hidden />
      <span className={`${s.smoke} ${s.smokeC}`} aria-hidden />
      <div className={s.heroVignette} aria-hidden />
      <div className={s.heroScrim} aria-hidden />
      <span className={`${s.bar} ${s.barTop}`} aria-hidden />
      <span className={`${s.bar} ${s.barBot}`} aria-hidden />
      {plays.map((t, i) => (
        <span key={t.id} className={`${s.float} ${t.kind === "boost" ? s.fUp : s.fDn} ${s[`f${i}`]}`} aria-hidden>
          {t.kind === "boost" ? `▲ Boost +${money(t.usd)}` : `● ${titleCase(t.bomb ?? "Bomb")}${t.dropPct ? ` −${pct(t.dropPct)}` : ""}`}
        </span>
      ))}
      {hero && tier && (
        <Link href={play} prefetch={false} className={s.heroCard} aria-label={`${hero.name}, live, ${altShort(hero.mcapUsd)} altitude. Drop in`}>
          <span className={s.heroCardTop}><span className={s.cardName}>{hero.name}</span><span className={s.liveTag}>{hero.graduated ? "In orbit" : "Live"}</span></span>
          <span className={s.heroAlt}>{altShort(hero.mcapUsd)}</span>
          {orbit != null && <span className={s.heroBar} aria-hidden><i style={{ width: `${orbit}%` }} /></span>}
          <span className={s.heroMeta}>
            {hero.stats?.crew ? `${hero.stats.crew.toLocaleString("en-US")} aboard` : `Tier ${tier.index + 1}`}
            {tier.next ? ` · ${tier.next.title} next` : ""}
          </span>
        </Link>
      )}
      <div className={s.heroCopy}>
        {pilots > 0 && (
          <span className={s.eyebrow}><span className={s.liveTag}>Live</span>{pilots.toLocaleString("en-US")} {pilots === 1 ? "pilot" : "pilots"} flying right now</span>
        )}
        <h1 id="so-hero-title" className={s.heroTitle}>Ride it<br />to orbit</h1>
        <p className={s.lede}>Every rocket is a live match. The crew boosts it up, and anyone can bomb it down.</p>
        <div className={s.actions}>
          <Link href={play} prefetch={false} className={`${s.btn} ${s.gold}`} data-testid="so-play">Play now</Link>
          <Link href="/create" className={`${s.btn} ${s.ghost}`} data-testid="so-launch">Launch your own</Link>
        </div>
        <span className={s.trader}>Trader? <Link href="/how-it-works#pro">See the spec sheet</Link></span>
      </div>
    </section>
  );
}

function Ticker({ data }: { data: HomeData }) {
  const items = data.ticker ?? [];
  if (items.length < 3) return null;
  return (
    <div className={s.ticker} aria-label="Latest plays" data-testid="so-ticker">
      <div className={s.tickRow}>
        {[0, 1].map((k) => (
          <div key={k} className={s.tickSet} aria-hidden={k === 1 || undefined}>
            {items.map((t) => <TickLine key={`${k}-${t.id}`} t={t} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The flight screen in one shot: the rocket climbing, Boost and Dump, Your bag. An illustration of the HUD. */
function HowItPlays() {
  return (
    <section className={s.how} aria-labelledby="so-how-title">
      <div className={s.scene} aria-hidden>
        <div className={s.sceneSky} style={{ backgroundImage: `url(${withBase(HERO_SKY)})` }} />
        <div className={s.sceneGrade} />
        <div className={s.sceneBack} />
        <div className={s.sceneStreak} />
        <div className={s.sceneSpeed} />
        <div className={s.sceneTrail} />
        <div className={s.sceneFire} />
        <div className={s.sceneShip}>
          <div className={s.lift}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={withBase(ROCKET_SRC)} alt="" loading="lazy" decoding="async" />
            <span className={s.flame} />
          </div>
        </div>
        <span className={`${s.float} ${s.fUp} ${s.sf0}`}>▲ +$25</span>
        <span className={`${s.float} ${s.fUp} ${s.sf1}`}>▲ +$50</span>
        <div className={s.sceneVignette} />
        <div className={s.sceneScrim} />
        <span className={`${s.bar} ${s.barTopS}`} />
        <span className={`${s.bar} ${s.barBotS}`} />
        <div className={s.bag}>
          <span className={s.coin} style={{ position: "absolute", right: -12, top: -12 }}>3</span>
          <span className={s.bagLabel}>Your bag</span>
          <span className={s.bagVal}>$62.40 <em>+$12.40</em></span>
        </div>
        <div className={s.hudBtns}>
          <span className={`${s.hudBtn} ${s.hudBoost}`}>▲ Boost <small>Space</small><span className={s.coin} style={{ position: "absolute", left: -10, top: -10 }}>1</span></span>
          <span className={`${s.hudBtn} ${s.hudDump}`}>▼ Dump <small>Shift</small><span className={s.coin} style={{ position: "absolute", right: -10, top: -10 }}>2</span></span>
        </div>
      </div>
      <div className={s.howCopy}>
        <span className={s.eb}>How it plays</span>
        <h2 id="so-how-title" className={s.howTitle}>Boost it up.<br />Cash out higher.</h2>
        <p className={s.step}><span className={s.coin}>1</span><span><b>Boost</b> buys a seat and lifts the rocket for everyone.</span></p>
        <p className={s.step}><span className={s.coin}>2</span><span><b>Dump</b> cashes you out and drops a bomb on the way.</span></p>
        <p className={s.step}><span className={s.coin}>3</span><span><b>Win</b> by cashing out for more than you put in. Seats cost real cash.</span></p>
        <Link href="/how-it-works" className={s.link}>Full tutorial in How to play</Link>
      </div>
    </section>
  );
}

function TopPilotsBoard({ data }: { data: HomeData }) {
  const [win, setWin] = useState<PilotWindow>("day");
  const all = data.pilots ?? EMPTY_PILOTS;
  // open on the shortest window that has anyone in it
  useEffect(() => { if (!all.day.length) setWin(all.week.length ? "week" : all.month.length ? "month" : "day"); }, [all.day.length, all.week.length, all.month.length]);
  const rows = all[win];
  const call = data.bestCalls?.[win] ?? null;
  const label = PILOT_WINDOWS.find((w) => w.k === win)!.label;
  return (
    <section className={s.pilots} aria-labelledby="so-pilots-title" data-testid="so-pilots">
      <header className={s.pilotsHd}>
        <div><h2 id="so-pilots-title" className={s.h2}>Top pilots</h2><span className={s.sub}>Biggest cash-outs, in real money</span></div>
        <div className={s.tabs} role="tablist" aria-label="Time window">
          {PILOT_WINDOWS.map((w) => (
            <button key={w.k} type="button" role="tab" aria-selected={win === w.k} className={`${s.tab}${win === w.k ? " " + s.tabOn : ""}`} onClick={() => setWin(w.k)}>{w.label}</button>
          ))}
        </div>
      </header>
      {rows.length ? (
        <ol className={s.board}>
          {rows.map((r, i) => {
            const name = displayName(r.username, r.wallet);
            return (
              <li key={r.wallet} className={`${s.row}${i === 0 ? " " + s.first : ""}`}>
                <span className={s.rank}>{i + 1}</span>
                <span className={s.av} style={{ background: lightOf(r.wallet) }} aria-hidden>{(name[0] ?? "?").toUpperCase()}</span>
                <span className={s.pn}>
                  <b>{name}</b>
                  {r.level ? <span>Lvl {r.level}{r.prestige ? ` · Prestige ${r.prestige}` : ""}</span> : null}
                </span>
                <span className={s.flights}>{r.green ?? 0} of {r.flights} green</span>
                <span className={s.pnl}>+{money(r.pnlUsd)}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className={s.empty}>No cash-outs {win === "day" ? "yet today" : `this ${label.toLowerCase()} yet`}. The first pilot to cash out higher takes the top spot.</p>
      )}
      {call && (
        <div className={s.call} data-testid="so-bestcall">
          <span className={s.callEb}>Best call {win === "day" ? "today" : `this ${label.toLowerCase()}`}</span>
          <b className={s.callName}>{displayName(call.username ?? null, call.wallet)} on {call.coinName ? `$${call.coinName}` : "a rocket"}</b>
          <span className={s.callZones}>{tierAt(call.boardedMcap).name} <span aria-hidden>{"\u2192"}</span> {tierAt(call.cashedMcap).name}</span>
          <span className={s.callPct}>+{Math.round(call.pct).toLocaleString("en-US")}%</span>
        </div>
      )}
      <Link href="/leaderboard" className={s.link}>Full leaderboard</Link>
    </section>
  );
}

function LaunchYourOwn() {
  return (
    <section className={s.host} aria-labelledby="so-host-title">
      <div className={s.hostPlate} style={{ backgroundImage: `url(${withBase(BAY_PLATE)})` }} aria-hidden />
      <div className={s.hostGrade} aria-hidden />
      <div className={s.hostBack} aria-hidden />
      <div className={s.hostStreak} aria-hidden />
      <div className={s.hostFloor} aria-hidden />
      <div className={s.hostPadGlow} aria-hidden />
      <div className={s.hostPadBase} aria-hidden />
      <div className={s.hostPad} aria-hidden />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={s.hostRocket} src={withBase(ROCKET_SRC)} alt="" loading="lazy" decoding="async" />
      <span className={`${s.smoke} ${s.hostSmoke}`} aria-hidden />
      <div className={s.hostVignette} aria-hidden />
      <div className={s.hostScrim} aria-hidden />
      <span className={`${s.bar} ${s.barTopH}`} aria-hidden />
      <div className={s.hostCopy}>
        <span className={s.eb} style={{ color: "var(--dsc3-light-champagne)" }}>Host a match</span>
        <h2 id="so-host-title" className={s.hostTitle}>Launch<br />your own</h2>
        <p>Pick the difficulty and light the engines. You earn a cut of every boost and dump.</p>
        <Link href="/create" className={`${s.btn} ${s.gold} ${s.btnMd}`}>Start a launch</Link>
      </div>
    </section>
  );
}

export default function LobbySignedOut({ initial }: { initial: HomeData }) {
  const data = useLiveHome(initial);
  const coins = data.coins;
  const hero = useMemo(() => coins.find((c) => c.token === data.hero) ?? coins.find((c) => !c.graduated) ?? null, [coins, data.hero]);
  const flying = useMemo(() => {
    const up = climbingNow(coins, 5);
    if (up.length >= 5) return up;
    const more = coins.filter((c) => !c.graduated && !up.includes(c)).sort((a, b) => (b.stats?.vol24 ?? 0) - (a.stats?.vol24 ?? 0) || b.block - a.block);
    return [...up, ...more].slice(0, 5);
  }, [coins]);
  return (
    <div className={s.wrap} data-testid="lobby-signed-out">
      <Hero data={data} hero={hero} />
      <Ticker data={data} />
      {/* game modes board, option A: signed out, the row opens on Free play */}
      <div className={s.modes}><ModeSelect signedIn={false} flying={coins.filter((c) => !c.graduated).length} /></div>
      <HowItPlays />
      {flying.length > 0 && (
        <section className={s.flying} aria-labelledby="so-flying-title">
          <header className={s.flyingHd}>
            <div className={s.flyingT}><h2 id="so-flying-title" className={s.h2}>Flying now</h2><span className={s.sub}>Pick one and jump in</span></div>
            <a href="#all-rockets" className={s.link}>See all flights</a>
          </header>
          <div className={s.cards}>
            {flying.map((c) => <LiveCard key={c.token} c={c} testId="so-flying-card" />)}
          </div>
        </section>
      )}
      <div className={s.duo}>
        <TopPilotsBoard data={data} />
        <LaunchYourOwn />
      </div>
      {coins.length > 0 && (
        <header className={s.allHd} id="all-rockets"><h2 className={s.h2}>All rockets</h2></header>
      )}
    </div>
  );
}

