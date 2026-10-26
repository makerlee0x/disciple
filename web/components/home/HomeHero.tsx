"use client";
/**
 * App home hero (BRAND app-home r1, mock A): the #1 trending rocket (highest 24h volume) on the launch pad under the
 * BRAND night plate (home-hero layers r1). It stays on the rocket the visitor landed on for the whole visit (no auto-rotate); only its
 * numbers and the Next trending strip refresh. The rocket sits in the mount ring of the BRAND layered pad (HeroPad: one
 * plate frame with the sky, pad, moon, stars, smog and exhaust glow) under a twinkling sky and a far-off moon; BOOST / DUMP
 * play the lift-off first and then open the flight page (Open flight goes straight there).
 * Server-rendered with the data (app/page.tsx), so the sky plate is the LCP and needs no client fetch; sky/pad idle
 * motion and polling start only after paint.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtUsd } from "@/lib/config";
import { withBase } from "@/lib/base-path";
import PairArt from "@/components/pairart/PairArt";
import Icon from "@/components/icons/Icon";
import {
  ROCKET_SRC, fmtAgeShort, rankTrending, thumbSrc, tierProgress,
  type HomeCoin, type HomeData,
} from "@/lib/home/trending";
import { afterPaint, prefersReducedMotion } from "./idle";
import HeroPad, { LIFTOFF_MS, SKY, SKY_DESKTOP_MQ, SKY_MOBILE_MQ, SKY_SIZES } from "./HeroPad";
import s from "./appHome.module.css";

const POLL_MS = 30_000;
/** Tileable film grain (BRAND home-hero layers r1), overlay at .3; loaded after paint. */
const GRAIN_SRC = "/home/pad/grain.webp";
const baseSet = (list: string) => list.split(", ").map((e) => { const [u, w] = e.split(" "); return `${withBase(u)} ${w}`; }).join(", ");

function usd(v: number) {
  if (v > 0 && v < 10) return "$" + v.toFixed(2);
  return fmtUsd(v);
}

function Chg({ v, className }: { v: number | null | undefined; className?: string }) {
  if (v == null) return null;
  const up = v >= 0;
  return <span className={`${s.chg} ${up ? s.up : s.dn}${className ? " " + className : ""}`}>{up ? "▲" : "▼"} {Math.abs(v).toFixed(1)}%</span>;
}

/** Coin page link (same query the feed builds): the flight page carries the always-open BOOST / DUMP trade bar. */
export function heroHref(c: HomeCoin) {
  const q = new URLSearchParams();
  q.set("coin", c.token);
  q.set("launched", "1");
  if (c.icon) q.set("icon", c.icon);
  if (c.pairSym) q.set("pair", c.pairSym);
  q.set("nm", c.name);
  q.set("cs", c.ticker);
  return `/coin/${c.token}?${q.toString()}`;
}

function Stat({ label, value }: { label: string; value: string | null }) {
  if (value == null) return null;
  return <div className={s.stat}><span>{label}</span><b>{value}</b></div>;
}

