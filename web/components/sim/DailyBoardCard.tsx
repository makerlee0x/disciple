"use client";
/**
 * Today's Daily mission board in the Top pilots design (components/leaderboard, app/refresh-r2.css tp-*): your rank and $ PnL
 * pinned on top, then medal ranks, faces and $ PnL (maker 2026-11-18: "the leaderboard needs to be the new leaderboard design").
 * Used by the Daily mission hub, the pre-launch and the result screen.
 */
import { useEffect, useState } from "react";
import { lightOf } from "@/components/home/rocketBits";
import { fmtDailyPnl } from "@/lib/sim/daily";
import { withBase } from "@/lib/base-path";
import { lastPill } from "@/lib/walletState";
import { hasSavedSession } from "@/lib/aa/sessionState";

export type DailyBoardRow = { runId: string; name: string; pnl: number; pfp?: string };

function Rank({ n }: { n: number }) {
  return n <= 3 ? <span className={`tp-rm m${n}`} aria-label={`#${n}`}>{n}</span> : <span className="tp-rk">{n}</span>;
}
/** pilot face: their picture, else their initial on their light colour (as the Top pilots board) */
function Face({ id, name, pfp, big }: { id: string; name: string; pfp?: string | null; big?: boolean }) {
  return <span className={`tp-av ${big ? "md" : "sm"}`} style={{ background: lightOf(id) }} aria-hidden>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {pfp ? <img className="pfp-img" src={withBase(pfp)} alt="" loading="lazy" decoding="async" /> : (name.replace(/^@/, "")[0] ?? "?").toUpperCase()}</span>;
}
/** the signed-in pilot's own picture and name from the top bar's saved pill: a run that isn't saved to the board yet has no
 *  owner on the server, so the pinned "Your rank" face drew a "Y" for You (maker 2026-11-18: "my pfp is blank") */
function useOwnFace(): { pfp: string | null; name: string | null } {
  const [f, setF] = useState<{ pfp: string | null; name: string | null }>({ pfp: null, name: null });
  useEffect(() => { try { if (!hasSavedSession()) return; const p = lastPill(); if (p) setF({ pfp: typeof p.img === "string" && p.img ? p.img : null, name: p.name || null }); } catch { /* no storage */ } }, []);
  return f;
}

export default function DailyBoardCard({ rows, count, me, meId, max = 10, testId }: {
  /** the board's rows, best $ PnL first (null while loading) */
  rows: DailyBoardRow[] | null; count: number;
  /** your place and $ PnL today, pinned on top */
  me?: { rank: number; pnl: number; name?: string; pfp?: string } | null;
  /** your run id: that row is highlighted and reads You */
  meId?: string | null; max?: number; testId?: string;
}) {
  const own = useOwnFace();
  const mineRow = meId ? rows?.find((r) => r.runId === meId) : undefined;
  const myPfp = me?.pfp || mineRow?.pfp || own.pfp, myName = me?.name || mineRow?.name || own.name || "You";
  return (
    <section className="tp-card tp-traders dbc" aria-label="Today's board" data-testid={testId}>
      <style>{`
        .dbc { display: flex; flex-direction: column; overflow: hidden; }
        .dbc-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; padding: 18px 22px 10px; }
        .dbc-head b { font: 800 20px/1 var(--dsc-font-game); letter-spacing: 1px; color: #F3DFA8; }
        .dbc-head span { font-size: 13px; color: #9095A0; }
        .dbc .tp-mine { padding-top: 4px; }
        .dbc .tp-trow { cursor: default; }
        .dbc .tp-trow:hover { background: transparent; }
        .dbc .tp-trow.self, .dbc .tp-trow.self:hover { background: rgba(242,193,78,.07); }
        .dbc .r2-g.up { color: #5FF0A0; } .dbc .r2-g.down { color: #FF7FB2; }
        .dbc-empty { padding: 6px 22px 22px; font-size: 14px; color: #D7D9E4; }
        .dbc-skel { display: block; margin: 6px 22px 22px; height: 14px; width: 55%; border-radius: 7px; background: rgba(215,217,228,.12); animation: dbcSkel 1.2s ease-in-out infinite alternate; }
        @keyframes dbcSkel { from { opacity: .45; } to { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .dbc-skel { animation: none; } }
      `}</style>
      <div className="dbc-head"><b>TODAY&apos;S BOARD</b><span>{count > 0 ? `${count.toLocaleString("en-US")} pilot${count === 1 ? "" : "s"}` : ""}</span></div>
      {me && (
        <div className="tp-mine" data-testid="daily-board-mine">
          <Face id={meId ?? "you"} name={myName} pfp={myPfp} big />
          <div className="tp-minerk"><span>Your rank</span><b className="r2-g"><i>#</i> {me.rank.toLocaleString("en-US")}</b></div>
          <div className="tp-minepnl"><span>PnL</span><b className={`r2-g ${me.pnl < 0 ? "down" : "up"}`}>{fmtDailyPnl(me.pnl)}</b></div>
        </div>
      )}
      {rows == null ? <span className="dbc-skel" role="status" aria-label="Loading the board" />
        : rows.length === 0 ? <div className="dbc-empty">No runs yet</div>
        : <div className="tp-trows">{rows.slice(0, max).map((r, i) => { const self = !!meId && r.runId === meId;
          return <div key={r.runId} className={`tp-trow${self ? " self" : ""}`} data-testid={self ? "daily-board-me" : "daily-board-row"}>
            <Rank n={i + 1} /><Face id={r.runId} name={r.name} pfp={r.pfp || (self ? myPfp : null)} big />
            <div className="tp-tname"><b>{self ? "You" : r.name}</b></div>
            <div className="tp-tpnl"><b className={`r2-g ${r.pnl < 0 ? "down" : "up"}`}>{fmtDailyPnl(r.pnl)}</b></div>
          </div>; })}</div>}
    </section>
  );
}
