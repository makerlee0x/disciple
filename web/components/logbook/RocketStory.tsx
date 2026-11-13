"use client";
/**
 * /logbook/[coin]: one rocket's story (main mode hook loop mockup board "1b One rocket's story", maker 2026-11-13).
 * Its flight and your part in it as a timeline (boarded, crew joined, bombs held, zones, orbit), three tiles (aboard,
 * zones climbed, on paper or banked), Share this flight and Open rocket. Real fills only (GET /api/logbook&coin=).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { onWallet } from "@/lib/wallet";
import { privyAccessToken } from "@/lib/aa/sessionState";
import { devSample } from "@/lib/devSample";
import { difficultyOf } from "@/lib/difficulty";
import type { LogEntry, StoryEvent } from "@/lib/logbook";
import ShareModal from "@/components/share/ShareModal";
import { titleCase } from "./LogbookView";
import s from "./logbook.module.css";

type Story = { entry: LogEntry; story: StoryEvent[]; index: number; total: number; host: string | null; hostName?: string | null; own: boolean };

const when = (ts: number) => new Date(ts).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
function short(ms: number) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}
const money = (v: number) => `${v < 0 ? "-" : "+"}$${Math.abs(v) >= 10 ? Math.round(Math.abs(v)).toLocaleString("en-US") : Math.abs(v).toFixed(2)}`;

function Item({ e, last, crewTag }: { e: StoryEvent; last: boolean; crewTag: string | null }) {
  let dot = s.dot, head = s.tlHead, title = "", sub = "";
  if (e.kind === "boarded") { dot = `${s.dot} ${s.dotGold}`; head = `${s.tlHead} ${s.tlHeadHi}`; title = `You boarded · ${titleCase(e.zone ?? "")}`; sub = `${when(e.at)} · pilot #${e.pilotNo}${e.firstCrew ? ", first crew" : ""}`; }
  else if (e.kind === "crew_joined") { title = `Crew${crewTag ? ` [${crewTag}]` : ""} joined`; sub = `${e.crew} ${e.crew === 1 ? "crewmate" : "crewmates"} boarded within the hour`; }
  else if (e.kind === "bomb_held") { dot = `${s.dot} ${s.dotPink}`; title = "Bomb · you held"; sub = `A ${e.impactPct}% dump landed`; }
  else if (e.kind === "zone") { title = titleCase(e.zone ?? ""); sub = `${when(e.at)} · ${e.passengers} passengers`; }
  else if (e.kind === "orbit") { dot = `${s.dot} ${s.dotOrbit}`; head = `${s.tlHead} ${s.tlHeadGold}`; title = "In orbit · you were aboard"; sub = `${when(e.at)} · 1 of ${e.pilotsAboard} pilots aboard`; }
  else if (e.kind === "left") { title = `You left · ${titleCase(e.zone ?? "")}`; sub = when(e.at); }
  return (
    <div className={s.tlItem}>
      <div className={s.tlRail}><span className={dot} />{!last && <span className={s.line} />}</div>
      <div className={s.tlBody}><div className={head}>{title}</div><div className={s.tlSub}>{sub}</div></div>
    </div>
  );
}

export default function RocketStory({ coin }: { coin: string }) {
  const [me, setMe] = useState<string | null>(null);
  const [other, setOther] = useState<string | null | undefined>(undefined);
  useEffect(() => { const w = new URLSearchParams(location.search).get("wallet"); setOther(w && /^0x[0-9a-fA-F]{40}$/.test(w) ? w.toLowerCase() : null); }, []);
  const [d, setD] = useState<Story | null>(null);
  const [missing, setMissing] = useState(false);
  const [share, setShare] = useState(false);
  const sample = process.env.NODE_ENV === "development" && devSample();
  useEffect(() => onWallet((a) => setMe(a ?? null)), []);
  const wallet = (other || me || "").toLowerCase();

  useEffect(() => {
    if (sample) { import("@/lib/mock/hookLoop").then((m) => setD(m.sampleStory())); return; }
    if (!wallet || other === undefined) return;
    let alive = true;
    (async () => {
      const token = !other ? await privyAccessToken().catch(() => null) : null;
      const r = await fetch(`/api/logbook?wallet=${wallet}&coin=${coin}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, cache: "no-store" }).catch(() => null);
      if (!alive) return;
      if (r && r.ok) setD((await r.json()) as Story); else setMissing(true);
    })();
    return () => { alive = false; };
  }, [wallet, coin, other, sample]);

  const back = other ? `/logbook?wallet=${other}` : sample ? "/logbook?sample=1" : "/logbook";
  if (!d) return <div className={s.story}><Link href={back} className={s.back} aria-label="Back to logbook"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M15 18l-6-6 6-6" /></svg></Link>{missing ? <p className={s.empty}>This rocket isn&apos;t in this logbook.</p> : <div className={s.loading} aria-busy="true" />}</div>;

  const e = d.entry;
  const mode = difficultyOf(e.mode ?? null)?.label;
  const host = d.hostName ? `@${d.hostName}` : d.host ? `${d.host.slice(0, 6)}…` : null;
  const third = e.status === "aboard" && e.paperPct !== null
    ? <div className={s.tile}><b className={e.paperPct >= 0 ? s.up : s.down}>{e.paperPct >= 0 ? "+" : ""}{Math.round(e.paperPct)}%</b><span>on paper</span></div>
    : <div className={s.tile}><b className={e.bankedUsd >= 0 ? s.up : s.down}>{money(e.bankedUsd)}</b><span>banked</span></div>;

  return (
    <div className={s.story} data-testid="rocket-story">
      <div className={s.storyTop}>
        <Link href={back} className={s.back} aria-label="Back to logbook"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M15 18l-6-6 6-6" /></svg></Link>
        <span className={s.eb}>Logbook · rocket {d.index} of {d.total}</span>
      </div>
      <div>
        <div className={s.storyTitle}><span className={s.storyTicker}>${e.ticker}</span>{e.graduated && <span className={`${s.badge} ${s.bOrbit}`}>IN ORBIT</span>}</div>
        <div className={s.storySub}>{[e.name, host ? `hosted by ${host}` : "", mode].filter(Boolean).join(" · ")}</div>
      </div>
      <section className={s.panel}>
        <span className={s.eb}>Its flight, your part in it</span>
        <div className={s.tl}>{d.story.map((x, i) => <Item key={`${x.kind}${x.at}`} e={x} last={i === d.story.length - 1} crewTag={null} />)}</div>
      </section>
      <div className={s.tiles}>
        <div className={s.tile}><b>{short(e.aboardMs)}</b><span>aboard</span></div>
        <div className={s.tile}><b>{e.zonesClimbed}</b><span>zones climbed</span></div>
        {third}
      </div>
      <div className={s.grow} />
      <div className={s.btns}>
        {d.own && <button type="button" className={s.gold} onClick={() => setShare(true)}>Share this flight</button>}
        <Link href={`/coin/${e.coin}`} className={s.ghost}>Open rocket</Link>
      </div>
      {e.status === "aboard" && <p className={s.note}>&quot;On paper&quot; is your bag at the last trade price, before fees. It isn&apos;t banked until you dump.</p>}
      {share && <ShareModal target={{ coin: e.coin, ticker: e.ticker, wallet: wallet || null, username: null, sample }} onClose={() => setShare(false)} />}
    </div>
  );
}
