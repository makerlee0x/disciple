"use client";
/**
 * /fly?u=&c= (main mode hook loop mockup board "Crew flights", What they see): the invite a "Fly with me" link opens.
 * The inviter, the rocket, how many of their crew are aboard, and a plain real-money line before See the rocket.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { difficultyOf } from "@/lib/difficulty";
import type { FlyView } from "@/lib/crew";
import { titleCase } from "@/components/logbook/LogbookView";
import s from "./crew.module.css";

export default function FlyLanding() {
  const [v, setV] = useState<FlyView | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(location.search), u = q.get("u") || "", c = q.get("c") || "";
    if (!u || !c) { setMissing(true); return; }
    fetch(`/api/fly?u=${encodeURIComponent(u)}&c=${encodeURIComponent(c)}`).then(async (r) => (r.ok ? setV((await r.json()) as FlyView) : setMissing(true))).catch(() => setMissing(true));
  }, []);
  if (missing) return <div className={s.land}><div className={s.card}><div className={s.landH}>Invite not found</div><p className={s.sub}>That link doesn&apos;t match a rocket any more.</p><Link href="/" className={s.ghost}>Go to the lobby</Link></div></div>;
  if (!v) return <div className={s.land}><div className={s.loading} aria-busy="true" /></div>;
  const facts = [v.crew && v.crew.aboard > 0 ? `${v.crew.aboard} [${v.crew.tag}] ${v.crew.aboard === 1 ? "pilot" : "pilots"} aboard` : null, v.graduated ? v.zone : titleCase(v.zone), difficultyOf(v.mode ?? null)?.label].filter(Boolean).join(" · ");
  return (
    <div className={s.land} data-testid="fly-landing">
      <section className={s.card}>
        <span className={`${s.eb} ${s.goldTxt}`}>Fly with me</span>
        <div className={s.landH}>{v.inviter} invited you to fly ${v.ticker}</div>
        <div className={s.sub}>{facts}</div>
        <div className={s.small}>Real coin, real money. Read <Link href="/docs" className={s.goldTxt}>how rockets work</Link> before you board.</div>
        <Link href={`/coin/${v.coin}`} className={s.gold}>See the rocket</Link>
      </section>
    </div>
  );
}
