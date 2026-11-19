"use client";
/**
 * Pilot stats (/achievements, nav "Trophies"; public at /u/<name>/stats), maker 2026-11-19: the page a pilot screenshots.
 *   hero: who (pfp, name, level ring, tier), the three numbers that matter (season rank, lifetime points, realized PnL), rocket
 *   trophies, right under the hero (the nav says Trophies)
 *   ranks: one tile per mode (Duel, Climb, Daily mission, Rockets) with its rank and record
 *   career: win rate, trades, best rocket, best trade, orbits, bombs, launched, longest flight
 *   level rewards + orders (own page only), compact, at the bottom
 * Pure view: every number comes in on `d`. A null number shows "—" (never a made-up 0).
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { V1_RULES, achievementIconPath, rarityStyle } from "@/lib/achievements";
import { rarityRank } from "@/lib/config";
import { withBase } from "@/lib/base-path";
import { leagueBy } from "@/lib/duel/season";
import { MILESTONE_COPY, milestoneXp, missionById, type MissionStatus } from "@/lib/xp";
import type { Progress } from "@/lib/unlocks";
import Tooltip from "@/components/ui/Tooltip";
import Icon from "@/components/icons/Icon";
import { REWARDS, RewardArt, isOpen, whenLabel } from "./rewards";
import s from "./stats.module.css";

export type Coin = { ticker: string; icon: string };
export type StatsData = {
  own: boolean;
  name: string;
  handle: string | null;
  pfp: string;
  /** equipped hull skin art (lib/collection skinArt) */
  rocketArt: string;
  level: { level: number; prestige: number; prestigeName: string; progress: number } | null;
  season: { n: number; rank: number | null; total: number; pts: number; league: string } | null;
  lifetime: { pts: number; rank: number } | null;
  pnlUsd: number | null;
  duel: { rank: number | null; w: number; l: number; streak: number; peak: number } | null;
  climb: { rank: number | null; level: number; clearMs: number } | null;
  daily: { best: number | null; played: number; today: number | null } | null;
  rockets: { rank: number | null; green: number; red: number; orbits: number } | null;
  career: {
    winRate: number | null; trades: number; bestRocket: (Coin & { pnlUsd: number }) | null; bestTrade: (Coin & { pct: number; pnlUsd: number }) | null;
    bombs: number; launched: number; longestMs: number; totalXp: number | null;
  } | null;
  trophies: Map<string, number> | null;
  orders: { daily: MissionStatus[]; weekly: MissionStatus[] } | null;
};

