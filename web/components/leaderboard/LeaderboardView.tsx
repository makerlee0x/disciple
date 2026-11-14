"use client";
/**
 * /leaderboard: Top pilots (round 2 "Leaderboard" board, maker 2026-11-13). The lobby shelf's board all the way down:
 * time window (Today / Week / Month / All time), rank by (Banked $ / Best % ($20+ in) / Orbits aboard / Crews), a podium
 * for the top three, the table with each pilot's record ("7 of 12 green"), the "What counts" rules, and beside it the
 * Best call card and You this week (main mode hook loop mockup, maker 2026-11-13). Board guardrails: lib/home/topPilots
 * BOARD_RULES. Opens on the shortest window that has anyone in it, like the lobby shelf. Real numbers only
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
import { tierAt } from "@/lib/flight/tiers";
import { BOARD_WINDOWS, type BestCall, type BoardPilot, type BoardSort, type BoardWindow } from "@/lib/home/topPilots";
import type { BoardResponse, CrewBoardResponse } from "@/lib/server/leaderboard";
import { CREW_ENABLED, LOGBOOK_ENABLED } from "@/lib/features";

type Sort = BoardSort | "crews";
const SORTS: { k: Sort; label: string; col: string }[] = [
  { k: "pnl", label: "Banked $", col: "Banked" },
  { k: "pctGain", label: "Best % ($20+ in)", col: "Best %" },
  { k: "orbits", label: "Orbits aboard", col: "Orbits" },
  ...(CREW_ENABLED ? [{ k: "crews" as Sort, label: "Crews", col: "Orbits" }] : []),
];
const WIN_SHORT: Record<BoardWindow, string> = { day: "Today", week: "Week", month: "Month", all: "All" };
const TOP_EYEBROW: Record<BoardWindow, string> = { day: "Today's top pilot", week: "This week's top pilot", month: "This month's top pilot", all: "Top pilot of all time" };
const EMPTY_WHEN: Record<BoardWindow, string> = { day: "yet today", week: "yet this week", month: "yet this month", all: "yet" };

export const LEADERBOARD_COPY = {
  title: "Top pilots",
  sub: "Banked profit in real money, losses included. Same board as the lobby shelf, all the way down.",
  cols: { rank: "#", pilot: "Pilot", flights: "Flights", record: "Record", banked: "Banked", crew: "Crew", green: "Green rockets", pilots: "Pilots" },
  rules: {
    title: "What counts",
    items: ["Banked profit only, after fees. Losses net out.", "Your own launches don't count.", "Cash-outs count after 2 minutes aboard.", "Best % needs $20 or more put in."],
    note: "Tap a pilot to open their logbook of closed flights. Open bags are never shown here.",
  },
  bestCall: { eyebrow: { day: "Best call today", week: "Best call of the week", month: "Best call of the month", all: "Best call of the month" } as Record<BoardWindow, string>, boarded: "Boarded", cashed: "Cashed out", put: (v: string) => `on ${v} put in`, aboard: "aboard", open: (n: string) => (LOGBOOK_ENABLED ? `See ${n}'s logbook` : `See ${n}'s profile`) },
  youWeek: { title: { day: "You today", week: "You this week", month: "You this month", all: "You, all time" } as Record<BoardWindow, string>, banked: "banked $", red: (n: number, v: string) => `${n} red ${n === 1 ? "flight" : "flights"}, -${v}`, none: "No cash-outs yet in this window." },
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
  return s === "pnl" ? signed(p.pnlUsd) : s === "pctGain" ? pctTxt(p.bestPct) : String(p.orbits);
}
function gapTxt(gap: number, s: BoardSort) {
  return s === "pnl" ? money(gap) : s === "pctGain" ? `${Math.max(1, Math.round(gap))}%` : `${gap} ${gap === 1 ? "orbit" : "orbits"}`;
}
const recordTxt = (p: BoardPilot) => `${p.green} of ${p.green + p.red} green`;
/** the right-most column next to the ranked number: Flights on Banked, Banked on the others */
const lastTxt = (p: BoardPilot, s: BoardSort) => (s === "pnl" ? String(p.flights) : signed(p.pnlUsd));
const nameOf = (p: BoardPilot) => displayName(p.username, p.wallet);
const lvl = (p: BoardPilot, short = false) => (p.level ? `${short ? "Lvl" : "Level"} ${p.level}` : "");
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
        const sub = [lvl(p), p.crew ? `[${p.crew}]` : "", recordTxt(p)].filter(Boolean).join(" · ");
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
  const tag = [lvl(p, true), p.crew ? `[${p.crew}]` : ""].filter(Boolean).join(" · ");
  return (
    <div className={`tp-row${self ? " tp-me" : ""}`} role="link" tabIndex={0} onClick={go} onKeyDown={(e) => { if (e.key === "Enter") go(); }} aria-label={`#${p.rank} ${name}`}>
      <span className="tp-rk">{p.rank}</span>
      <div className="tp-who">
        <span className="tp-av sm" style={{ background: lightOf(p.wallet) }} aria-hidden>{(name[0] ?? "?").toUpperCase()}</span>
        <div><b>{self ? `${LEADERBOARD_COPY.you} · ${name}` : name} <span className="tp-tag">{tag}</span></b><span className="tp-p">{recordTxt(p)}</span></div>
      </div>
      <span className="tp-num up">{metric(p, sort)}</span>
      <span className="tp-rec tp-d">{recordTxt(p)}</span>
      <span className="tp-num tp-d tp-dim">{lastTxt(p, sort)}</span>
    </div>
  );
}

