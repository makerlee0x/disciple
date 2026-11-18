"use client";
/**
 * /leaderboard: Top pilots, ranked by cold hard cash (maker 2026-11-18). Two tabs:
 *  - Traders: realized $ PnL per pilot for the window (24H / 7D / 30D / ALL), your rank pinned on top, the rockets
 *    behind each pilot's PnL as a coin stack. Red pilots are ranked too, so everyone who cashed out has a rank.
 *  - Positions: the window's biggest single cash-outs (one trip aboard one rocket): size, entry → exit mcap, PnL, %,
 *    time aboard and when it closed.
 * Same indexed fills and guardrails as the lobby (lib/home/topPilots BOARD_RULES). No rules tooltip, no subtitles.
 * Duels / Crews tabs stay behind their flags.
 */
import { LEAGUES, leagueProgress } from "@/lib/duel/season";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/base-path";
import { onWallet } from "@/lib/walletState"; // = lib/wallet's, without viem
import { displayName } from "@/lib/defaultUsername";
import { profileUrl } from "@/lib/profile";
import { altShort, lightOf } from "@/components/home/rocketBits";
import { isStoreSrc } from "@/lib/coinImages";
import { BOARD_WINDOWS, type BoardPilot, type BoardWindow } from "@/lib/home/topPilots";
import type { BoardCoin, BoardResponse, CrewBoardResponse, Named, PositionsResponse } from "@/lib/server/leaderboard";
import { BOT_DUEL_HREF, CREW_ENABLED } from "@/lib/features";
import { DUEL_RANKED_LIVE } from "@/lib/duel/season";
import AnimClip from "@/components/ui/AnimClip";

type Tab = "traders" | "positions" | "crews" | "duel";
const TABS: { k: Tab; label: string }[] = [
  { k: "traders", label: "Traders" },
  { k: "positions", label: "Positions" },
  ...(CREW_ENABLED ? [{ k: "crews" as Tab, label: "Crews" }] : []),
];
const WIN_LABEL: Record<BoardWindow, string> = { day: "24H", week: "7D", month: "30D", all: "ALL" };

export const LEADERBOARD_COPY = {
  title: "Top pilots",
  yourRank: "Your rank",
  pnl: "PnL",
  cols: { rank: "#", pilot: "Pilot", rocket: "Rocket", size: "Size", entry: "Entry → exit", pnl: "PnL", pct: "%", held: "Held", closed: "Closed", crew: "Crew", green: "Green rockets", pilots: "Pilots" },
  more: "Show 10 more",
  you: "You",
  emptyTitle: "The top spot is open",
  play: "Play now",
  duel: "Play a duel",
} as const;

