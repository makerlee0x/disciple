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
import { LEAGUES, leagueBy, leagueProgress } from "@/lib/duel/season";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/base-path";
import { onWallet } from "@/lib/walletState"; // = lib/wallet's, without viem
import { displayName } from "@/lib/defaultUsername";
import { profileUrl } from "@/lib/profile";
import { altShort, lightOf } from "@/components/home/rocketBits";
import { isStoreSrc } from "@/lib/coinImages";
import { BOARD_WINDOWS, type BoardPilot, type BoardWindow } from "@/lib/home/topPilots";
import type { BoardCoin, BoardResponse, CrewBoardResponse, LifetimeResponse, LifetimeRow, ModeResponse, ModeRow, Named, OverallResponse, OverallRow, PositionsResponse } from "@/lib/server/leaderboard";
import PointsShare from "@/components/points/PointsShare";
import { BOT_DUEL_HREF, CREW_ENABLED, ROYALE_ENABLED } from "@/lib/features";
import { DUEL_RANKED_LIVE, seasonAt } from "@/lib/duel/season";
import { skinArt } from "@/lib/collection";
import AnimClip from "@/components/ui/AnimClip";
import { CLIMB_FREE } from "@/lib/climb/rules";
import { PAIR_SORTS, type PairSort } from "@/lib/home/pairBoard";
import type { PairBoardResponse } from "@/lib/server/pairBoard";

/** Mode tabs (maker 2026-11-18): Overall = season points from every mode (lib/season/points); each mode ranks on its own number. */
type Mode = "overall" | "rockets" | "pairs" | "duel" | "royale" | "climb" | "crews";
const MODES: { k: Mode; label: string }[] = [
  { k: "overall", label: "Overall" },
  { k: "rockets", label: "Rockets" },
  { k: "pairs", label: "Pairs" },
  { k: "duel", label: "Duel" },
  ...(ROYALE_ENABLED ? [{ k: "royale" as Mode, label: "Royale" }] : []),   // held for launch (lib/features)
  { k: "climb", label: "Climb" },
  ...(CREW_ENABLED ? [{ k: "crews" as Mode, label: "Crews" }] : []),
];
/** Rockets sub-tabs */
type Sub = "traders" | "positions";
const SUBS: { k: Sub; label: string }[] = [{ k: "traders", label: "Traders" }, { k: "positions", label: "Positions" }];
/** Overall sub-tabs (maker 2026-11-18): this season's SP ladder, or lifetime points (never reset; the airdrop ranking) */
type View = "season" | "lifetime";
const VIEWS: { k: View; label: string }[] = [{ k: "season", label: "Season" }, { k: "lifetime", label: "Lifetime" }];
const PLAY: Record<"duel" | "royale" | "climb", { href: string; label: string }> = {
  duel: { href: "/turbo/duel", label: "Play a duel" },
  royale: { href: "/turbo/royale", label: "Play Royale" },
  climb: { href: "/turbo/climb", label: "Play Climb" },
};
const WIN_LABEL: Record<BoardWindow, string> = { day: "24H", week: "7D", month: "30D", all: "ALL" };