function BestCallCard({ c, win }: { c: BestCall; win: BoardWindow }) {
  const name = displayName(c.username ?? null, c.wallet);
  const href = !LOGBOOK_ENABLED ? hrefOf({ wallet: c.wallet, username: c.username ?? null } as BoardPilot) : `/logbook?wallet=${c.wallet}${c.username ? `&name=${encodeURIComponent(c.username)}` : ""}`;
  const t = LEADERBOARD_COPY.bestCall;
  return (
    <section className="tp-call" aria-label={t.eyebrow[win]} data-testid="lb-bestcall">
      <div className="tp-callhd">
        <span className="tp-eb gold">{t.eyebrow[win]}</span>
        <b className="r2-g tp-callname">{name} on {c.coinName ? `$${c.coinName}` : "a rocket"}</b>
        <div className="tp-zones">
          <div><span>{t.boarded}</span><b className="r2-g">{tierAt(c.boardedMcap).name}</b></div>
          <svg width="28" height="16" viewBox="0 0 28 16" aria-hidden><path d="M2 8h22M18 2l6 6-6 6" stroke="#F3DFA8" strokeWidth="2" fill="none" /></svg>
          <div><span>{t.cashed}</span><b className="r2-g gold">{tierAt(c.cashedMcap).name}</b></div>
        </div>
        <div className="tp-callnums">
          <div><b className="r2-g up">{pctTxt(c.pct)}</b><span>{t.put(money(c.basisUsd))}</span></div>
          <div><b className="r2-g">{holdTxt(c.aboardMs)}</b><span>{t.aboard}</span></div>
        </div>
      </div>
      <div className="tp-callft"><Link href={href} prefetch={false} className="r2-btn tp-callbtn">{t.open(name)}</Link></div>
    </section>
  );
}

function YouCard({ me, win }: { me: (BoardPilot & { rank: number }) | null; win: BoardWindow }) {
  const t = LEADERBOARD_COPY.youWeek;
  return (
    <section className="tp-card tp-you" aria-label={t.title[win]} data-testid="lb-you">
      <span className="tp-eb">{t.title[win]}</span>
      {me ? (
        <div className="tp-youbody">
          <div><b className="r2-g">#{me.rank}</b><span>{t.banked}</span></div>
          <div className="r"><b className={`r2-g ${me.pnlUsd >= 0 ? "up" : "down"}`}>{signed(me.pnlUsd)}</b>{me.red > 0 && <span>{t.red(me.red, money(me.lostUsd))}</span>}</div>
        </div>
      ) : <p className="tp-younone">{t.none}</p>}
    </section>
  );
}

