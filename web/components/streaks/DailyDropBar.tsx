"use client";
/**
 * Flight streak + daily drop in one row (retention loop, maker 2026-11-21 "do all 10", item 4). App home, signed in only.
 * The flame opens /streaks; the claim button takes today's drop (XP, or a crate on day 7) on the spot.
 */
import Link from "next/link";
import { useState } from "react";
import { claimDailyDrop, useStreaks } from "@/lib/streaksClient";
import { playSfx } from "@/lib/game/sfx";
import { haptic } from "@/lib/game/haptics";
import Icon from "@/components/icons/Icon";
import s from "./dailyDrop.module.css";

export const Flame = ({ lit, size = 20 }: { lit: boolean; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={lit ? s.lit : s.unlit}>
    <path d="M12 2.5c.6 3.2 4.75 5.4 4.75 10.1A4.75 4.75 0 0 1 12 17.35a4.75 4.75 0 0 1-4.75-4.75c0-2 1-3.4 2.1-4.6.3 1.5 1 2.3 1.9 2.6C11 8.6 11 5.4 12 2.5z" fill="currentColor" />
    <path d="M12 21.5a6.5 6.5 0 0 1-6.5-6.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity=".5" />
  </svg>
);

export default function DailyDropBar({ wallet }: { wallet: string | null }) {
  const { data } = useStreaks(wallet);
  const [busy, setBusy] = useState(false);
  const [got, setGot] = useState<string | null>(null);
  if (!wallet || !data) return null;
  const f = data.flight, d = data.drop;
  const claim = async () => {
    if (busy) return;
    setBusy(true); haptic("tap", true);
    const r = await claimDailyDrop(wallet);
    setBusy(false);
    if (!r.ok) { setGot(r.reason); return; }
    haptic("celebrate"); playSfx("mission_done", { gapMs: 1000 });
    setGot(r.crate ? "Crate added" : `+${r.xp} XP`);
    setTimeout(() => setGot(null), 2600);
  };
  return (
    <div className={s.bar} data-testid="daily-drop-bar">
      <Link href="/streaks" className={s.streak} data-testid="flight-streak">
        <Flame lit={f.todayOk} />
        <b>{f.current}</b>
        <span>{f.current === 1 ? "day" : "days"}</span>
      </Link>
      {got ? <span className={s.got} role="status">{got}</span>
        : d.claimed ? <Link href={d.crate ? "/market#crates" : "/streaks"} className={s.claimed} data-testid="drop-claimed"><Icon name="check" size={16} />Day {d.day}</Link>
        : <button type="button" className={s.claim} onClick={claim} disabled={busy} data-testid="drop-claim"><Icon name="gift" size={18} />{d.crate ? "Claim crate" : `Claim +${d.xp} XP`}</button>}
    </div>
  );
}