/** +$2,279,655.33 / -$846.33 */
const cash = (v: number) => `$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (v: number) => `${v < -0.004 ? "-" : "+"}${cash(v)}`;
/** $1.1M / $82,987 / $420.50 */
function size(v: number) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 1e5) return `$${(v / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return v >= 1000 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`;
}
const pctTxt = (v: number) => `${v >= 0 ? "+" : ""}${Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(1)}%`;
function dur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function ago(ts: number) {
  const m = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
const nameOf = (p: { username?: string | null; wallet: string }) => displayName(p.username ?? null, p.wallet);
const hrefOf = (p: { username?: string | null; wallet: string }) => (p.username ? profileUrl(p.username) : `/u/${p.wallet}`);

/** Pilot face: their profile picture, else their initial on their light colour. */
function Face({ p, big }: { p: { username?: string | null; wallet: string } & Named; big?: boolean }) {
  return (
    <span className={`tp-av ${big ? "md" : "sm"}`} style={{ background: lightOf(p.wallet) }} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {p.pfp ? <img src={withBase(p.pfp)} alt="" loading="lazy" decoding="async" /> : (nameOf(p).replace(/^@/, "")[0] ?? "?").toUpperCase()}
    </span>
  );
}
/** Rocket mark: its moderated image, else its ticker's first letter. */
function CoinMark({ token, c }: { token: string; c?: BoardCoin }) {
  return (
    <span className="tp-coin" style={{ background: lightOf(token) }} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {c && isStoreSrc(c.icon) ? <img src={c.icon} alt="" loading="lazy" decoding="async" /> : (c?.ticker[0] ?? "?").toUpperCase()}
    </span>
  );
}
function Rank({ n }: { n: number }) {
  return n <= 3 ? <span className={`tp-rm m${n}`} aria-label={`#${n}`}>{n}</span> : <span className="tp-rk">{n}</span>;
}

function TraderRow({ p, coins, self }: { p: BoardPilot & Named & { rank: number }; coins: Record<string, BoardCoin>; self?: boolean }) {
  const router = useRouter();
  const go = () => router.push(hrefOf(p));
  const more = p.flights - p.coins.length;
  return (
    <div className={`tp-trow${self ? " self" : ""}`} role="link" tabIndex={0} onClick={go} onKeyDown={(e) => { if (e.key === "Enter") go(); }} aria-label={`#${p.rank} ${nameOf(p)}`}>
      <Rank n={p.rank} />
      <Face p={p} big />
      <div className="tp-tname"><b>{nameOf(p)}</b>{p.level ? <span>Lvl {p.level}</span> : null}</div>
      <div className="tp-tpnl">
        <b className={`r2-g ${p.pnlUsd < 0 ? "down" : "up"}`}>{signed(p.pnlUsd)}</b>
        {p.coins.length > 0 && (
          <span className="tp-stack">
            {p.coins.map((t) => <CoinMark key={t} token={t} c={coins[t]} />)}
            {more > 0 && <span className="tp-coin n">{more}+</span>}
          </span>
        )}
      </div>
    </div>
  );
}

function YourRank({ me, face }: { me: (BoardPilot & Named & { rank: number }) | null; face: { wallet: string } }) {
  const t = LEADERBOARD_COPY;
  return (
    <div className="tp-mine" data-testid="lb-me">
      <Face p={me ?? face} big />
      <div className="tp-minerk"><span>{t.yourRank}</span><b className="r2-g"><i>#</i> {me ? me.rank.toLocaleString("en-US") : "—"}</b></div>
      <div className="tp-minepnl"><span>{t.pnl}</span><b className={`r2-g ${me && me.pnlUsd < 0 ? "down" : "up"}`}>{signed(me?.pnlUsd ?? 0)}</b></div>
    </div>
  );
}

function Traders({ d, me }: { d: BoardResponse; me: string | null }) {
  const [shown, setShown] = useState(10);
  useEffect(() => { setShown(10); }, [d.window]);
  const meLc = me?.toLowerCase();
  return (
    <section className="tp-card tp-traders" aria-label="Traders" data-testid="lb-traders">
      {me && <YourRank me={d.me} face={{ wallet: me.toLowerCase() }} />}
      <div className="tp-trows">
        {d.rows.slice(0, shown).map((p) => <TraderRow key={p.wallet} p={p} coins={d.coins} self={p.wallet === meLc} />)}
      </div>
      {d.rows.length > shown && <div className="tp-more"><button type="button" className="r2-btn tp-morebtn" onClick={() => setShown((n) => n + 10)}>{LEADERBOARD_COPY.more}</button></div>}
    </section>
  );
}

function PositionRow({ p, c, self }: { p: PositionsResponse["rows"][number]; c?: BoardCoin; self?: boolean }) {
  const router = useRouter();
  const go = () => router.push(hrefOf(p));
  const tick = c ? `$${c.ticker}` : "—";
  return (
    <div className={`tp-prow${p.rank <= 3 ? ` m${p.rank}` : ""}${self ? " self" : ""}`} role="link" tabIndex={0} onClick={go} onKeyDown={(e) => { if (e.key === "Enter") go(); }} aria-label={`#${p.rank} ${nameOf(p)} ${tick}`}>
      <Rank n={p.rank} />
      <div className="tp-pwho"><Face p={p} /><b>{nameOf(p)}</b></div>
      <div className="tp-pcoin"><CoinMark token={p.coin} c={c} /><b>{tick}</b><span className="tp-p">{nameOf(p)}</span></div>
      <span className="tp-pc tp-d">{size(p.sizeUsd)}</span>
      <span className="tp-pc tp-d tp-pmc">{altShort(p.entryMcap)}<i>→</i>{altShort(p.exitMcap)}</span>
      <div className="tp-ppnl"><b className="r2-g up">{signed(p.pnlUsd)}</b><span className="tp-p">{pctTxt(p.pct)} · {dur(p.closedAt - p.openedAt)}</span></div>
      <span className="tp-pc tp-d up">{pctTxt(p.pct)}</span>
      <span className="tp-pc tp-d tp-dim">{dur(p.closedAt - p.openedAt)}</span>
      <span className="tp-pc tp-d tp-dim">{ago(p.closedAt)}</span>
    </div>
  );
}

function Positions({ d, me }: { d: PositionsResponse; me: string | null }) {
  const [shown, setShown] = useState(10);
  useEffect(() => { setShown(10); }, [d.window]);
  const c = LEADERBOARD_COPY.cols, meLc = me?.toLowerCase();
  return (
    <section className="tp-card tp-positions" aria-label="Positions" data-testid="lb-positions">
      <div className="tp-pth tp-d" aria-hidden>
        <span>{c.rank}</span><span>{c.pilot}</span><span>{c.rocket}</span><span>{c.size}</span><span>{c.entry}</span><span>{c.pnl}</span><span>{c.pct}</span><span>{c.held}</span><span>{c.closed}</span>
      </div>
      <div className="tp-prows">
        {d.rows.slice(0, shown).map((p) => <PositionRow key={`${p.wallet}${p.coin}${p.openedAt}`} p={p} c={d.coins[p.coin]} self={p.wallet === meLc} />)}
      </div>
      {d.rows.length > shown && <div className="tp-more"><button type="button" className="r2-btn tp-morebtn" onClick={() => setShown((n) => n + 10)}>{LEADERBOARD_COPY.more}</button></div>}
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

/** Trading Duel board: ranked duel rating, all time (GET /api/duel/board; behind the Turbo pass until launch, so the tab only shows when it answers). */
interface DuelRow { rank: number; wallet: string; name: string; rating: number; w: number; l: number; games: number; streak: number; peak: number }
interface DuelBoardRes { ok: boolean; rows: DuelRow[]; total: number; me: DuelRow | null }
export const DUEL_BOARD_COPY = {
  tab: "Duels",
  cols: { rank: "#", pilot: "Pilot", rating: "Rating", record: "Record", peak: "Best" },
  emptyTitle: "No ranked duels yet",
  play: "Find a duel",
} as const;
const recTxt = (r: DuelRow) => `${r.w}-${r.l}`;
function DuelTable({ d, meLc }: { d: DuelBoardRes; meLc?: string }) {
  const c = DUEL_BOARD_COPY.cols;
  const pinned = d.me && !d.rows.some((r) => r.wallet === d.me!.wallet) ? d.me : null;
  const row = (r: DuelRow, self: boolean) => (
    <Link key={r.wallet} href={`/u/${r.wallet}`} prefetch={false} className={`tp-row${self ? " tp-me" : ""}`} aria-label={`#${r.rank} ${r.name}`}>
      <span className="tp-rk">{r.rank}</span>
      <div className="tp-who">
        <span className="tp-av sm" style={{ background: lightOf(r.wallet) }} aria-hidden>{(r.name.replace(/^@/, "")[0] ?? "?").toUpperCase()}</span>
        <div><b>{self ? `${LEADERBOARD_COPY.you} · ${r.name}` : r.name}{r.streak >= 3 && <span className="tp-tag"> · {r.streak} win streak</span>}</b><span className="tp-p">{recTxt(r)}</span></div>
      </div>
      <span className="tp-num up">{r.rating.toLocaleString("en-US")}</span>
      <span className="tp-rec tp-d">{recTxt(r)}</span>
      <span className="tp-num tp-d tp-dim">{r.peak.toLocaleString("en-US")}</span>
    </Link>
  );
  return (
    <section className="tp-card tp-table" aria-label="Duel rankings" data-testid="lb-duels">
      <div className="tp-th tp-d" aria-hidden><span>{c.rank}</span><span>{c.pilot}</span><span>{c.rating}</span><span>{c.record}</span><span>{c.peak}</span></div>
      <div className="tp-rows">{d.rows.map((r) => row(r, r.wallet === meLc))}</div>
      {pinned && row(pinned, true)}
    </section>
  );
}

/** This month's season ladder (lib/duel/season), above the all-time duel table. Your league, your SP and the top 10. */
interface SeasonRes { ok: boolean; season: { id: string; n: number; endsAt: number }; rows: { rank: number; wallet: string; name: string; pts: number; league: string }[]; total: number; me: { rank: number; pts: number; league: string } | null }
function SeasonLadder({ d }: { d: SeasonRes }) {
  const days = Math.max(0, Math.ceil((d.season.endsAt - Date.now()) / 86_400_000));
  const mine = d.me ? leagueProgress(d.me.pts) : null;
  const L = (id: string) => LEAGUES.find((l) => l.id === id) ?? LEAGUES[0];
  return (
    <section className="tp-card" aria-label={`Season ${d.season.n} ladder`} data-testid="lb-season" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <b className="r2-g" style={{ fontSize: 22 }}>Season {d.season.n}</b>
        <span className="tp-p">{days} {days === 1 ? "day" : "days"} left</span>
      </div>
      {mine && d.me ? (
        <div style={{ marginTop: 10 }}>
          <span style={{ color: mine.league.color, fontWeight: 700 }}>{mine.league.name}</span> · {d.me.pts.toLocaleString("en-US")} SP · #{d.me.rank}
          {mine.next && <div aria-hidden style={{ marginTop: 6, height: 6, borderRadius: 3, background: "rgba(255,255,255,.1)" }}><i style={{ display: "block", height: 6, borderRadius: 3, width: `${Math.round(mine.pct * 100)}%`, background: mine.next.color }} /></div>}
          {mine.next && <span className="tp-p">{(mine.next.min - d.me.pts).toLocaleString("en-US")} SP to {mine.next.name}</span>}
        </div>
      ) : <span className="tp-p" style={{ display: "block", marginTop: 8 }}>Unranked this season</span>}
      {d.rows.length > 0 && (
        <ol style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "grid", gap: 6 }}>
          {d.rows.slice(0, 10).map((r) => (
            <li key={r.wallet} style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span className="tp-rk">{r.rank}</span><b style={{ flex: 1 }}>{r.name}</b>
              <span style={{ color: L(r.league).color }}>{L(r.league).name}</span><span className="tp-num">{r.pts.toLocaleString("en-US")}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function LeaderboardView() {
  const [win, setWin] = useState<BoardWindow>("day");
  const [tab, setTab] = useState<Tab>("traders");
  const [me, setMe] = useState<string | null>(null);
  const [traders, setTraders] = useState<BoardResponse | null>(null);
  const [positions, setPositions] = useState<PositionsResponse | null>(null);
  const [crews, setCrews] = useState<CrewBoardResponse | null>(null);
  const [duel, setDuel] = useState<DuelBoardRes | null>(null);
  const [season, setSeason] = useState<SeasonRes | null>(null);
  const picked = useRef(false);
  useEffect(() => onWallet((a) => setMe(a ?? null)), []);
  const isDuel = tab === "duel";
  // Duels tab: ranked = real money only (lib/duel/season DUEL_RANKED_LIVE); shows only when the duel board answers
  useEffect(() => {
    if (!DUEL_RANKED_LIVE) return;
    let alive = true;
    const q = me ? `?me=${me}` : "";
    fetch(withBase(`/api/duel/board${q}`)).then((r) => (r.ok ? r.json() : null)).then((d: DuelBoardRes | null) => { if (alive && d?.ok) setDuel(d); }).catch(() => {});
    if (isDuel) fetch(withBase(`/api/duel/board?board=season${me ? `&me=${me}` : ""}`)).then((r) => (r.ok ? r.json() : null)).then((d: SeasonRes | null) => { if (alive && d?.ok) setSeason(d); }).catch(() => {});
    return () => { alive = false; };
  }, [me, isDuel]);

  useEffect(() => {
    if (isDuel) return;
    let alive = true;
    const sort = tab === "traders" ? "pnl" : tab;
    const q = new URLSearchParams({ window: win, sort });
    if (me && sort !== "positions") q.set("me", me);
    const empty = () => {
      if (tab === "positions") setPositions({ window: win, sort: "positions", rows: [], coins: {} });
      else if (tab === "traders") setTraders({ window: win, sort: "pnl", rows: [], coins: {}, counts: { day: 0, week: 0, month: 0, all: 0 }, me: null, bestCall: null });
    };
    fetch(withBase(`/api/leaderboard?${q}`)).then((r) => (r.ok ? r.json() : null)).then((d: BoardResponse | CrewBoardResponse | PositionsResponse | null) => {
      if (!alive) return;
      if (!d) { empty(); return; }
      if (d.sort === "crews") { setCrews(d); return; }
      if (d.sort === "positions") { setPositions(d); return; }
      // open on the shortest window that has anyone in it (once), like the lobby shelf
      if (!picked.current) {
        picked.current = true;
        const first = BOARD_WINDOWS.find((w) => d.counts[w.k] > 0)?.k;
        if (first && first !== win && d.counts[win] === 0) { setWin(first); return; }
      }
      setTraders(d);
    }).catch(() => { if (alive) empty(); });
    return () => { alive = false; };
  }, [win, tab, me, isDuel]);

  const loading = isDuel ? !duel
    : tab === "crews" ? !crews || crews.window !== win
    : tab === "positions" ? !positions || positions.window !== win
    : !traders || traders.window !== win;
  const emptyBoard = (
    <section className="tp-card tp-empty" data-testid="lb-empty">
      <AnimClip id="A5-podium-empty" ratio="none" loop poster whenVisible className="tp-emptyvid" />
      <span className="r2-eb">{WIN_LABEL[win]}</span>
      <b className="r2-g">{LEADERBOARD_COPY.emptyTitle}</b>
      <div className="tp-acts">
        <Link href="/play" prefetch={false} className="r2-gold tp-play">{LEADERBOARD_COPY.play}</Link>
        <Link href={BOT_DUEL_HREF} prefetch={false} className="r2-gold tp-play tp-play2" data-testid="lb-empty-duel">{LEADERBOARD_COPY.duel}</Link>
      </div>
    </section>
  );

  return (
    <div className={`tp-page${tab === "traders" ? " t-traders" : ""}`} data-testid="leaderboard">
      <div className="tp-head">
        <h1 className="r2-g">{LEADERBOARD_COPY.title}</h1>
      </div>
      <div className="tp-bar">
        <div className="tp-tabs" role="tablist" aria-label="Board">
          {TABS.map((s) => (
            <button key={s.k} type="button" role="tab" aria-selected={tab === s.k} className={tab === s.k ? "on" : ""} onClick={() => setTab(s.k)}>{s.label}</button>
          ))}
          {duel && <button type="button" role="tab" aria-selected={isDuel} className={isDuel ? "on" : ""} onClick={() => setTab("duel")} data-testid="lb-duel-tab">{DUEL_BOARD_COPY.tab}</button>}
        </div>
        {!isDuel && <div className="tp-wins" role="tablist" aria-label="Time window">
          {BOARD_WINDOWS.map((w) => (
            <button key={w.k} type="button" role="tab" aria-selected={win === w.k} className={win === w.k ? "on" : ""} onClick={() => { picked.current = true; setWin(w.k); }}>{WIN_LABEL[w.k]}</button>
          ))}
        </div>}
      </div>

      {loading ? (
        <div className="tp-loading" aria-busy="true" />
      ) : isDuel ? (
        duel && duel.rows.length ? <>{season && <SeasonLadder d={season} />}<DuelTable d={duel} meLc={me?.toLowerCase()} /></> : (
          <section className="tp-card tp-empty" data-testid="lb-empty">
            <AnimClip id="A5-podium-empty" ratio="none" loop poster whenVisible className="tp-emptyvid" />
            <b className="r2-g">{DUEL_BOARD_COPY.emptyTitle}</b>
            <Link href="/turbo/duel" prefetch={false} className="r2-gold tp-play">{DUEL_BOARD_COPY.play}</Link>
          </section>
        )
      ) : tab === "crews" ? (
        crews && crews.crews.length ? <CrewTable d={crews} /> : (
          <section className="tp-card tp-empty" data-testid="lb-empty">
            <b className="r2-g">No crews yet</b>
            <Link href="/crew" prefetch={false} className="r2-gold tp-play">Find a crew</Link>
          </section>
        )
      ) : tab === "positions" ? (
        positions && positions.rows.length ? <Positions d={positions} me={me} /> : emptyBoard
      ) : traders && (traders.rows.length || traders.me) ? <Traders d={traders} me={me} /> : emptyBoard}
    </div>
  );
}
