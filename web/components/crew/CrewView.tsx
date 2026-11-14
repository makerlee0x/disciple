"use client";
/**
 * /crew (main mode hook loop mockup board "Crew flights", maker 2026-11-13): your crew's record with you, where it's
 * flying now, the crew-first wingmen note, Fly with me (link + what they see) and the weekly crew mission.
 * Owner only (GET /api/crew). Crew shows who is aboard, never sizes, entry prices or when anyone bought.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { onWallet } from "@/lib/wallet";
import { privyAccessToken } from "@/lib/aa/sessionState";
import { devSample } from "@/lib/devSample";
import { difficultyOf } from "@/lib/difficulty";
import { flyPath, type CrewPage, type CrewFlying } from "@/lib/crew";
import { titleCase } from "@/components/logbook/LogbookView";
import s from "./crew.module.css";

const AVATAR = ["#5FF0A0", "#44D4E2", "#F3DFA8", "#FF7A3D", "#B8A6FF"];
const initials = (n: string | null, w: string) => (n ? n.replace(/[^a-z0-9]/gi, "").slice(0, 2) : w.slice(2, 4)).toUpperCase();
const since = (ts: number | null) => (ts ? new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null);
function dur(ms: number) {
  if (ms <= 0) return "0m";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}
const where = (f: CrewFlying) => [f.graduated ? f.zone : titleCase(f.zone), difficultyOf(f.mode ?? null)?.label].filter(Boolean).join(" · ");

export const CREW_COPY = {
  none: { title: "No crew yet", body: "Join a crew from your Hangar to fly together, see where they're aboard and take on the weekly crew mission.", cta: "Open your Hangar" },
  flyingEmpty: "No one from your crew is aboard a rocket right now.",
  privacy: "Crew shows who is aboard, never sizes, entry prices or when anyone bought.",
  wingmen: "In flight: your crew flies as wingmen first",
  flyBody: "Your link opens the rocket with your crew shown. It never says when you boarded or what you paid.",
  seeBody: "Real coin, real money. Read how rockets work before you board.",
} as const;

export default function CrewView() {
  const [me, setMe] = useState<string | null | undefined>(undefined);
  const [d, setD] = useState<CrewPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("https://disciple.vip");
  const sample = process.env.NODE_ENV === "development" && devSample();
  useEffect(() => { setOrigin(location.origin); return onWallet((a) => setMe(a ?? null)); }, []);
  useEffect(() => {
    if (sample) { import("@/lib/mock/hookLoop").then((m) => setD(m.sampleCrew())); return; }
    if (!me) return;
    let alive = true;
    (async () => {
      const token = await privyAccessToken().catch(() => null);
      const r = await fetch(`/api/crew?wallet=${me.toLowerCase()}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, cache: "no-store" }).catch(() => null);
      if (!alive) return;
      if (r?.ok) setD((await r.json()) as CrewPage); else setErr(r?.status === 401 ? "Sign in to see your crew." : "Crew is unavailable right now.");
    })();
    return () => { alive = false; };
  }, [me, sample]);

  if (!d) return <div className={s.page}><h1 className={s.h1}>Crew</h1>{me === null && !sample ? <p className={s.sub}>Sign in to see your crew.</p> : err ? <p className={s.sub}>{err}</p> : <div className={s.loading} aria-busy="true" />}</div>;
  if (!d.crew) return (
    <div className={s.page}><h1 className={s.h1}>Crew</h1>
      <div className={s.card}><b className={s.emptyT}>{CREW_COPY.none.title}</b><p className={s.sub}>{CREW_COPY.none.body}</p><Link href="/profile" className={s.gold}>{CREW_COPY.none.cta}</Link></div>
    </div>
  );

  const c = d.crew, r = d.record, tag = `[${c.tag}]`;
  const pick = d.flying.find((f) => f.you) ?? d.flying[0] ?? null;
  const who = d.username ?? me ?? "";
  const link = pick && who ? `${origin}${flyPath(who, pick.ticker)}` : null;
  const mates = d.flying.flatMap((f) => f.aboard).filter((m, i, a) => a.findIndex((x) => x.wallet === m.wallet) === i).slice(0, 3);
  const copy = async () => { if (!link) return; try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ } };

  return (
    <div className={s.page} data-testid="crew">
      <div className={s.cols}>
        <div className={s.main}>
          <div className={s.head}>
            <span className={s.mark}>{c.tag}</span>
            <div><h1 className={s.h1}>{tag} {c.name}</h1>
              <div className={s.sub}>{c.members} {c.members === 1 ? "pilot" : "pilots"}{since(c.since) ? ` · flying together since ${since(c.since)}` : ""}</div></div>
          </div>
          <div className={s.stats}>
            <div className={s.stat}><b>{r.together}</b><span>rockets flown together</span></div>
            <div className={s.stat}><b className={s.goldTxt}>{r.orbits}</b><span>orbits as a crew</span></div>
            <div className={s.stat}><b>{dur(r.longestMs)}</b><span>longest crew stay</span></div>
            <div className={s.stat}><b>{r.rank ? `#${r.rank}` : "—"}</b><span>crews board, this week</span></div>
          </div>
          <span className={s.eb}>Where the crew is flying</span>
          {d.flying.length === 0 ? <p className={s.sub}>{CREW_COPY.flyingEmpty}</p> : (
            <div className={s.list}>{d.flying.map((f) => (
              <div key={f.coin} className={s.row}>
                <span className={s.ticker}>${f.ticker}</span>
                <span className={`${s.zone} ${f.graduated ? s.goldTxt : ""}`}>{where(f)}</span>
                <div className={s.faces}>
                  {f.aboard.slice(0, 4).map((m, i) => <span key={m.wallet} className={s.face} style={{ background: AVATAR[i % AVATAR.length] }} title={m.name ?? undefined}>{initials(m.name, m.wallet)}</span>)}
                  <span className={s.count}>{f.count} of your crew aboard</span>
                </div>
                <Link href={`/coin/${f.coin}`} className={s.ghost}>View rocket</Link>
              </div>
            ))}</div>
          )}
          <p className={s.foot}>{CREW_COPY.privacy}</p>
          <span className={s.eb}>{CREW_COPY.wingmen}</span>
          <div className={s.sky}>
            <svg width="100%" height="150" viewBox="0 0 760 150" role="img" aria-label="Your rocket with your crew flying as wingmen behind it">
              <path d="M120 120 C 260 110, 380 70, 500 60" stroke="#F3DFA8" strokeOpacity="0.35" strokeWidth="10" fill="none" />
              <g fill="#D7D9E4"><path d="M500 48 l40 12 l-40 12 z" /><rect x="470" y="52" width="30" height="16" rx="4" /></g>
              {[{ x: 420, y: 82, c: "#5FF0A0", tx: 320, ty: 88 }, { x: 400, y: 104, c: "#44D4E2", tx: 300, ty: 114 }, { x: 440, y: 30, c: "#F3DFA8", tx: 350, ty: 40 }].map((p, i) => (
                <g key={i}>
                  <g fill={p.c}><path d={`M${p.x} ${p.y} l22 7 l-22 7 z`} /><rect x={p.x - 16} y={p.y + 2} width="16" height="10" rx="3" /></g>
                  <text x={p.tx} y={p.ty} fill={p.c} fontFamily="var(--dsc-font-ui)" fontSize="12">{tag} {mates[i]?.name ?? "crewmate"}</text>
                </g>
              ))}
              <text x="548" y="64" fill="#FFF6DC" fontFamily="var(--dsc-font-ui)" fontSize="13">You</text>
            </svg>
          </div>
        </div>
        <aside className={s.side}>
          {pick && link && (
            <section className={`${s.card} ${s.flyCard}`}>
              <span className={`${s.eb} ${s.goldTxt}`}>Fly with me</span>
              <div className={s.cardH}>Invite a pilot to ${pick.ticker}</div>
              <p className={s.body}>{CREW_COPY.flyBody}</p>
              <div className={s.link}>{link.replace(/^https?:\/\//, "")}</div>
              <button type="button" className={s.gold} onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
            </section>
          )}
          {pick && (
            <section className={s.card}>
              <span className={s.eb}>What they see</span>
              <div className={s.seeH}>{(d.username ?? "A pilot").toUpperCase()} invited you to fly ${pick.ticker}</div>
              <div className={s.sub}>{pick.count + (pick.you ? 1 : 0)} {tag} pilots aboard · {where(pick)}</div>
              <div className={s.small}>{CREW_COPY.seeBody}</div>
              <Link href={`/coin/${pick.coin}`} className={s.ghost}>See the rocket</Link>
            </section>
          )}
          <section className={`${s.card} ${s.missionCard}`}>
            <span className={s.eb}>Crew mission · weekly</span>
            <div className={s.missionH}>{d.mission.target} crewmates aboard one rocket for an hour</div>
            <div className={s.bar}><div style={{ width: `${Math.round((d.mission.best / d.mission.target) * 100)}%` }} /></div>
            <div className={s.small}>{d.mission.done ? `Done · ${d.mission.xp} XP paid` : `${d.mission.best} of ${d.mission.target} · ${d.mission.xp} XP each`}</div>
          </section>
        </aside>
      </div>
    </div>
  );
}