const n0 = (n: number) => n.toLocaleString("en-US");
const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sUsd = (n: number) => `${n >= 0 ? "+" : ""}${usd(n)}`;
const rk = (r: number | null | undefined) => (r ? `#${n0(r)}` : "—");
const dur = (ms: number) => { const h = Math.floor(ms / 3_600_000); if (h >= 48) return `${Math.floor(h / 24)}d`; if (h >= 1) return `${h}h`; return `${Math.max(1, Math.round(ms / 60_000))}m`; };
const clock = (ms: number) => { const t = Math.round(ms / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };

export default function StatsView({ d, onShare }: { d: StatsData; onShare?: () => void }) {
  const lg = d.season ? leagueBy(d.season.league) : null;
  return (
    <div className={s.page} data-testid="stats">
      <Hero d={d} lg={lg} onShare={onShare} />
      <Trophies got={d.trophies} />
      <section className={s.sec} aria-labelledby="st-ranks">
        <div className={s.secHead}><h2 id="st-ranks" className={s.h2}>Ranks</h2><span className={s.tag}>Season {d.season?.n ?? 1}</span></div>
        <div className={s.modes}>
          <Mode id="duel" title="Duel" art="/art/modes/duel.webp" tone="#FF9CC4" href="/leaderboard?tab=duel" rank={d.duel?.rank}
            rows={d.duel ? [["Record", `${n0(d.duel.w)}–${n0(d.duel.l)}`], ["Win rate", d.duel.w + d.duel.l ? `${Math.round((d.duel.w / (d.duel.w + d.duel.l)) * 100)}%` : "—"], ["Best streak", n0(d.duel.peak)]] : []} />
          <Mode id="climb" title="Climb" art="/art/modes/live.webp" tone="#5FF0A0" href="/leaderboard?tab=climb" rank={d.climb?.rank}
            rows={d.climb ? [["Best level", n0(d.climb.level)], ["Clear", d.climb.clearMs ? clock(d.climb.clearMs) : "—"]] : []} />
          <Mode id="daily" title="Daily mission" art="/art/modes/free.webp" tone="#8FE3FF" href="/flight/sim?daily=1" rank={d.daily?.today}
            rankLabel="Today" rows={d.daily ? [["Best finish", rk(d.daily.best)], ["Played", n0(d.daily.played)]] : []} />
          <Mode id="rockets" title="Rockets" art="/art/modes/launch.webp" tone="#F3DFA8" href="/leaderboard" rank={d.rockets?.rank}
            rows={d.rockets ? [["Green exits", n0(d.rockets.green)], ["Red exits", n0(d.rockets.red)], ["Orbits", n0(d.rockets.orbits)]] : []} />
        </div>
      </section>
      <Career c={d.career} />
      {d.own && (
        <div className={s.duo}>
          <Rewards level={d.level} got={d.trophies} />
          <Orders o={d.orders} />
        </div>
      )}
    </div>
  );
}

function Hero({ d, lg, onShare }: { d: StatsData; lg: ReturnType<typeof leagueBy> | null; onShare?: () => void }) {
  return (
    <section className={s.hero} aria-label="Pilot" data-testid="stats-hero">
      <div className={s.heroSky} aria-hidden />
      <div className={s.heroShade} aria-hidden />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {d.rocketArt && <img className={s.heroRocket} src={withBase(d.rocketArt)} alt="" aria-hidden />}
      <div className={s.heroId}>
        <div className={s.face}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {d.pfp ? <img src={withBase(d.pfp)} alt="" width={112} height={112} /> : <span>{(d.name.replace(/^@/, "")[0] ?? "?").toUpperCase()}</span>}
          {d.level && <b className={s.lv} aria-label={`Level ${d.level.level}`}>{d.level.level}</b>}
        </div>
        <div className={s.idTx}>
          <h1 className={s.name}>{d.name}</h1>
          <div className={s.chips}>
            {d.handle && <span className={s.handle}>{d.handle}</span>}
            {lg && <span className={s.tier} style={{ ["--tc" as string]: lg.color }}><Icon name="achievement" size={13} />{lg.name}</span>}
            {d.level && <span className={s.chip}>{d.level.prestigeName}</span>}
          </div>
          {d.level && <div className={s.xp} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(d.level.progress * 100)} aria-label="Level progress"><i style={{ width: `${Math.round(d.level.progress * 100)}%` }} /></div>}
        </div>
      </div>
      <div className={s.big}>
        <div><span>Season rank</span><b>{rk(d.season?.rank)}</b><em>{d.season ? `${n0(d.season.pts)} SP` : "—"}</em></div>
        <div><span>Lifetime points</span><b>{d.lifetime ? n0(d.lifetime.pts) : "—"}</b><em>{d.lifetime ? `#${n0(d.lifetime.rank)}` : "—"}</em></div>
        <div><span>Realized PnL</span><b className={d.pnlUsd == null ? "" : d.pnlUsd >= 0 ? s.up : s.down}>{d.pnlUsd == null ? "—" : sUsd(d.pnlUsd)}</b><em>All time</em></div>
      </div>
      {onShare && <button type="button" className={s.share} onClick={onShare} data-testid="stats-share"><Icon name="share" size={16} /><span>Share</span></button>}
    </section>
  );
}

