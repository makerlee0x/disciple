"use client";
/**
 * "Pick a mode" (lobby canvas board "Game modes", option A, maker picked 2026-11-14): the Fortnite-style row at the top of
 * the lobby. Tall poster cards with our art plates: Host a launch, Live flights, Trading duel (only while the Turbo
 * flag is on, see lib/turbo/flag.ts) and Free play. The card in focus is bigger with Play; the others tilt away. Desktop: click a card to focus
 * it, click it again (or Play) to go; ←/→ move focus and Enter plays while the row has focus. Phones (≤760px): a swipe
 * carousel that snaps to the middle, with dots; tapping a card goes. Signed in it opens on the last mode played (this
 * browser), else Live flights; signed out it opens on Free play.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { withBase } from "@/lib/base-path";
import { ROCKET_SRC } from "@/lib/home/trending";
import { DUEL_HREF } from "@/lib/features";
import { isTurboEnabled } from "@/lib/turbo/flag";
import s from "./modeSelect.module.css";

type ModeId = "launch" | "live" | "duel" | "free";
type Mode = { id: ModeId; title: [string, string]; sub: string; tag: string; tone: string; href: string; art: string; pos: string; rockets: { c: string; x: number; y: number; h: number; r: number }[] };

export const MODE_COPY = {
  title: "Pick a mode",
  hint: "← → or click a card · Enter to play",
  play: "Play",
} as const;

const LAST = "disciple.lobby.mode";

function modes(flying: number, duel: boolean): Mode[] {
  const all: Mode[] = [
    { id: "launch", title: ["Host a", "launch"], sub: "Build a rocket. The crew flies it up.", tag: "Real coins", tone: "#F3DFA8", href: "/create", art: "/home/modes/launch.webp", pos: "50% 60%", rockets: [] },
    { id: "live", title: ["Live", "flights"], sub: "Jump on a rocket that's already climbing.", tag: flying > 0 ? `${flying} flying` : "Live", tone: "#5FF0A0", href: "/play", art: "/home/modes/live.webp", pos: "50% 40%",
      rockets: [{ c: "#F2C14E", x: 52, y: 12, h: 36, r: 8 }] },
    { id: "duel", title: ["Trading", "duel"], sub: "1v1. Three minutes. Most profit wins.", tag: "Ranked", tone: "#FF9CC4", href: DUEL_HREF, art: "/home/modes/duel.webp", pos: "50% 30%",
      rockets: [{ c: "#F2C14E", x: 30, y: 16, h: 32, r: -4 }, { c: "#F0307F", x: 58, y: 24, h: 26, r: 8 }] },
    { id: "free", title: ["Free", "play"], sub: "No cash. Today's daily flight.", tag: "Free", tone: "#8FE3FF", href: "/flight/sim", art: "/home/modes/free.webp", pos: "50% 50%",
      rockets: [{ c: "#8FE3FF", x: 52, y: 12, h: 36, r: 8 }] },
  ];
  return all.filter((m) => m.id !== "duel" || duel);
}

export default function ModeSelect({ signedIn, flying }: { signedIn: boolean; flying: number }) {
  // Turbo flag reads localStorage, so check it after mount to keep server and first paint the same
  const [duel, setDuel] = useState(false);
  useEffect(() => { setDuel(isTurboEnabled()); }, []);
  const list = useMemo(() => modes(flying, duel), [flying, duel]);
  const [focus, setFocus] = useState<ModeId>(signedIn ? "live" : "free");
  const track = useRef<HTMLDivElement>(null);

  // signed in: reopen on the last mode played on this browser
  useEffect(() => {
    if (!signedIn) return;
    try { const v = localStorage.getItem(LAST) as ModeId | null; if (v && list.some((m) => m.id === v)) setFocus(v); } catch { /* storage blocked */ }
  }, [signedIn, list]);

  // phones: bring the focused card to the middle of the carousel on first paint
  useEffect(() => {
    const el = track.current?.querySelector<HTMLElement>(`[data-mode="${focus}"]`);
    const t = track.current;
    if (el && t && t.scrollWidth > t.clientWidth) t.scrollLeft = el.offsetLeft - (t.clientWidth - el.clientWidth) / 2;
    // on mount, and again once the duel card appears (it shifts the cards)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duel]);

  const go = (m: Mode) => { try { localStorage.setItem(LAST, m.id); } catch { /* */ } };
  const idx = Math.max(0, list.findIndex((m) => m.id === focus));
  const phone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const n = list[(idx + (e.key === "ArrowRight" ? 1 : list.length - 1)) % list.length];
      setFocus(n.id);
      track.current?.querySelector<HTMLElement>(`[data-mode="${n.id}"]`)?.focus();
    }
    // Enter on a focused card follows its link (native)
  };
  // phones: the card nearest the middle is the focused one (dots follow the swipe)
  const onScroll = () => {
    const t = track.current; if (!t || !phone()) return;
    const mid = t.scrollLeft + t.clientWidth / 2;
    let best = list[0].id, d = Infinity;
    t.querySelectorAll<HTMLElement>("[data-mode]").forEach((el) => {
      const dd = Math.abs(el.offsetLeft + el.clientWidth / 2 - mid);
      if (dd < d) { d = dd; best = el.dataset.mode as ModeId; }
    });
    if (best !== focus) setFocus(best);
  };

  return (
    <section className={s.wrap} aria-labelledby="modes-title" data-testid="mode-select">
      <header className={s.head}>
        <h2 id="modes-title" className={s.title}>{MODE_COPY.title}</h2>
        <span className={s.hint}>{MODE_COPY.hint}</span>
      </header>
      <div className={s.row} ref={track} onKeyDown={onKey} onScroll={onScroll}>
        {list.map((m, i) => {
          const on = m.id === focus;
          const side = i < idx ? s.left : i > idx ? s.right : "";
          return (
            <Link
              key={m.id}
              href={m.href}
              prefetch={false}
              data-mode={m.id}
              className={`${s.card}${on ? ` ${s.on}` : ` ${side}`}`}
              aria-label={`${m.title.join(" ")}. ${m.sub}`}
              aria-current={on ? "true" : undefined}
              data-testid={`mode-${m.id}`}
              onClick={(e) => {
                // desktop: the first click on a card brings it into focus; the next one plays
                if (!on && !phone()) { e.preventDefault(); setFocus(m.id); return; }
                go(m);
              }}
              onFocus={() => { if (!phone()) setFocus(m.id); }}
            >
              {/* speed pass (2026-11-14): every card is on the first screen (the phone carousel opens on the focused one, often Free play,
                  the 4th), so none is lazy, and the focused card's art is the page's largest paint: fetch it first */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={s.art} src={withBase(m.art)} alt="" style={{ objectPosition: m.pos }} loading="eager" fetchPriority={on ? "high" : "auto"} decoding={on ? "sync" : "async"} />
              {m.rockets.map((r, k) => (
                <span key={k} className={s.rk} style={{ left: `${r.x}%`, top: `${r.y}%`, height: `${r.h}%`, transform: `rotate(${r.r}deg)`, ["--c" as string]: r.c }} aria-hidden>
                  <i className={s.plume} />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={withBase(ROCKET_SRC)} alt="" />
                </span>
              ))}
              <span className={s.scrim} aria-hidden />
              <span className={s.tag} style={{ color: m.tone }}>{m.tag}</span>
              <span className={s.body}>
                <b className={s.name}>{m.title[0]}<br />{m.title[1]}</b>
                <span className={s.sub}>{m.sub}</span>
                <span className={s.play} aria-hidden>{MODE_COPY.play}</span>
              </span>
            </Link>
          );
        })}
      </div>
      <div className={s.dots} aria-hidden>{list.map((m) => <i key={m.id} className={m.id === focus ? s.dotOn : undefined} />)}</div>
    </section>
  );
}