export default function HomeHero({ data: initial }: { data: HomeData }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [go, setGo] = useState(false);
  const [now, setNow] = useState(initial.at || 0);
  const heroToken = useRef(initial.hero).current; // fixed for the visit
  const ref = useRef<HTMLElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [launching, setLaunching] = useState(false);
  const launchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hero = useMemo(
    () => data.coins.find((c) => c.token === heroToken) ?? initial.coins.find((c) => c.token === heroToken) ?? null,
    [data, heroToken, initial.coins],
  );
  const mode = initial.heroMode;
  const next = useMemo(() => rankTrending(data.coins).filter((c) => c.token !== heroToken).slice(0, 8), [data.coins, heroToken]);
  const tier = tierProgress(hero?.mcapUsd ?? 0);

  // Chrome strip floats transparent over the hero (same contract as the previous home).
  useEffect(() => {
    document.body.classList.add("home");
    const onScroll = () => {
      const h = ref.current?.offsetHeight ?? 0;
      document.body.classList.toggle("home-top", window.scrollY < h - 64);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      document.body.classList.remove("home", "home-top");
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  // After paint: start sky + pad motion, then keep the numbers fresh (paused while the tab is hidden).
  useEffect(() => afterPaint(() => { setNow(Date.now()); setGo(true); }), []);
  useEffect(() => {
    if (!go || !heroToken) return;
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch(`/api/home?coin=${heroToken}`);
        if (!r.ok) return;
        const d = (await r.json()) as HomeData;
        if (!alive) return;
        setNow(Date.now());
        setData(d);
        window.dispatchEvent(new CustomEvent("dsc:home-data", { detail: d }));
      } catch { /* keep the last numbers */ }
    };
    const iv = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [go, heroToken]);

  const href = hero ? heroHref(hero) : "/create";
  const warm = () => { if (hero) router.prefetch(href); };

  // The flight route is prefetched on hover / focus / touch (warm) and again at the click, so it is ready by the time
  // the 1.3s lift-off clears the frame. (Not on mount: that pulls the flight-page JS into every home visit.)
  // Back/forward cache restores the page mid-launch: put the rocket back on the pad.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) setLaunching(false); };
    window.addEventListener("pageshow", onShow);
    return () => { window.removeEventListener("pageshow", onShow); if (launchTimer.current) clearTimeout(launchTimer.current); };
  }, []);
  /** BOOST / DUMP: lift-off (LIFTOFF_MS), then the same flight-page navigation the link does. Plain link behaviour for
   *  modified clicks (new tab etc.) and under prefers-reduced-motion. */
  const liftOff = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || prefersReducedMotion()) return;
    e.preventDefault();
    if (launchTimer.current) return;
    router.prefetch(href);
    setLaunching(true);
    launchTimer.current = setTimeout(() => router.push(href), LIFTOFF_MS);
  };
  const scrollStrip = (d: number) => stripRef.current?.scrollBy({ left: d * 206, behavior: "smooth" });
  const st = hero?.stats ?? null;

  return (
    <>
      {/* LCP: the sky plate (AVIF, same candidates as the <picture> in HeroPad) + the rocket sprite (React hoists these into <head>) */}
      <link rel="preload" as="image" type="image/avif" media={SKY_DESKTOP_MQ} imageSrcSet={baseSet(SKY.desktopAvif)} imageSizes={SKY_SIZES} fetchPriority="high" />
      <link rel="preload" as="image" type="image/avif" media={SKY_MOBILE_MQ} imageSrcSet={baseSet(SKY.mobileAvif)} imageSizes={SKY_SIZES} fetchPriority="high" />
      <link rel="preload" as="image" type="image/webp" href={withBase(ROCKET_SRC)} />
      <section ref={ref} className={`${s.hero}${go ? " " + s.go : ""}${launching ? " " + s.launching : ""}`} aria-label={hero ? `#1 trending rocket: ${hero.name}` : "Trending rocket"}>
        <div className={s.stage}>
          {/* plate frame: sky (pad baked in) + stars + moon + pad + rocket + exhaust + smog, all registered to the sky */}
          <HeroPad go={go} launching={launching} />
          {/* film grain over the whole scene (restores the plate grain the WebP/AVIF encode drops), then the scrims */}
          <div className={s.grain} style={go ? { backgroundImage: `url(${withBase(GRAIN_SRC)})` } : undefined} aria-hidden />
          <div className={s.scrim} aria-hidden />
          <div className={s.panel}>
            {hero && <div className={s.eyebrow}><span className={s.dot} aria-hidden />{mode === "newest" ? "Newest launch" : "#1 Trending · 24h"}</div>}
            {hero ? (
              <>
                <div className={s.ident}>
                  <span className={s.av}><PairArt src={hero.icon || undefined} pair={hero.pairSym} tk={hero.ticker} tint="#E8EAEE" size="list" fluid eager /></span>
                  <div className={s.identTxt}>
                    <Link href={href} prefetch={false} className={s.name} onMouseEnter={warm} onFocus={warm}>{hero.name}</Link>
                    <div className={s.sub}><span className={s.num}>${hero.ticker}</span> · <Icon name="base-pair" size={14} className={s.subIc} /> paired with {hero.pairSym}</div>
                  </div>
                </div>
                <div className={s.mcap}>
                  <span className={s.mcapV}>{fmtUsd(hero.mcapUsd)}</span>
                  <Chg v={st?.chg24} />
                  <span className={s.mcapL}>MCAP{st?.chg24 != null ? " · 24H" : ""}</span>
                </div>
                <div className={s.tier}>
                  <div className={s.tierHd}>
                    <span><Icon name="altitude" size={13} /> TIER {String(tier.index).padStart(2, "0")} · {tier.name}</span>
                    <span className={s.tierPct}>{Math.round(tier.progress * 100)}%</span>
                    {tier.next && tier.toNext != null && <span className={s.tierM}>{usd(tier.toNext)} to {tier.next.title}</span>}
                  </div>
                  <div className={s.bar} role="progressbar" aria-label={`Progress to ${tier.next?.title ?? "top tier"}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(tier.progress * 100)}>
                    <i style={{ width: `${(tier.progress * 100).toFixed(1)}%` }} />
                  </div>
                  {tier.next && tier.toNext != null && (
                    <div className={s.tierFt}><span>next · {tier.next.title} {fmtUsd(tier.next.lo)}</span><span>{usd(tier.toNext)} of BOOST to go</span></div>
                  )}
                </div>
                <div className={s.stats}>
                  <Stat label="Crew" value={st?.crew != null ? st.crew.toLocaleString("en-US") : null} />
                  <Stat label="Vol 24h" value={st ? fmtUsd(st.vol24) : null} />
                  <Stat label="Bombs 24h" value={st ? st.bombs24.toLocaleString("en-US") : null} />
                  <Stat label="Age" value={hero.launchedAt && now ? fmtAgeShort(now - hero.launchedAt) : null} />
                </div>
                <div className={s.actions}>
                  <Link href={href} prefetch={false} className={`${s.btn} ${s.boost}`} onMouseEnter={warm} onFocus={warm} onPointerDown={warm} onClick={liftOff} aria-label={`BOOST $${hero.ticker} on its flight page`}>
                    <Icon name="boost" size={18} />BOOST ${hero.ticker}
                  </Link>
                  <Link href={href} prefetch={false} className={`${s.btn} ${s.dump}`} onMouseEnter={warm} onFocus={warm} onPointerDown={warm} onClick={liftOff} aria-label={`DUMP $${hero.ticker} on its flight page`}>
                    <Icon name="dump" size={18} />DUMP
                  </Link>
                  <Link href={href} prefetch={false} className={`${s.btn} ${s.ghost}`} onMouseEnter={warm} onFocus={warm}>
                    Open flight <Icon name="chevron-right" size={16} />
                  </Link>
                </div>
              </>
            ) : (
              <>
                <h1 className={s.emptyT}>No rockets yet</h1>
                <div className={s.actions}>
                  <Link href="/create" className={`${s.btn} ${s.primary}`}><Icon name="plus" size={18} />Launch the first one</Link>
                </div>
              </>
            )}
          </div>
        </div>
        {next.length > 0 && (
          <div className={s.strip} aria-label="Next trending">
            <div className={s.stripHd}>
              <span className={s.eyebrowSm}>Next trending</span>
              {next.length > 3 && (
                <span className={s.arrows}>
                  <button type="button" onClick={() => scrollStrip(-1)} aria-label="Scroll Next trending left"><Icon name="chevron-left" size={14} /></button>
                  <button type="button" onClick={() => scrollStrip(1)} aria-label="Scroll Next trending right"><Icon name="chevron-right" size={14} /></button>
                </span>
              )}
            </div>
            <div className={s.minis} ref={stripRef}>
              {next.map((c, i) => (
                <Link key={c.token} href={heroHref(c)} prefetch={false} className={s.mini}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className={s.miniTh} src={withBase(thumbSrc(tierProgress(c.mcapUsd).index))} alt="" width={64} height={40} loading="lazy" decoding="async" />
                  <span className={s.miniTx}>
                    <span className={s.miniR}><span className={s.miniN}>#{i + 2}</span><b>${c.ticker}</b></span>
                    <span className={s.miniR2}><span className={s.num}>{fmtUsd(c.mcapUsd)}</span><Chg v={c.stats?.chg24} /></span>
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
