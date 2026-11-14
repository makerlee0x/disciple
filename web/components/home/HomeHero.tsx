"use client";
/**
 * Lobby door one (brand v3 lobby mockup): a card, about 3/4 of the row, with LAUNCH A ROCKET over the BRAND night plate
 * (home-hero layers r1). The chrome
 * rocket sits in the mount ring of the layered pad (HeroPad: one plate frame with the sky, pad, moon, stars, smog and
 * exhaust glow); START A LAUNCH plays the lift-off and then opens the launch builder (/create).
 * Door two (join a live flight) and the daily missions sit in the column beside it (components/home/Lobby).
 * Server-rendered with the data (app/page.tsx), so the sky plate is the LCP and needs no client fetch. Sky/pad idle
 * motion and the 30s numbers poll start after paint; each poll is re-broadcast as "dsc:home-data" for the lobby + feed.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/base-path";
import { ROCKET_SRC, type HomeData } from "@/lib/home/trending";
import Icon from "@/components/icons/Icon";
import { afterPaint, prefersReducedMotion } from "./idle";
import HeroPad, { LIFTOFF_MS, SKY, SKY_DESKTOP_MQ, SKY_MOBILE_MQ, SKY_SIZES } from "./HeroPad";
import s from "./appHome.module.css";

const POLL_MS = 30_000;
const LAUNCH_HREF = "/create";
/** Tileable film grain (BRAND home-hero layers r1), overlay at .3; loaded after paint. */
const GRAIN_SRC = "/home/pad/grain.webp";
const baseSet = (list: string) => list.split(", ").map((e) => { const [u, w] = e.split(" "); return `${withBase(u)} ${w}`; }).join(", ");

/** "$880K", "$622.6K", "$1.2M" */
const short = (v: number) => { const [d, u] = v >= 1e9 ? [1e9, "B"] : v >= 1e6 ? [1e6, "M"] : v >= 1e3 ? [1e3, "K"] : [1, ""]; return `$${(v / d).toFixed(v >= 1e3 ? 1 : 0).replace(/\.0$/, "")}${u}`; };

export default function HomeHero({ data: initial }: { data: HomeData }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [go, setGo] = useState(false);
  const [pollErr, setPollErr] = useState(false);
  const [launching, setLaunching] = useState(false);
  const launchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // After paint: start sky + pad motion, then keep the lobby numbers fresh (paused while the tab is hidden).
  useEffect(() => afterPaint(() => setGo(true)), []);
  useEffect(() => {
    if (!go || !initial.coins.length) return;
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch("/api/home");
        if (!r.ok) { if (alive) setPollErr(true); return; }
        const d = (await r.json()) as HomeData;
        if (!alive) return;
        setPollErr(false);
        setData(d);
        window.dispatchEvent(new CustomEvent("dsc:home-data", { detail: d }));
      } catch { if (alive) setPollErr(true); /* keep the last numbers */ }
    };
    const iv = setInterval(tick, POLL_MS);
    void tick();
    return () => { alive = false; clearInterval(iv); };
  }, [go, initial.coins.length]);

  // Back/forward cache restores the page mid-launch: put the rocket back on the pad.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) setLaunching(false); };
    window.addEventListener("pageshow", onShow);
    return () => { window.removeEventListener("pageshow", onShow); if (launchTimer.current) clearTimeout(launchTimer.current); };
  }, []);
  const warm = () => router.prefetch(LAUNCH_HREF);
  /** START A LAUNCH: lift-off (LIFTOFF_MS), then the launch builder. Plain link for modified clicks and reduced motion. */
  const liftOff = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || prefersReducedMotion()) return;
    e.preventDefault();
    if (launchTimer.current) return;
    router.prefetch(LAUNCH_HREF);
    setLaunching(true);
    launchTimer.current = setTimeout(() => router.push(LAUNCH_HREF), LIFTOFF_MS);
  };

  const first = data.coins.length === 0;
  // live facts (maker 2026-11-13: not "18 tiers / 1 flying"): the highest rocket right now and what traded in the last 24h
  const top = data.coins.reduce<HomeData["coins"][number] | null>((b, c) => (!b || c.mcapUsd > b.mcapUsd ? c : b), null);
  const vol24 = data.coins.reduce((a, c) => a + (c.stats?.vol24 ?? 0), 0);

  return (
    <>
      {/* LCP: the sky plate (AVIF, same candidates as the <picture> in HeroPad) + the rocket sprite (React hoists these into <head>) */}
      <link rel="preload" as="image" type="image/avif" media={SKY_DESKTOP_MQ} imageSrcSet={baseSet(SKY.desktopAvif)} imageSizes={SKY_SIZES} fetchPriority="high" />
      <link rel="preload" as="image" type="image/avif" media={SKY_MOBILE_MQ} imageSrcSet={baseSet(SKY.mobileAvif)} imageSizes={SKY_SIZES} fetchPriority="high" />
      <link rel="preload" as="image" type="image/webp" href={withBase(ROCKET_SRC)} />
      {pollErr && (
        <div className={s.pollErr} role="status" data-testid="home-poll-err">
          Live numbers paused. Showing the last update and retrying.
        </div>
      )}
      <section className={s.hero} aria-labelledby="lobby-launch-title" data-testid="lobby-launch">
        <div className={s.stage}>
          {/* plate frame: sky (pad baked in) + stars + moon + pad + rocket + exhaust + smog, all registered to the sky */}
          <HeroPad go={go} launching={launching} layout="card" />
          {/* film grain over the whole scene (restores the plate grain the WebP/AVIF encode drops), then the scrims */}
          <div className={s.grain} style={go ? { backgroundImage: `url(${withBase(GRAIN_SRC)})` } : undefined} aria-hidden />
          <div className={s.scrim} aria-hidden />
          <div className={s.panel}>
            {first && <span className={s.step}>Be the first</span>}
            {/* the X header's line (maker 2026-11-13) */}
            <h1 id="lobby-launch-title" className={`dsc3-hero ${s.title}`}>To the<br />moon</h1>
            <p className={s.lede}>Every coin is a rocket. Launch yours and the crew flies it up.</p>
            <div className={s.actions}>
              <Link href={LAUNCH_HREF} className="dsc3-btn dsc3-btn-primary dsc3-btn-lg" onMouseEnter={warm} onFocus={warm} onPointerDown={warm} onClick={liftOff} data-testid="lobby-start-launch">
                Start a launch <Icon name="chevron-right" size={20} />
              </Link>
              <Link href="/how-it-works" className={`dsc3-btn dsc3-btn-ghost ${s.ghostLg}`}>How to play</Link>
            </div>
            <dl className={s.facts}>
              {top && <div><dt>{short(top.mcapUsd)}</dt><dd>${top.ticker} is the highest rocket</dd></div>}
              {vol24 >= 1 && <div><dt>{short(vol24)}</dt><dd>traded in the last 24 hours</dd></div>}
            </dl>
          </div>
        </div>
      </section>
    </>
  );
}