function Trophies({ got }: { got: Map<string, number> | null }) {
  const [f, setF] = useState<"all" | "earned" | "locked">("all");
  const sorted = useMemo(() => [...V1_RULES].sort((a, b) => Number(!!got?.has(b.id)) - Number(!!got?.has(a.id)) || rarityRank(a.rarity) - rarityRank(b.rarity)), [got]);
  const earned = got ? sorted.filter((m) => got.has(m.id)).length : 0;
  const shown = sorted.filter((m) => f === "all" || (f === "earned") === !!got?.has(m.id));
  return (
    <section className={s.sec} aria-labelledby="st-trophies" data-testid="trophy-case">
      <div className={s.secHead}>
        <div className={s.secTitle}><h2 id="st-trophies" className={s.h2}>Trophies</h2><span className={s.count}>{earned} / {V1_RULES.length}</span></div>
        <div className={s.seg} role="tablist" aria-label="Show trophies">
          {(["all", "earned", "locked"] as const).map((k) => <button key={k} type="button" role="tab" aria-selected={f === k} className={f === k ? s.segOn : ""} onClick={() => setF(k)}>{k}</button>)}
        </div>
      </div>
      <ul className={s.case}>
        {shown.map((m) => {
          const at = got?.get(m.id), r = rarityStyle(m.rarity), c = MILESTONE_COPY[m.id] ?? { name: m.name, desc: "" };
          return (
            <Tooltip key={m.id} content={<><strong>{c.name} · {r.label}</strong>{c.desc}</>}>
              <li className={`${s.tro}${at ? ` ${s.on}` : ""}`} style={{ ["--rc" as string]: r.border, ["--rg" as string]: r.glow }} data-testid={`milestone-${m.id}`} tabIndex={0}>
                <span className={s.gem} aria-hidden>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={withBase(achievementIconPath(m.id))} alt="" width={64} height={64} onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
                </span>
                <span className={s.troName}>{c.name}</span>
                <span className={s.troFoot}>{at ? new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : <><Icon name="lock" size={11} />+{n0(milestoneXp(m.id, m.rarity))} XP</>}</span>
              </li>
            </Tooltip>
          );
        })}
      </ul>
    </section>
  );
}

function Mode({ id, title, art, tone, href, rank, rankLabel = "Rank", rows }: { id: string; title: string; art: string; tone: string; href: string; rank: number | null | undefined; rankLabel?: string; rows: [string, string][] }) {
  return (
    <Link href={href} prefetch={false} className={s.mode} style={{ ["--tone" as string]: tone }} data-testid={`rank-${id}`}>
      <span className={s.modeArt} style={{ backgroundImage: `url(${withBase(art)})` }} aria-hidden />
      <span className={s.modeHead}><span className={s.modeT}>{title}</span><span className={s.modeRk}><i>{rankLabel}</i>{rk(rank)}</span></span>
      <span className={s.modeRows}>
        {rows.length ? rows.map(([k, v]) => <span key={k}><i>{k}</i><b>{v}</b></span>) : <span><i>Not played</i><b>—</b></span>}
      </span>
    </Link>
  );
}

function CoinMark({ c }: { c: Coin }) {
  // eslint-disable-next-line @next/next/no-img-element
  return c.icon ? <img className={s.coin} src={withBase(c.icon)} alt="" width={28} height={28} /> : <span className={s.coin}>{c.ticker.replace(/^\$/, "")[0]}</span>;
}

