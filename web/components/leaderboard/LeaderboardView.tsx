"use client";
/**
 * /leaderboard: Top pilots (round 2 "Leaderboard" board, maker 2026-11-13). The lobby shelf's board all the way down:
 * time window (Today / Week / Month / All time), rank by (Cashed out / Best % gain / Most boosted / Longest aboard),
 * a podium for the top three, the table, Show 10 more, and your own rank pinned at the bottom (sticky above the tab
 * bar on phones). Opens on the shortest window that has anyone in it, like the lobby shelf. Real numbers only
 * (GET /api/leaderboard: the same indexed fills as the lobby); nobody yet ⇒ "The top spot is open".
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { withBase } from "@/lib/base-path";
import { onWallet } from "@/lib/wallet";
import { displayName } from "@/lib/defaultUsername";
import { profileUrl } from "@/lib/profile";
import { ROCKET_SRC } from "@/lib/home/trending";
import { lightOf } from "@/components/home/rocketBits";
import { BOARD_WINDOWS, type BoardPilot, type BoardSort, type BoardWindow } from "@/lib/home/topPilots";
import type { BoardResponse } from "@/lib/server/leaderboard";

const SORTS: { k: BoardSort; label: string; col: string }[] = [
  { k: "pnl", label: "Cashed out", col: "Cashed out" },
  { k: "pctGain", label: "Best % gain", col: "Best gain" },
  { k: "volume", label: "Most boosted", col: "Boosted" },
  { k: "holdTime", label: "Longest aboard", col: "Aboard" },
];
const WIN_SHORT: Record<BoardWindow, string> = { day: "Today", week: "Week", month: "Month", all: "All" };
const TOP_EYEBROW: Record<BoardWindow, string> = { day: "Today's top pilot", week: "This week's top pilot", month: "This month's top pilot", all: "Top pilot of all time" };
const EMPTY_WHEN: Record<BoardWindow, string> = { day: "yet today", week: "yet this week", month: "yet this month", all: "yet" };

export const LEADERBOARD_COPY = {
  title: "Top pilots",
  sub: "Biggest cash-outs, in real money. Same board as the lobby shelf, all the way down.",
  cols: { rank: "#", pilot: "Pilot", flights: "Flights" },
  more: "Show 10 more",
  you: "You",
  emptyTitle: "The top spot is open",
  emptyBody: (w: BoardWindow) => `Nobody has cashed out higher ${EMPTY_WHEN[w]}. Be the first and your name goes up here.`,
  play: "Play now",
} as const;

const money = (v: number) => (Math.abs(v) >= 10 ? `$${Math.round(Math.abs(v)).toLocaleString("en-US")}` : `$${Math.abs(v).toFixed(2)}`);
const signed = (v: number) => `${v < 0 ? "-" : "+"}${money(v)}`;
const pctTxt = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${Math.round(v).toLocaleString("en-US")}%`);
function holdTxt(ms: number) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
/** The number a row is ranked by, in its own unit. */
function metric(p: BoardPilot, s: BoardSort) {
  return s === "pnl" ? signed(p.pnlUsd) : s === "pctGain" ? pctTxt(p.bestPct) : s === "volume" ? money(p.boostedUsd) : holdTxt(p.aboardMs);
}
function gapTxt(gap: number, s: BoardSort) {
  return s === "pnl" || s === "volume" ? money(gap) : s === "pctGain" ? `${Math.max(1, Math.round(gap))}%` : holdTxt(gap);
}
const nameOf = (p: BoardPilot) => displayName(p.username, p.wallet);
const lvl = (p: BoardPilot, short = false) => (p.level ? `${short ? "Lvl" : "Level"} ${p.level}` : "");
const flightsTxt = (n: number) => `${n} ${n === 1 ? "flight" : "flights"}`;
const hrefOf = (p: BoardPilot) => (p.username ? profileUrl(p.username) : `/u/${p.wallet}`);

const POD = [
  { av: "radial-gradient(circle at 35% 30%, #FFE7A6, #C8902B)", medal: "#F2C14E", bloom: "#F2C14E" },
  { av: "radial-gradient(circle at 35% 30%, #E7ECF5, #8C96AA)", medal: "#D7DCE6", bloom: "#C9D3E6" },
  { av: "radial-gradient(circle at 35% 30%, #F2C3A0, #9A5A33)", medal: "#E3A47A", bloom: "#D58A55" },
];

