"use client";
/**
 * iPhone app home, concept C "Play feed" (maker picked 2026-11-16, mockup https://claude.ai/artifact/Re98NdbGd8G75ika5gFf3U).
 * The app only: the website lobby is unchanged (AppSwitch picks one before paint from the app's user agent).
 *   Daily missions bar → /achievements
 *   Featured: today's daily flight (Free play) with the time left until 00:00 UTC
 *   Trading duel card → the duel lobby
 *   Flying now: a shelf of real rockets (Live window cards); the last card and See all open Live rockets (search + sort)
 *   Host a launch
 *   Practice: Turbo royale + Free play
 * The Play tab in the app tab bar is this screen; tapping it again here opens Quick play (QUICK_PLAY_EVENT).
 * Every number is live (HomeData + the pilot's XP). Nothing here pays cash or tokens.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { withBase } from "@/lib/base-path";
import { DUEL_HREF } from "@/lib/features";
import type { HomeData } from "@/lib/home/trending";
import { flyingNow } from "@/lib/home/appHome";
import { dailyEndsAt, dailyToday } from "@/lib/sim/daily";
import { untilLabel, usePilotWallet, useXp } from "@/lib/xpClient";
import Icon from "@/components/icons/Icon";
import LiveCard from "@/components/home/LiveCard";
import LiveRockets from "./LiveRockets";
import { QUICK_PLAY_EVENT } from "./events";
import s from "./appHome.module.css";

const POLL_MS = 30_000;
const FREE_HREF = "/flight/sim";
const ROYALE_HREF = "/turbo/royale";

function useLiveHome(init: HomeData) {
  const [data, setData] = useState(init);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch("/api/home");
        if (r.ok) { const d = (await r.json()) as HomeData; if (alive) setData(d); }
      } catch { /* keep the last numbers */ }
    };
    const iv = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, []);
  return data;
}

type Sheet = null | "quick" | "rockets";