export const LEADERBOARD_COPY = {
  title: "Top pilots",
  yourRank: "Your rank",
  pnl: "PnL",
  cols: { rank: "#", pilot: "Pilot", rocket: "Rocket", size: "Size", entry: "Entry → exit", pnl: "PnL", pct: "%", held: "Held", closed: "Closed", crew: "Crew", green: "Green rockets", pilots: "Pilots" },
  more: "Show 10 more",
  you: "You",
  emptyTitle: "The top spot is open",
  realOnly: "Nothing ranked yet",
  sp: "SP",
  pts: "Points",
  share: "Share",
  season: (n: number) => `Season ${n}`,
  ends: "Ends in",
  starts: "Starts in",
  head: { pnl: "PnL", pts: "Points", level: "Level" },
  play: "Play now",
  duel: "Play a duel",
  pairs: { coin: "Coin", cut: "Elimination zone", by: { score: "Score", volume: "Volume", burned: "Burned", rockets: "Rockets", traders: "Traders" } as Record<PairSort, string> },
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
/** The pilot's rocket: their equipped hull skin, upright (maker 2026-11-18: show what their rocket looks like). */
function Hull({ skin }: { skin?: string }) {
  return (
    <span className="tp-hull" aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {skin ? <img src={withBase(skinArt(skin))} alt="" loading="lazy" decoding="async" /> : null}
    </span>
  );
}

/** Season countdown, a real clock (maker 2026-11-18: "way more pronounced"): days / hours / minutes to the season's end, or to its start before launch. */
function SeasonClock({ n, startsAt, endsAt }: { n: number; startsAt: number; endsAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  const pre = now < startsAt;
  const left = Math.max(0, (pre ? startsAt : endsAt) - now);
  const d = Math.floor(left / 86_400_000), h = Math.floor(left / 3_600_000) % 24, m = Math.floor(left / 60_000) % 60;
  const span = endsAt - startsAt, done = pre ? 0 : Math.min(1, Math.max(0, (now - startsAt) / span));
  const C = LEADERBOARD_COPY;
  return (
    <div className="tp-clock" data-testid="lb-season-clock" aria-label={`${C.season(n)} ${pre ? C.starts : C.ends} ${d} days ${h} hours`}>
      <div className="tp-clockh"><b className="r2-g">{C.season(n)}</b><span>{pre ? C.starts : C.ends}</span></div>
      <div className="tp-clockd" aria-hidden>
        {([[d, "D"], [h, "H"], [m, "M"]] as const).map(([v, u]) => <span key={u}><b className="r2-g">{String(v).padStart(2, "0")}</b><i>{u}</i></span>)}
      </div>
      <i className="tp-clockbar" aria-hidden><i style={{ width: `${Math.round(done * 100)}%` }} /></i>
    </div>
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
      <Hull skin={p.skin} />
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

/** Column heads over a ranked list: # · Pilot · the number. */
function THead({ v }: { v: string }) {
  return <div className="tp-thead" aria-hidden><span>#</span><span>{LEADERBOARD_COPY.cols.pilot}</span><span>{v}</span></div>;
}

function YourRank({ face, rank, label, value, down, share }: { face: { wallet: string } & Named & { username?: string | null }; rank: number | null; label: string; value: string; down?: boolean; share?: () => void }) {
  return (
    <div className={`tp-mine${share ? " has-share" : ""}`} data-testid="lb-me">
      <Face p={face} big />
      <div className="tp-minerk"><span>{LEADERBOARD_COPY.yourRank}</span><b className="r2-g"><i>#</i> {rank ? rank.toLocaleString("en-US") : "—"}</b></div>
      <div className="tp-minepnl"><span>{label}</span><b className={`r2-g ${down ? "down" : "up"}`}>{value}</b></div>
      {share && <button type="button" className="tp-share" onClick={share} data-testid="lb-share">{LEADERBOARD_COPY.share}</button>}
    </div>
  );
}

function Traders({ d, me }: { d: BoardResponse; me: string | null }) {
  const [shown, setShown] = useState(10);
  useEffect(() => { setShown(10); }, [d.window]);
  const meLc = me?.toLowerCase();
  return (
    <section className="tp-card tp-traders" aria-label="Traders" data-testid="lb-traders">
      {me && <YourRank face={d.me ?? { wallet: me.toLowerCase() }} rank={d.me?.rank ?? null} label={LEADERBOARD_COPY.pnl} value={signed(d.me?.pnlUsd ?? 0)} down={!!d.me && d.me.pnlUsd < 0} />}
      <THead v={LEADERBOARD_COPY.head.pnl} />
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

const sp = (n: number) => `${Math.round(n).toLocaleString("en-US")} ${LEADERBOARD_COPY.sp}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** One ranked row on a points / level board (Overall, Royale, Climb): rank, face, name + chip, the number. */
function PointRow({ p, chip, chipColor, prev, value, self }: { p: { wallet: string; username: string | null; rank: number } & Named; chip?: string; chipColor?: string; prev?: string; value: string; self?: boolean }) {
  const router = useRouter();
  const go = () => router.push(hrefOf(p));
  return (
    <div className={`tp-trow${self ? " self" : ""}`} role="link" tabIndex={0} onClick={go} onKeyDown={(e) => { if (e.key === "Enter") go(); }} aria-label={`#${p.rank} ${nameOf(p)}`}>
      <Rank n={p.rank} />
      <Face p={p} big />
      <Hull skin={p.skin} />
      <div className="tp-tname"><b>{nameOf(p)}</b>{chip ? <span style={chipColor ? { color: chipColor } : undefined}>{chip}</span> : null}{prev ? <span className="tp-prev">{prev}</span> : null}</div>
      <div className="tp-tpnl"><b className="r2-g tp-white">{value}</b></div>
    </div>
  );
}

/* Tiers (maker 2026-11-18, the LoL ladder): the visible tier is the league from season points; a filter by tier, the cutoff
   for the top two tiers up top, and last season's finish as a badge. Matchmaking stays on the hidden rating. */
const TOP_TIERS = [...LEAGUES].reverse().slice(0, 2);
function Overall({ d, me, seasonN }: { d: OverallResponse; me: string | null; seasonN: number }) {
  const meLc = me?.toLowerCase();
  const m = d.me;
  const [tier, setTier] = useState<string>("all");
  const rows = tier === "all" ? d.rows : d.rows.filter((r) => r.league === tier);
  const prevOf = (r: OverallRow) => (r.prev ? `S${seasonN - 1} ${leagueBy(r.prev).name}` : undefined);
  return (
    <>
      <div className="tp-cuts" aria-label="Top tiers">
        {TOP_TIERS.map((l) => (
          <span key={l.id} style={{ color: l.color }}><b>{l.name}</b> {l.min.toLocaleString("en-US")} SP<i>{(d.tiers?.[l.id] ?? 0).toLocaleString("en-US")} {(d.tiers?.[l.id] ?? 0) === 1 ? "pilot" : "pilots"}</i></span>
        ))}
      </div>
      <div className="tp-sorts tp-tiers" role="group" aria-label="Tier">
        <button type="button" className={tier === "all" ? "on" : undefined} onClick={() => setTier("all")}>All tiers</button>
        {[...LEAGUES].reverse().map((l) => (
          <button key={l.id} type="button" className={tier === l.id ? "on" : undefined} onClick={() => setTier(l.id)} style={tier === l.id ? undefined : { color: l.color }}>{l.name}</button>
        ))}
      </div>
      <section className="tp-card tp-traders" aria-label="Overall" data-testid="lb-overall">
        {me && <YourRank face={m ?? { wallet: meLc! }} rank={m?.rank ?? null} label={m ? leagueBy(m.league).name : LEADERBOARD_COPY.sp} value={sp(m?.pts ?? 0)} />}
        <THead v={LEADERBOARD_COPY.sp} />
        <div className="tp-trows">
          {rows.map((r: OverallRow) => <PointRow key={r.wallet} p={r} chip={leagueBy(r.league).name} chipColor={leagueBy(r.league).color} prev={prevOf(r)} value={sp(r.pts)} self={r.wallet === meLc} />)}
        </div>
      </section>
    </>
  );
}

const pts = (n: number) => Math.round(n).toLocaleString("en-US");
/** Lifetime points: every season added up, never reset. The chip is this season's tier. */
function Lifetime({ d, me }: { d: LifetimeResponse; me: string | null }) {
  const meLc = me?.toLowerCase();
  const m = d.me;
  const [card, setCard] = useState(false);
  return (
    <section className="tp-card tp-traders" aria-label="Lifetime" data-testid="lb-lifetime">
      {me && <YourRank face={m ?? { wallet: meLc! }} rank={m?.rank ?? null} label={LEADERBOARD_COPY.pts} value={pts(m?.pts ?? 0)} share={m?.username ? () => setCard(true) : undefined} />}
      <THead v={LEADERBOARD_COPY.head.pts} />
      <div className="tp-trows">
        {d.rows.map((r: LifetimeRow) => <PointRow key={r.wallet} p={r} chip={leagueBy(r.league).name} chipColor={leagueBy(r.league).color} value={pts(r.pts)} self={r.wallet === meLc} />)}
      </div>
      {m?.username && <PointsShare handle={m.username} pts={m.pts} rank={m.rank} open={card} onClose={() => setCard(false)} />}
    </section>
  );
}

function ModeBoard({ d, me }: { d: ModeResponse; me: string | null }) {
  const meLc = me?.toLowerCase();
  return (
    <section className="tp-card tp-traders" aria-label={d.sort} data-testid={`lb-${d.sort}`}>
      <THead v={d.sort === "climb" ? LEADERBOARD_COPY.head.level : LEADERBOARD_COPY.sp} />
      <div className="tp-trows">
        {d.rows.map((r: ModeRow) => d.sort === "climb"
          ? <PointRow key={r.wallet} p={r} chip={r.clearMs != null ? secs(r.clearMs) : undefined} value={(r.climbLevel ?? 1) >= CLIMB_FREE ? "Free" : `Lvl ${r.climbLevel ?? 1}`} self={r.wallet === meLc} />
          : <PointRow key={r.wallet} p={r} value={sp(r.pts ?? 0)} self={r.wallet === meLc} />)}
      </div>
    </section>
  );
}

function RealOnly({ mode }: { mode: "duel" | "royale" | "climb" }) {
  return (
    <section className="tp-card tp-empty" data-testid="lb-empty">
      <AnimClip id="A5-podium-empty" ratio="none" loop poster whenVisible className="tp-emptyvid" />
      <b className="r2-g">{LEADERBOARD_COPY.realOnly}</b>
      <Link href={PLAY[mode].href} prefetch={false} className="r2-gold tp-play">{PLAY[mode].label}</Link>
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

/** This season's ladder (lib/duel/season), above the all-time duel table. Your league, your SP and the top 10. */
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


/* ── Pairs (maker 2026-11-20): the pair coins ranked by what their rockets did this season. Top PAIR_SAFE are safe; the
   rest sit under the elimination line. The line only shows on the ranking that decides it (PAIR_CUT_BY). ───────────── */
const compact = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return Math.round(v).toLocaleString("en-US");
};
const usdCompact = (v: number) => `$${compact(v)}`;
const burnPct = (p: number) => (p <= 0 ? "0%" : p < 0.0001 ? "<0.01%" : `${(p * 100).toFixed(p < 0.01 ? 2 : 1)}%`);
type PairRowT = PairBoardResponse["rows"][number];
const PAIR_VALUE: Record<PairSort, (r: PairRowT) => string> = {
  score: (r) => r.score.toLocaleString("en-US"),
  volume: (r) => usdCompact(r.volumeUsd),
  burned: (r) => (r.burnedPct > 0 ? burnPct(r.burnedPct) : compact(r.burned)),
  rockets: (r) => r.rockets.toLocaleString("en-US"),
  traders: (r) => r.traders.toLocaleString("en-US"),
};
/** The other three numbers as chips: a word each, no sentences. */
const PAIR_CHIP: Record<PairSort, (r: PairRowT) => string> = {
  score: (r) => `${r.score.toLocaleString("en-US")} pts`,
  volume: (r) => `${usdCompact(r.volumeUsd)} vol`,
  burned: (r) => `${compact(r.burned)} burned`,
  rockets: (r) => `${r.rockets.toLocaleString("en-US")} ${r.rockets === 1 ? "rocket" : "rockets"}`,
  traders: (r) => `${r.traders.toLocaleString("en-US")} ${r.traders === 1 ? "trader" : "traders"}`,
};
function PairRow({ r, by, out }: { r: PairRowT; by: PairSort; out: boolean }) {
  return (
    <div className={`tp-trow tp-pair${out ? " out" : ""}`} data-testid={`lb-pair-${r.symbol}`} aria-label={`#${r.rank} $${r.symbol}`}>
      {out ? <span className="tp-rk tp-rkout">{r.rank}</span> : <Rank n={r.rank} />}
      <span className="tp-av md tp-pairlogo" aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={withBase(r.icon)} alt="" loading="lazy" decoding="async" />
      </span>
      <div className="tp-tname">
        <b>${r.symbol}</b>
        <div className="tp-pairchips">{PAIR_SORTS.filter((k) => k !== by && k !== "score").map((k) => <span key={k} className={`k-${k}`}>{PAIR_CHIP[k](r)}</span>)}</div>
      </div>
      <div className="tp-tpnl"><b className={`r2-g ${out ? "tp-red" : "tp-white"}`}>{PAIR_VALUE[by](r)}</b></div>
    </div>
  );
}
function PairsBoard({ d }: { d: PairBoardResponse }) {
  const line = d.by === d.cutBy;
  const C = LEADERBOARD_COPY.pairs;
  return (
    <section className="tp-card tp-traders tp-pairs" aria-label="Pairs" data-testid="lb-pairs">
      <div className="tp-thead" aria-hidden><span>#</span><span>{C.coin}</span><span>{C.by[d.by]}</span></div>
      <div className="tp-trows">
        {d.rows.map((r) => (
          <Fragment key={r.address}>
            {line && r.rank === d.safe + 1 && <div className="tp-cut" data-testid="lb-pair-cut"><i aria-hidden /><b className="r2-g">{C.cut}</b><i aria-hidden /></div>}
            <PairRow r={r} by={d.by} out={line && r.rank > d.safe} />
          </Fragment>
        ))}
      </div>
    </section>
  );
}

export default function LeaderboardView() {
  const [win, setWin] = useState<BoardWindow>("day");
  const [mode, setMode] = useState<Mode>("overall");
  // ?tab=duel|climb|rockets (the stats page's rank tiles link here)
  useEffect(() => { const t = new URLSearchParams(window.location.search).get("tab"); const m = MODES.find((x) => x.k === t); if (m) setMode(m.k); }, []);
  const [sub, setSub] = useState<Sub>("traders");
  const [view, setView] = useState<View>("season");
  const [life, setLife] = useState<LifetimeResponse | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [traders, setTraders] = useState<BoardResponse | null>(null);
  const [positions, setPositions] = useState<PositionsResponse | null>(null);
  const [overall, setOverall] = useState<OverallResponse | null>(null);
  const [boards, setBoards] = useState<Partial<Record<"royale" | "climb", ModeResponse>>>({});
  const [crews, setCrews] = useState<CrewBoardResponse | null>(null);
  const [duel, setDuel] = useState<DuelBoardRes | null>(null);
  const [season, setSeason] = useState<SeasonRes | null>(null);
  const [pairBy, setPairBy] = useState<PairSort>("score");
  const [pairs, setPairs] = useState<PairBoardResponse | null>(null);
  const picked = useRef(false);
  useEffect(() => onWallet((a) => setMe(a ?? null)), []);
  // Duel: ranked = real money only (lib/duel/season DUEL_RANKED_LIVE); until then the tab says so
  useEffect(() => {
    if (!DUEL_RANKED_LIVE || mode !== "duel") return;
    let alive = true;
    const q = me ? `&me=${me}` : "";
    fetch(withBase(`/api/duel/board?x=1${q}`)).then((r) => (r.ok ? r.json() : null)).then((d: DuelBoardRes | null) => { if (alive && d?.ok) setDuel(d); }).catch(() => {});
    fetch(withBase(`/api/duel/board?board=season${q}`)).then((r) => (r.ok ? r.json() : null)).then((d: SeasonRes | null) => { if (alive && d?.ok) setSeason(d); }).catch(() => {});
    return () => { alive = false; };
  }, [me, mode]);

  useEffect(() => {
    if (mode !== "pairs") return;
    let alive = true;
    fetch(withBase(`/api/leaderboard?sort=pairs&by=${pairBy}`)).then((r) => (r.ok ? r.json() : null)).then((d: PairBoardResponse | null) => { if (alive && d?.rows) setPairs(d); }).catch(() => {});
    return () => { alive = false; };
  }, [mode, pairBy]);

  useEffect(() => {
    if (mode === "duel" || mode === "pairs") return;
    let alive = true;
    const sort = mode === "rockets" ? (sub === "traders" ? "pnl" : "positions") : mode === "overall" && view === "lifetime" ? "lifetime" : mode;
    const q = new URLSearchParams({ window: win, sort });
    if (me && sort !== "positions") q.set("me", me);
    type Res = BoardResponse | CrewBoardResponse | PositionsResponse | OverallResponse | LifetimeResponse | ModeResponse;
    const take = (d: Res | null) => {
      if (!alive) return;
      if (!d) d = sort === "positions" ? { window: win, sort: "positions", rows: [], coins: {} }
        : sort === "pnl" ? { window: win, sort: "pnl", rows: [], coins: {}, counts: { day: 0, week: 0, month: 0, all: 0 }, me: null, bestCall: null }
        : sort === "overall" ? { sort: "overall", season: { n: 1, endsAt: Date.now() }, rows: [], total: 0, me: null, tiers: {} }
        : sort === "lifetime" ? { sort: "lifetime", season: { n: 1, endsAt: Date.now() }, rows: [], total: 0, me: null }
        : sort === "royale" || sort === "climb" ? { sort, season: { n: 1, endsAt: Date.now() }, rows: [] } : null;
      if (!d) return;
      if (d.sort === "crews") setCrews(d);
      else if (d.sort === "positions") setPositions(d);
      else if (d.sort === "overall") setOverall(d);
      else if (d.sort === "lifetime") setLife(d);
      else if (d.sort === "royale" || d.sort === "climb") { const m = d; setBoards((b) => ({ ...b, [m.sort]: m })); }
      else {
        const b = d as BoardResponse;
        // open on the shortest window that has anyone in it (once), like the lobby shelf
        if (!picked.current) {
          picked.current = true;
          const first = BOARD_WINDOWS.find((w) => b.counts[w.k] > 0)?.k;
          if (first && first !== win && b.counts[win] === 0) { setWin(first); return; }
        }
        setTraders(b);
      }
    };
    fetch(withBase(`/api/leaderboard?${q}`)).then((r) => (r.ok ? r.json() : null)).then(take).catch(() => take(null));
    return () => { alive = false; };
  }, [win, mode, sub, view, me]);

  const rockets = mode === "rockets";
  const loading = mode === "pairs" ? !pairs || pairs.by !== pairBy
    : mode === "duel" ? DUEL_RANKED_LIVE && !duel
    : mode === "crews" ? !crews || crews.window !== win
    : mode === "overall" ? (view === "lifetime" ? !life : !overall)
    : mode === "royale" || mode === "climb" ? !boards[mode]
    : sub === "positions" ? !positions || positions.window !== win
    : !traders || traders.window !== win;
  const seasonInfo = overall?.season ?? life?.season ?? boards.royale?.season ?? boards.climb?.season;
  const clock = seasonAt(Date.now());
  const emptyBoard = (
    <section className="tp-card tp-empty" data-testid="lb-empty">
      <AnimClip id="A5-podium-empty" ratio="none" loop poster whenVisible className="tp-emptyvid" />
      <b className="r2-g">{LEADERBOARD_COPY.emptyTitle}</b>
      <div className="tp-acts">
        <Link href="/play" prefetch={false} className="r2-gold tp-play">{LEADERBOARD_COPY.play}</Link>
        <Link href={BOT_DUEL_HREF} prefetch={false} className="r2-gold tp-play tp-play2" data-testid="lb-empty-duel">{LEADERBOARD_COPY.duel}</Link>
      </div>
    </section>
  );

  let body: React.ReactNode;
  if (loading) body = <div className="tp-loading" aria-busy="true" />;
  else if (mode === "pairs") body = <PairsBoard d={pairs!} />;
  else if (mode === "duel") body = DUEL_RANKED_LIVE && duel && duel.rows.length ? <>{season && <SeasonLadder d={season} />}<DuelTable d={duel} meLc={me?.toLowerCase()} /></> : <RealOnly mode="duel" />;
  else if (mode === "royale" || mode === "climb") body = boards[mode]?.rows.length ? <ModeBoard d={boards[mode]!} me={me} /> : <RealOnly mode={mode} />;
  else if (mode === "overall" && view === "lifetime") body = life && (life.rows.length || life.me) ? <Lifetime d={life} me={me} /> : emptyBoard;
  else if (mode === "overall") body = overall && (overall.rows.length || overall.me) ? <Overall d={overall} me={me} seasonN={overall.season.n} /> : emptyBoard;
  else if (mode === "crews") body = crews && crews.crews.length ? <CrewTable d={crews} /> : (
    <section className="tp-card tp-empty" data-testid="lb-empty">
      <b className="r2-g">No crews yet</b>
      <Link href="/crew" prefetch={false} className="r2-gold tp-play">Find a crew</Link>
    </section>
  );
  else if (sub === "positions") body = positions && positions.rows.length ? <Positions d={positions} me={me} /> : emptyBoard;
  else body = traders && (traders.rows.length || traders.me) ? <Traders d={traders} me={me} /> : emptyBoard;

  const narrow = !(rockets && sub === "positions");
  return (
    <div className={`tp-page${narrow ? " t-traders" : ""}`} data-testid="leaderboard">
      <div className="tp-frame">
      <div className="tp-head">
        <h1 className="r2-g">{LEADERBOARD_COPY.title}</h1>
        <SeasonClock n={clock.n} startsAt={clock.startsAt} endsAt={clock.endsAt} />
      </div>
      <div className="tp-modes" role="tablist" aria-label="Mode">
        {MODES.map((m) => (
          <button key={m.k} type="button" role="tab" aria-selected={mode === m.k} className={mode === m.k ? "on" : ""} onClick={() => setMode(m.k)} data-testid={`lb-mode-${m.k}`}>{m.label}</button>
        ))}
      </div>
      {mode === "pairs" ? (
        <div className="tp-bar tp-pairbar"><div className="tp-tabs" role="tablist" aria-label="Rank by">
          {PAIR_SORTS.map((k) => <button key={k} type="button" role="tab" aria-selected={pairBy === k} className={pairBy === k ? "on" : ""} onClick={() => setPairBy(k)} data-testid={`lb-pairby-${k}`}>{LEADERBOARD_COPY.pairs.by[k]}</button>)}
        </div></div>
      ) : (rockets || mode === "crews") ? (
        <div className="tp-bar">
          {rockets ? <div className="tp-tabs" role="tablist" aria-label="Board">
            {SUBS.map((s) => <button key={s.k} type="button" role="tab" aria-selected={sub === s.k} className={sub === s.k ? "on" : ""} onClick={() => setSub(s.k)}>{s.label}</button>)}
          </div> : <span />}
          <div className="tp-wins" role="tablist" aria-label="Time window">
            {BOARD_WINDOWS.map((w) => (
              <button key={w.k} type="button" role="tab" aria-selected={win === w.k} className={win === w.k ? "on" : ""} onClick={() => { picked.current = true; setWin(w.k); }}>{WIN_LABEL[w.k]}</button>
            ))}
          </div>
        </div>
      ) : seasonInfo && mode !== "duel" ? (
        <div className="tp-bar">{mode === "overall" ? <div className="tp-tabs" role="tablist" aria-label="Points">
          {VIEWS.map((v) => <button key={v.k} type="button" role="tab" aria-selected={view === v.k} className={view === v.k ? "on" : ""} onClick={() => setView(v.k)} data-testid={`lb-view-${v.k}`}>{v.label}</button>)}
        </div> : <span />}</div>
      ) : <div className="tp-bar tp-bar0" />}
      {body}
      </div>
    </div>
  );
}