function Podium({ rows, win, sort }: { rows: (BoardPilot & { rank: number })[]; win: BoardWindow; sort: BoardSort }) {
  const order = [rows[1], rows[0], rows[2]];
  return (
    <div className="tp-podium" data-testid="lb-podium">
      {order.map((p, i) => {
        if (!p) return <div key={`e${i}`} className="tp-pod empty" aria-hidden />;
        const k = p.rank - 1, first = p.rank === 1;
        const sub = [lvl(p), p.prestige ? `Prestige ${p.prestige}` : "", flightsTxt(p.flights)].filter(Boolean).join(" · ");
        return (
          <Link key={p.wallet} href={hrefOf(p)} className={`tp-pod r${p.rank}`} aria-label={`#${p.rank} ${nameOf(p)}`}>
            <span className="tp-bloom" style={{ background: POD[k].bloom }} aria-hidden />
            {first && <span className="r2-eb tp-topeb">{TOP_EYEBROW[win]}</span>}
            <span className="tp-av" style={{ background: POD[k].av }} aria-hidden>
              {(nameOf(p)[0] ?? "?").toUpperCase()}
              <span className="tp-medal" style={{ background: POD[k].medal }}>{p.rank}</span>
            </span>
            <b className="r2-g tp-podname">{nameOf(p)}</b>
            <span className="tp-podsub">{sub}</span>
            <span className="r2-g tp-podval">{metric(p, sort)}</span>
          </Link>
        );
      })}
    </div>
  );
}

function Row({ p, sort, self }: { p: BoardPilot & { rank: number }; sort: BoardSort; self?: boolean }) {
  const router = useRouter();
  const go = () => router.push(hrefOf(p));
  const name = nameOf(p);
  const third = sort === "pctGain" ? signed(p.pnlUsd) : pctTxt(p.bestPct);
  return (
    <div className={`tp-row${self ? " tp-me" : ""}`} role="link" tabIndex={0} onClick={go} onKeyDown={(e) => { if (e.key === "Enter") go(); }} aria-label={`#${p.rank} ${name}`}>
      <span className="tp-rk">{p.rank}</span>
      <div className="tp-who">
        <span className="tp-av sm" style={{ background: lightOf(p.wallet) }} aria-hidden>{(name[0] ?? "?").toUpperCase()}</span>
        <div><b>{self ? `${LEADERBOARD_COPY.you} · ${name}` : name}</b><span className="tp-d">{lvl(p)}</span><span className="tp-p">{[lvl(p, true), flightsTxt(p.flights)].filter(Boolean).join(" · ")}</span></div>
      </div>
      <span className="tp-num tp-d">{p.flights}</span>
      <span className="tp-num tp-d">{third}</span>
      <span className="tp-num up">{metric(p, sort)}</span>
    </div>
  );
}

