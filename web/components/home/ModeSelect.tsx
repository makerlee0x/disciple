"use client";
/**
 * "Pick a mode" (lobby canvas board "Game modes", option A, maker picked 2026-11-14): the poster row at the top of the
 * lobby. Tall poster cards (Grok art plates, PR #380, web/public/art/modes; no sprite outside flight): Host a launch, Live
 * flights, Trading duel and Turbo royale (only while the Turbo flag is on, see lib/turbo/flag.ts) and Free play.
 * Carousel (maker 2026-11-15): one sideways-scrolling, snapping row on every screen size, and a click or tap anywhere on a
 * card opens that mode straight away (no focus step first). Desktop gets ‹ › buttons when the row overflows; phones get
 * dots. On phones the row opens centred on the last mode played (this browser), else Live flights signed in and Free play signed out.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { withBase } from "@/lib/base-path";
import { DUEL_HREF } from "@/lib/features";
import { isTurboEnabled } from "@/lib/turbo/flag";
import s from "./modeSelect.module.css";
import { playSfx } from "@/lib/game/sfx";

type ModeId = "launch" | "live" | "duel" | "royale" | "free";
type Mode = { id: ModeId; title: [string, string]; sub: string; tag: string; tone: string; href: string; art: string; pos: string };

export const MODE_COPY = {
  title: "Pick a mode",
  hint: "Scroll for more · click a card to play",
  play: "Play",
} as const;

const LAST = "disciple.lobby.mode";

function modes(flying: number, duel: boolean): Mode[] {
  const all: Mode[] = [
    { id: "launch", title: ["Host a", "launch"], sub: "Build a rocket. The crew flies it up.", tag: "Real coins", tone: "#F3DFA8", href: "/create", art: "/art/modes/launch.webp", pos: "50% 30%" },
    { id: "live", title: ["Live", "flights"], sub: "Jump on a rocket that's already climbing.", tag: flying > 0 ? `${flying} flying` : "Live", tone: "#5FF0A0", href: "/play", art: "/art/modes/live.webp", pos: "50% 30%" },
    { id: "duel", title: ["Trading", "duel"], sub: "1v1. Three minutes. Most profit wins.", tag: "Ranked", tone: "#FF9CC4", href: DUEL_HREF, art: "/art/modes/duel.webp", pos: "50% 30%" },
    { id: "royale", title: ["Turbo", "royale"], sub: "12 pilots. Loot leverage. Last one flying wins.", tag: "Practice", tone: "#F2C14E", href: "/turbo/royale", art: "/art/modes/last-pilot.webp", pos: "50% 30%" },
    { id: "free", title: ["Free", "play"], sub: "No cash. Today's daily flight.", tag: "Free", tone: "#8FE3FF", href: "/flight/sim", art: "/art/modes/free.webp", pos: "50% 30%" },
  ];
  return all.filter((m) => (m.id !== "duel" && m.id !== "royale") || duel);
}

export default function ModeSelect({ signedIn, flying }: { signedIn: boolean; flying: number }) {
  // Turbo flag reads localStorage, so check it after mount to keep server and first paint the same
  const [duel, setDuel] = useState(false);
  useEffect(() => { setDuel(isTurboEnabled()); }, []);
  const list = useMemo(() => modes(flying, duel), [flying, duel]);
  const [start, setStart] = useState<ModeId>(signedIn ? "live" : "free");
  const [seen, setSeen] = useState<ModeId>(start);
  // sounds: a whoosh each time a new card reaches the middle, a soft snap when the row settles (only after the player moves it)
  const moved = useRef(false), snapT = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { if (moved.current) playSfx("mode_swipe", { gapMs: 90 }); }, [seen]);
  const [edge, setEdge] = useState({ prev: false, next: false });
  const track = useRef<HTMLDivElement>(null);

  // signed in: start on the last mode played on this browser
  useEffect(() => {
    if (!signedIn) return;
    try { const v = localStorage.getItem(LAST) as ModeId | null; if (v && list.some((m) => m.id === v)) setStart(v); } catch { /* storage blocked */ }
  }, [signedIn, list]);

  // phones: centre the starting card; desktop reads left to right from Host a launch, with the next cards peeking.
  // Again once the duel card appears (it shifts the cards).
  useEffect(() => {
    const t = track.current; const el = t?.querySelector<HTMLElement>(`[data-mode="${start}"]`);
    const phone = window.matchMedia("(max-width: 760px)").matches;
    if (el && t && phone && t.scrollWidth > t.clientWidth + 1) t.scrollLeft = el.offsetLeft - (t.clientWidth - el.offsetWidth) / 2;
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duel, start]);

  // which arrows to show, and which card is nearest the middle (for the phone dots). Once per frame: cards never change size.
  const raf = useRef(0);
  const measure = () => {
    const t = track.current; if (!t) return;
    const max = t.scrollWidth - t.clientWidth;
    setEdge((e) => { const n = { prev: t.scrollLeft > 4, next: t.scrollLeft < max - 4 }; return n.prev === e.prev && n.next === e.next ? e : n; });
    const mid = t.scrollLeft + t.clientWidth / 2;
    let best: ModeId = list[0]?.id ?? "free", d = Infinity;
    t.querySelectorAll<HTMLElement>("[data-mode]").forEach((el) => {
      const dd = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid);
      if (dd < d) { d = dd; best = el.dataset.mode as ModeId; }
    });
    setSeen((f) => (f === best ? f : best));
  };
  const onScroll = () => {
    if (moved.current) { if (snapT.current) clearTimeout(snapT.current); snapT.current = setTimeout(() => playSfx("mode_snap"), 150); }
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => { raf.current = 0; measure(); });
  };
  useEffect(() => {
    window.addEventListener("resize", onScroll);
    return () => { window.removeEventListener("resize", onScroll); cancelAnimationFrame(raf.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ‹ › and ←/→: slide by one card
  const step = (dir: 1 | -1) => {
    const t = track.current; const el = t?.querySelector<HTMLElement>("[data-mode]");
    if (t && el) t.scrollBy({ left: dir * (el.offsetWidth + 18), behavior: "smooth" });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    moved.current = true;
    const cards = Array.from(track.current?.querySelectorAll<HTMLElement>("[data-mode]") ?? []);
    const i = cards.indexOf(document.activeElement as HTMLElement);
    const n = cards[(Math.max(0, i) + (e.key === "ArrowRight" ? 1 : cards.length - 1)) % cards.length];
    n?.focus(); n?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    // Enter on a focused card follows its link (native)
  };
  const go = (m: Mode) => { try { localStorage.setItem(LAST, m.id); } catch { /* */ } };

  return (
    <section className={s.wrap} aria-labelledby="modes-title" aria-roledescription="carousel" data-testid="mode-select">
      <header className={s.head}>
        <h2 id="modes-title" className={s.title}>{MODE_COPY.title}</h2>
        <span className={s.hint}>{MODE_COPY.hint}</span>
        <span className={s.arrows}>
          <button type="button" className={s.arrow} onClick={() => { moved.current = true; step(-1); }} disabled={!edge.prev} aria-label="Previous modes" data-testid="modes-prev">‹</button>
          <button type="button" className={s.arrow} onClick={() => { moved.current = true; step(1); }} disabled={!edge.next} aria-label="More modes" data-testid="modes-next">›</button>
        </span>
      </header>
      <div className={s.rail} data-prev={edge.prev ? "1" : undefined} data-next={edge.next ? "1" : undefined}>
        <div className={s.row} ref={track} onKeyDown={onKey} onScroll={onScroll} onPointerDown={() => { moved.current = true; }} onWheel={() => { moved.current = true; }}>
          {list.map((m) => (
            <Link
              key={m.id}
              href={m.href}
              prefetch={false}
              data-mode={m.id}
              className={s.card}
              aria-label={`${m.title.join(" ")}. ${m.sub}`}
              data-testid={`mode-${m.id}`}
              data-sfx="mode_select"
              onClick={() => go(m)}
            >
              {/* every card can be on the first screen, so none is lazy; the starting card's art is fetched first */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={s.art} src={withBase(m.art)} alt="" style={{ objectPosition: m.pos }} loading="eager" fetchPriority={m.id === start ? "high" : "auto"} decoding="async" />
              <span className={s.scrim} aria-hidden />
              <span className={s.tag} style={{ color: m.tone }}>{m.tag}</span>
              <span className={s.body}>
                <b className={s.name}>{m.title[0]}<br />{m.title[1]}</b>
                <span className={s.sub}>{m.sub}</span>
                <span className={s.play} aria-hidden>{MODE_COPY.play}</span>
              </span>
            </Link>
          ))}
        </div>
      </div>
      <div className={s.dots} aria-hidden>{list.map((m) => <i key={m.id} className={m.id === seen ? s.dotOn : undefined} />)}</div>
    </section>
  );
}