export default function AppHome({ initial }: { initial: HomeData }) {
  const data = useLiveHome(initial);
  const coins = data.coins;
  const shelf = useMemo(() => flyingNow(coins), [coins]);
  const flying = useMemo(() => coins.filter((c) => !c.graduated).length, [coins]);
  const wallet = usePilotWallet();
  const { xp } = useXp(wallet);
  const [now, setNow] = useState(0);
  useEffect(() => { setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);

  const [sheet, setSheet] = useState<Sheet>(null);
  const close = useCallback(() => setSheet(null), []);
  useEffect(() => {
    const open = () => setSheet((v) => (v ? null : "quick"));
    addEventListener(QUICK_PLAY_EVENT, open);
    return () => removeEventListener(QUICK_PLAY_EVENT, open);
  }, []);
  // Live rockets is full screen (the tab bar steps aside, like while typing); Quick play sits above the tab bar, so tapping
  // Play again closes it
  useEffect(() => {
    document.documentElement.classList.toggle("app-sheet", sheet === "rockets");
    return () => document.documentElement.classList.remove("app-sheet");
  }, [sheet]);

  const missions = xp?.daily.missions ?? null;
  const done = missions ? missions.filter((m) => m.done).length : 0;
  const left = missions ? missions.filter((m) => !m.done).reduce((t, m) => t + m.xp, 0) : 0;
  const ends = now ? untilLabel(dailyEndsAt(dailyToday()), now) : "";

  return (
    <div className={s.home} data-testid="app-home">
      {missions && (
        <Link href="/achievements" className={s.mbar} data-testid="app-missions">
          <b>Daily missions</b>
          <span className={s.mbarTrack} aria-hidden><i style={{ width: `${(done / Math.max(1, missions.length)) * 100}%` }} /></span>
          <span className={s.mbarN}>{done}/{missions.length}{left ? ` · +${left.toLocaleString("en-US")} XP` : ""}</span>
        </Link>
      )}

      <Link href={FREE_HREF} className={s.feat} data-testid="app-featured">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={withBase("/art/modes/free.webp")} alt="" loading="lazy" decoding="async" />
        <span className={s.featTag}>Today</span>
        {ends && <span className={s.featTime} suppressHydrationWarning>Ends in {ends}</span>}
        <span className={s.featBody}>
          <span>
            <b>The daily flight</b>
            <span>Same sky for everyone. No cash needed.</span>
          </span>
          <em>Fly</em>
        </span>
      </Link>

      <section className={s.sec} aria-labelledby="app-duel">
        <h2 id="app-duel" className={s.secT}>Trading duel</h2>
        <Link href={DUEL_HREF} className={s.duel} data-testid="app-duel">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={withBase("/art/modes/duel.webp")} alt="" loading="lazy" decoding="async" />
          <span className={s.duelTx}>
            <b>1v1 duel</b>
            <span>Three minutes. Most profit wins.</span>
          </span>
          <em>Fight</em>
        </Link>
      </section>

      <section className={s.sec} aria-labelledby="app-flying">
        <header className={s.secHd}>
          <h2 id="app-flying" className={s.secT}>{flying > 0 && <i className={s.dot} aria-hidden />}Flying now</h2>
          <button type="button" className={s.secMore} onClick={() => setSheet("rockets")} data-testid="app-flying-all">See all <Icon name="chevron-right" size={14} /></button>
        </header>
        {shelf.length ? (
          <div className={s.shelf} data-testid="app-flying-shelf">
            {shelf.map((c) => <div key={c.token} className={s.shelfCard}><LiveCard c={c} testId="app-flying-card" /></div>)}
            <button type="button" className={s.shelfAll} onClick={() => setSheet("rockets")} data-testid="app-flying-search">
              <Icon name="search" size={24} />
              <span>Search all<br />rockets</span>
            </button>
          </div>
        ) : (
          <button type="button" className={s.none} onClick={() => setSheet("rockets")}>
            <b>Nothing flying yet</b>
            <span>Host the first launch and your crew flies it up.</span>
          </button>
        )}
        <Link href="/create" className={s.host} data-testid="app-host">
          <span><b>Host a launch</b><span>Build a rocket. The crew flies it up.</span></span>
          <Icon name="chevron-right" size={20} />
        </Link>
      </section>

      <section className={s.sec} aria-labelledby="app-practice">
        <h2 id="app-practice" className={s.secT}>Practice</h2>
        <div className={s.prac}>
          <Link href={ROYALE_HREF} className={s.tile} data-testid="app-royale">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={withBase("/art/modes/last-pilot.webp")} alt="" loading="lazy" decoding="async" />
            <span className={s.tileTag} style={{ color: "#F2C14E" }}>Practice</span>
            <span className={s.tileTx}><b>Turbo royale</b><span>12 pilots. Last one flying.</span></span>
          </Link>
          <Link href={FREE_HREF} className={s.tile} data-testid="app-free">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={withBase("/art/modes/free.webp")} alt="" loading="lazy" decoding="async" />
            <span className={s.tileTag} style={{ color: "#8FE3FF" }}>Free</span>
            <span className={s.tileTx}><b>Free play</b><span>No cash. Today&apos;s flight.</span></span>
          </Link>
        </div>
      </section>

      {sheet === "quick" && (
        <div className={s.quickWrap} onClick={close} data-testid="app-quick-play">
          <div className={s.quick} role="dialog" aria-modal="true" aria-labelledby="app-quick-title" onClick={(e) => e.stopPropagation()}>
            <header className={s.sheetHd}>
              <h2 id="app-quick-title" className={s.sheetT}>Quick play</h2>
              <button type="button" className={s.x} onClick={close} aria-label="Close"><Icon name="close" size={20} /></button>
            </header>
            <div className={s.opts}>
              <Link href={DUEL_HREF} className={`${s.opt} ${s.optHot}`} onClick={close} data-testid="quick-duel"><Thumb src="/art/modes/duel.webp" /><span><b>Trading duel</b><span>1v1 · 3 minutes</span></span><Icon name="chevron-right" size={20} /></Link>
              <Link href={ROYALE_HREF} className={s.opt} onClick={close} data-testid="quick-royale"><Thumb src="/art/modes/last-pilot.webp" /><span><b>Turbo royale</b><span>12 pilots · practice money</span></span><Icon name="chevron-right" size={20} /></Link>
              <Link href={FREE_HREF} className={s.opt} onClick={close} data-testid="quick-free"><Thumb src="/art/modes/free.webp" /><span><b>Free play</b><span>Today&apos;s flight · no cash</span></span><Icon name="chevron-right" size={20} /></Link>
              <button type="button" className={s.opt} onClick={() => setSheet("rockets")} data-testid="quick-coins"><Thumb src="/art/modes/live.webp" /><span><b>Real coins</b><span>{flying ? `${flying} flying · search and join` : "Host or join a launch"}</span></span><Icon name="chevron-right" size={20} /></button>
            </div>
          </div>
        </div>
      )}
      <LiveRockets coins={coins} open={sheet === "rockets"} onClose={close} />
    </div>
  );
}

function Thumb({ src }: { src: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={s.optTh} src={withBase(src)} alt="" loading="lazy" decoding="async" />;
}