function Career({ c }: { c: StatsData["career"] }) {
  const t = (k: string, v: React.ReactNode, sub?: React.ReactNode, wide = false) => (
    <div className={`${s.stat}${wide ? ` ${s.wide}` : ""}`}><span className={s.statK}>{k}</span><b className={s.statV}>{v}</b>{sub != null && <span className={s.statS}>{sub}</span>}</div>
  );
  return (
    <section className={s.sec} aria-labelledby="st-career">
      <div className={s.secHead}><h2 id="st-career" className={s.h2}>Career</h2></div>
      <div className={s.career}>
        {t("Best rocket", c?.bestRocket ? <><CoinMark c={c.bestRocket} />{c.bestRocket.ticker}</> : "—", c?.bestRocket ? <span className={s.up}>{sUsd(c.bestRocket.pnlUsd)}</span> : null, true)}
        {t("Best trade", c?.bestTrade ? <><CoinMark c={c.bestTrade} /><span className={s.up}>+{n0(Math.round(c.bestTrade.pct))}%</span></> : "—", c?.bestTrade ? <>{c.bestTrade.ticker} · <span className={s.up}>{sUsd(c.bestTrade.pnlUsd)}</span></> : null, true)}
        {t("Win rate", c?.winRate != null ? `${Math.round(c.winRate * 100)}%` : "—")}
        {t("Trades", c ? n0(c.trades) : "—")}
        {t("Bombs dropped", c ? n0(c.bombs) : "—")}
        {t("Rockets launched", c ? n0(c.launched) : "—")}
        {t("Longest flight", c?.longestMs ? dur(c.longestMs) : "—")}
        {t("Total XP", c?.totalXp != null ? n0(c.totalXp) : "—")}
      </div>
    </section>
  );
}

function Rewards({ level, got }: { level: StatsData["level"]; got: Map<string, number> | null }) {
  const p: Progress | null = level ? { level: level.level, prestige: level.prestige, trophies: new Set(got?.keys() ?? []) } : null;
  const next = REWARDS.find((r) => !isOpen(r.rule, p)) ?? null;
  return (
    <section className={s.sec} aria-labelledby="st-rewards" data-testid="level-rewards">
      <div className={s.secHead}><h2 id="st-rewards" className={s.h2}>Level rewards</h2><Link href="/profile" className={s.link}>Your rocket</Link></div>
      <div className={s.track}>
        {REWARDS.map((r) => {
          const on = isOpen(r.rule, p);
          return (
            <div key={r.id} className={`${s.rw} ${on ? s.got : r === next ? s.isNext : ""}`} data-testid={`reward-${r.id}`} title={r.name}>
              <span className={s.rwLv}>{whenLabel(r)}</span>
              <span className={s.rwArt}><RewardArt r={r} height={92} /></span>
              <span className={s.rwName}>{r.name}</span>
              {on ? <Icon name="check" size={14} className={s.rwOk} /> : <Icon name="lock" size={13} className={s.rwLock} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Orders({ o }: { o: StatsData["orders"] }) {
  const [tab, setTab] = useState<"daily" | "weekly">("daily");
  const list = o?.[tab] ?? [];
  return (
    <section className={s.sec} aria-labelledby="st-orders" data-testid="missions-panel">
      <div className={s.secHead}>
        <h2 id="st-orders" className={s.h2}>Orders</h2>
        <div className={s.seg} role="tablist" aria-label="Orders">
          <button type="button" role="tab" aria-selected={tab === "daily"} className={tab === "daily" ? s.segOn : ""} onClick={() => setTab("daily")}>Today</button>
          <button type="button" role="tab" aria-selected={tab === "weekly"} className={tab === "weekly" ? s.segOn : ""} onClick={() => setTab("weekly")}>Week</button>
        </div>
      </div>
      <ul className={s.orders}>
        {list.map((m) => {
          const pct = m.target ? Math.min(100, (m.progress / m.target) * 100) : 0, u = missionById(m.id)?.kind === "boost_usd" ? "$" : "";
          return (
            <li key={m.id} className={m.done ? s.done : ""} data-testid={`mission-${m.id}`}>
              <span className={s.oT}>{m.title}</span>
              <span className={s.oX}>{m.done ? <Icon name="check" size={13} /> : `${u}${n0(Math.floor(m.progress))}/${u}${n0(m.target)}`}</span>
              <span className={s.xpc}>+{n0(m.xp)} XP</span>
              <span className={s.oBar}><i style={{ width: `${pct}%` }} /></span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