function CrewTable({ d }: { d: CrewBoardResponse }) {
  const c = LEADERBOARD_COPY.cols;
  return (
    <section className="tp-card tp-table" aria-label="Crew rankings" data-testid="lb-crews">
      <div className="tp-th tp-d" aria-hidden><span>{c.rank}</span><span>{c.crew}</span><span>Orbits</span><span>{c.green}</span><span>{c.pilots}</span></div>
      <div className="tp-rows">
        {d.crews.map((r) => (
          <div key={r.id} className={`tp-row${d.mine?.id === r.id ? " tp-me" : ""}`}>
            <span className="tp-rk">{r.rank}</span>
            <div className="tp-who"><span className="tp-av sm crew" aria-hidden>{r.mark || r.tag.slice(0, 2)}</span><div><b>[{r.tag}]</b><span className="tp-p">{r.green} green · {r.pilots} pilots</span></div></div>
            <span className="tp-num up">{r.orbits}</span>
            <span className="tp-rec tp-d">{r.green} of {r.flights}</span>
            <span className="tp-num tp-d tp-dim">{r.pilots}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Rules() {
  const r = LEADERBOARD_COPY.rules;
  return (
    <>
      <section className="tp-rules" aria-label={r.title}>
        <span className="tp-eb">{r.title}</span>
        <ul>{r.items.map((x) => <li key={x}>{x}</li>)}</ul>
      </section>
      <p className="tp-note">{r.note}</p>
    </>
  );
}

export default function LeaderboardView() {
  const [win, setWin] = useState<BoardWindow>("day");
  const [sort, setSort] = useState<Sort>("pnl");
  const [me, setMe] = useState<string | null>(null);
  const [data, setData] = useState<BoardResponse | null>(null);
  const [crews, setCrews] = useState<CrewBoardResponse | null>(null);
  const [mine, setMine] = useState<(BoardPilot & { rank: number }) | null>(null);
  const [shown, setShown] = useState(10);
  const picked = useRef(false);
  useEffect(() => onWallet((a) => setMe(a ?? null)), []);

  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ window: win, sort });
    if (me) q.set("me", me);
    fetch(withBase(`/api/leaderboard?${q}`)).then((r) => (r.ok ? r.json() : null)).then((d: BoardResponse | CrewBoardResponse | null) => {
      if (!alive || !d) return;
      if (d.sort === "crews") { setCrews(d); return; }
      // open on the shortest window that has anyone in it (once), like the lobby shelf
      if (!picked.current) {
        picked.current = true;
        const first = BOARD_WINDOWS.find((w) => d.counts[w.k] > 0)?.k;
        if (first && first !== win && d.counts[win] === 0) { setWin(first); return; }
      }
      setData(d);
      if (d.sort === "pnl") setMine(d.me);
    }).catch(() => { if (alive) setData({ window: win, sort: sort === "crews" ? "pnl" : sort, rows: [], counts: { day: 0, week: 0, month: 0, all: 0 }, me: null, bestCall: null }); });
    return () => { alive = false; };
  }, [win, sort, me]);
  // You this week always shows the Banked rank: fetch it once per window when another tab is open
  useEffect(() => {
    if (!me || sort === "pnl") return;
    let alive = true;
    fetch(withBase(`/api/leaderboard?${new URLSearchParams({ window: win, sort: "pnl", me })}`)).then((r) => (r.ok ? r.json() : null)).then((d: BoardResponse | null) => { if (alive && d) setMine(d.me); }).catch(() => {});
    return () => { alive = false; };
  }, [win, me, sort]);
  useEffect(() => { setShown(10); }, [win, sort]);

  const isCrews = sort === "crews";
  const ps: BoardSort = isCrews ? "pnl" : sort;
  const rows = data && data.sort === ps ? data.rows : [];
  const rest = useMemo(() => rows.slice(3, shown), [rows, shown]);
  const meRow = data?.me ?? null;
  const meLc = me?.toLowerCase();
  const pinned = meRow && meRow.rank > Math.min(shown, rows.length) ? meRow : null;
  const meNote = meRow ? [lvl(meRow), meRow.rank > 1 && meRow.gap > 0 ? `${gapTxt(meRow.gap, ps)} to pass #${meRow.rank - 1}` : ""].filter(Boolean).join(" · ") : "";
  const col = SORTS.find((s) => s.k === sort)!.col;
  const last = ps === "pnl" ? LEADERBOARD_COPY.cols.flights : LEADERBOARD_COPY.cols.banked;
  const call = (isCrews ? crews?.bestCall : data?.bestCall) ?? null;
  const loading = isCrews ? !crews || crews.window !== win : !data;

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

      <div className="tp-cols">
        <div className="tp-main">
          {loading ? (
            <div className="tp-loading" aria-busy="true" />
          ) : isCrews ? (
            crews && crews.crews.length ? <CrewTable d={crews} /> : (
              <section className="tp-card tp-empty" data-testid="lb-empty">
                <div className="tp-emptybloom" aria-hidden />
                <span className="r2-eb">{BOARD_WINDOWS.find((w) => w.k === win)!.label}</span>
                <b className="r2-g">No crews on the board yet</b>
                <span className="tp-emptybody">Join a crew and fly together. Crews rank by orbits aboard, then green rockets.</span>
                <Link href="/crew" prefetch={false} className="r2-gold tp-play">Find a crew</Link>
              </section>
            )
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
              <Podium rows={rows} win={win} sort={ps} />
              {(rest.length > 0 || pinned) && (
                <section className="tp-card tp-table" aria-label="Rankings">
                  <div className="tp-th tp-d" aria-hidden><span>{LEADERBOARD_COPY.cols.rank}</span><span>{LEADERBOARD_COPY.cols.pilot}</span><span>{col}</span><span>{LEADERBOARD_COPY.cols.record}</span><span>{last}</span></div>
                  <div className="tp-rows">
                    {rest.map((p) => <Row key={p.wallet} p={p} sort={ps} self={p.wallet === meLc} />)}
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
                      <span className="tp-num up">{metric(pinned, ps)}</span>
                      <span className="tp-rec tp-d">{recordTxt(pinned)}</span>
                      <span className="tp-num tp-d tp-dim">{lastTxt(pinned, ps)}</span>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
          <Rules />
        </div>
        <aside className="tp-side">
          {call && <BestCallCard c={call} win={win} />}
          {me && <YouCard me={mine} win={win} />}
        </aside>
      </div>
    </div>
  );
}