export default function LeaderboardView() {
  const [win, setWin] = useState<BoardWindow>("day");
  const [sort, setSort] = useState<BoardSort>("pnl");
  const [me, setMe] = useState<string | null>(null);
  const [data, setData] = useState<BoardResponse | null>(null);
  const [shown, setShown] = useState(10);
  const picked = useRef(false);
  useEffect(() => onWallet((a) => setMe(a ?? null)), []);

  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ window: win, sort });
    if (me) q.set("me", me);
    fetch(withBase(`/api/leaderboard?${q}`)).then((r) => (r.ok ? r.json() : null)).then((d: BoardResponse | null) => {
      if (!alive || !d) return;
      // open on the shortest window that has anyone in it (once), like the lobby shelf
      if (!picked.current) {
        picked.current = true;
        const first = BOARD_WINDOWS.find((w) => d.counts[w.k] > 0)?.k;
        if (first && first !== win && d.counts[win] === 0) { setWin(first); return; }
      }
      setData(d);
    }).catch(() => { if (alive) setData({ window: win, sort, rows: [], counts: { day: 0, week: 0, month: 0, all: 0 }, me: null }); });
    return () => { alive = false; };
  }, [win, sort, me]);
  useEffect(() => { setShown(10); }, [win, sort]);

  const rows = data?.rows ?? [];
  const rest = useMemo(() => rows.slice(3, shown), [rows, shown]);
  const mine = data?.me ?? null;
  const meLc = me?.toLowerCase();
  const pinned = mine && mine.rank > Math.min(shown, rows.length) ? mine : null;
  const meNote = mine ? [lvl(mine), mine.rank > 1 && mine.gap > 0 ? `${gapTxt(mine.gap, sort)} to pass #${mine.rank - 1}` : ""].filter(Boolean).join(" · ") : "";
  const col = SORTS.find((s) => s.k === sort)!.col;
  const third = sort === "pctGain" ? "Cashed out" : "Best gain";

  return (
    <div className="tp-page" data-testid="leaderboard">
      <div className="tp-head">
        <div>
          <h1 className="r2-g">{LEADERBOARD_COPY.title}</h1>
          <p>{LEADERBOARD_COPY.sub}</p>
        </div>
        <div className="tp-seg" role="tablist" aria-label="Time window">
          {BOARD_WINDOWS.map((w) => (
            <button key={w.k} type="button" role="tab" aria-selected={win === w.k} className={win === w.k ? "on" : ""} onClick={() => { picked.current = true; setWin(w.k); }}>
              <span className="tp-d">{w.label}</span><span className="tp-p">{WIN_SHORT[w.k]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="tp-sorts" role="tablist" aria-label="Rank by">
        {SORTS.map((s) => (
          <button key={s.k} type="button" role="tab" aria-selected={sort === s.k} className={sort === s.k ? "on" : ""} onClick={() => setSort(s.k)}>{s.label}</button>
        ))}
      </div>

      {!data ? (
        <div className="tp-loading" aria-busy="true" />
      ) : rows.length === 0 ? (
        <section className="tp-card tp-empty" data-testid="lb-empty">
          <div className="tp-emptybloom" aria-hidden />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={withBase(ROCKET_SRC)} alt="" aria-hidden />
          <span className="r2-eb">{BOARD_WINDOWS.find((w) => w.k === win)!.label}</span>
          <b className="r2-g">{LEADERBOARD_COPY.emptyTitle}</b>
          <span className="tp-emptybody">{LEADERBOARD_COPY.emptyBody(win)}</span>
          <Link href="/play" prefetch={false} className="r2-gold tp-play">{LEADERBOARD_COPY.play}</Link>
        </section>
      ) : (
        <>
          <Podium rows={rows} win={win} sort={sort} />
          {(rest.length > 0 || pinned) && (
            <section className="tp-card tp-table" aria-label="Rankings">
              <div className="tp-th tp-d" aria-hidden><span>{LEADERBOARD_COPY.cols.rank}</span><span>{LEADERBOARD_COPY.cols.pilot}</span><span>{LEADERBOARD_COPY.cols.flights}</span><span>{third}</span><span>{col}</span></div>
              <div className="tp-rows">
                {rest.map((p) => <Row key={p.wallet} p={p} sort={sort} self={p.wallet === meLc} />)}
              </div>
              {rows.length > shown && (
                <div className="tp-more"><button type="button" className="r2-btn tp-morebtn" onClick={() => setShown((n) => n + 10)}>{LEADERBOARD_COPY.more}</button></div>
              )}
              {pinned && (
                <div className="tp-row tp-me" aria-label="Your rank" data-testid="lb-me">
                  <span className="tp-rk">{pinned.rank}</span>
                  <div className="tp-who">
                    <span className="tp-av sm ring tp-d" aria-hidden>{pinned.level ?? "·"}</span>
                    <div><b><span className="tp-d">{LEADERBOARD_COPY.you} · {nameOf(pinned)}</span><span className="tp-p">{LEADERBOARD_COPY.you}</span></b><span>{meNote}</span></div>
                  </div>
                  <span className="tp-num tp-d">{pinned.flights}</span>
                  <span className="tp-num tp-d">{sort === "pctGain" ? signed(pinned.pnlUsd) : pctTxt(pinned.bestPct)}</span>
                  <span className="tp-num up">{metric(pinned, sort)}</span>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
