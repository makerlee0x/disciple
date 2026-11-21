"use client";
/**
 * The Turbo page (/turbo, public at /u/<name>/turbo), maker 2026-11-20: the Turbo tab is a page now, not a Duel / Climb menu.
 * A pilot's trading dashboard: who, Turbo cash (own only), realized PnL 24H / 7D / 30D / all time, the duel record,
 * Climb, recent duels (who they played, who won) and real Turbo fills. Duel and Climb start from here.
 * A pilot with no Turbo history gets the play cards big and nothing else to read.
 * Pure view: every number comes in on `d`.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { withBase } from "@/lib/base-path";
import { leagueBy } from "@/lib/duel/season";
import { PNL_PERIODS, type TurboFill, type TurboMatch, type TurboProfile } from "@/lib/turbo/profile";
import Icon from "@/components/icons/Icon";
import s from "./turbo-page.module.css";

/** go: the card's button word (default "Play") */
export type TurboModeCard = { id: string; title: string; tag: string; art: string; href: string; tone: string; go?: string };
export type TurboData = {
  /** signed out: the play cards only */
  anon?: boolean;
  own: boolean;
  name: string;
  handle: string | null;
  pfp: string;
  /** own page only: the Turbo cash balance (null while it reads) */
  balance: number | null;
  p: TurboProfile | null;
  modes: readonly TurboModeCard[];
  /** where the "@name" links to for an opponent */
  pilotHref: (name: string, wallet: string) => string;
};

const n0 = (n: number) => n.toLocaleString("en-US");
const usd = (n: number, dp = 2) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const sUsd = (n: number) => `${n > 0 ? "+" : ""}${usd(n)}`;
const tone = (n: number | null | undefined) => (n == null || Math.abs(n) < 0.005 ? "" : n > 0 ? s.up : s.down);
const rk = (r: number | null | undefined) => (r ? `#${n0(r)}` : "—");
const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
function ago(at: number, now = Date.now()) {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
const clock = (ms: number) => { const t = Math.round(ms / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
const num = (n: number) => (n >= 1000 ? n0(Math.round(n)) : n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toLocaleString("en-US", { maximumSignificantDigits: 4 }));

export default function TurboView({ d, onAdd, onWithdraw }: { d: TurboData; onAdd?: () => void; onWithdraw?: () => void }) {
  const p = d.p;
  const fresh = !!p && !p.matches.length && !p.fills.length && !(p.duel?.games) && !p.climb;
  return (
    <div className={s.page} data-testid="turbo-page">
      {!d.anon && <Hero d={d} fresh={fresh} onAdd={onAdd} onWithdraw={onWithdraw} />}
      <Play modes={d.modes} big={fresh || !p} />
      {p && !fresh && (
        <div className={s.grid}>
          <aside className={s.side}>
            <Record p={p} />
            <Climb p={p} href={d.modes.find((m) => m.id === "climb")?.href} />
            <Trading p={p} />
          </aside>
          <div className={s.main}>
            <Matches list={p.matches} pilotHref={d.pilotHref} />
            <Fills list={p.fills} missing={p.fillsMissing} />
          </div>
        </div>
      )}
    </div>
  );
}

function Face({ name, pfp, big }: { name: string; pfp: string; big?: boolean }) {
  return (
    <span className={big ? s.face : s.av}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {pfp ? <img className="pfp-img" src={withBase(pfp)} alt="" /> : <span>{(name.replace(/^@/, "")[0] ?? "?").toUpperCase()}</span>}
    </span>
  );
}

function Hero({ d, fresh, onAdd, onWithdraw }: { d: TurboData; fresh: boolean; onAdd?: () => void; onWithdraw?: () => void }) {
  const p = d.p;
  const lg = p?.duel?.league ? leagueBy(p.duel.league) : null;
  return (
    <section className={s.hero} aria-label="Pilot" data-testid="turbo-hero">
      <div className={s.heroSky} aria-hidden />
      <div className={s.heroShade} aria-hidden />
      <div className={s.heroTop}>
        <div className={s.heroId}>
          <Face name={d.name} pfp={d.pfp} big />
          <div className={s.idTx}>
            <h1 className={s.name}>{d.name}</h1>
            <div className={s.chips}>
              {d.handle && <span className={s.handle}>{d.handle}</span>}
              {lg && <span className={s.tier} style={{ ["--tc" as string]: lg.color }}><Icon name="achievement" size={13} />{lg.name}</span>}
              {p?.duel?.games ? <span className={s.chip}>{n0(p.duel.w)}W {n0(p.duel.l)}L</span> : null}
            </div>
          </div>
        </div>
        {d.own && (
          <div className={s.cash} data-testid="turbo-page-cash">
            <span className={s.cashK}><Icon name="bolt" size={14} />Turbo cash</span>
            <b className={s.cashV}>{d.balance == null ? "—" : usd(d.balance)}</b>
            <span className={s.cashBtns}>
              {onAdd && <button type="button" className={s.btnGold} onClick={onAdd}>Add</button>}
              {onWithdraw && <button type="button" className={s.btnGhost} onClick={onWithdraw}>Withdraw</button>}
            </span>
          </div>
        )}
      </div>
      {!fresh && p && (
        <div className={s.pnl} data-testid="turbo-pnl">
          {PNL_PERIODS.map(({ k, label }) => {
            const v = p.pnl?.[k] ?? null;
            return (
              <div key={k} className={k === "all" ? s.pnlAll : undefined}>
                <span>{label}</span>
                <b className={tone(v)}>{v == null ? "—" : sUsd(v)}</b>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Play({ modes, big }: { modes: readonly TurboModeCard[]; big: boolean }) {
  return (
    <section className={`${s.play}${big ? ` ${s.playBig}` : ""}`} aria-label="Play" data-testid="turbo-play">
      {modes.map((m) => (
        <Link key={m.id} href={m.href} prefetch={false} className={s.modeCard} style={{ ["--tone" as string]: m.tone }} data-testid={`turbo-play-${m.id}`}>
          <span className={s.modeArt} style={{ backgroundImage: `url(${withBase(m.art)})` }} aria-hidden />
          <span className={s.modeShade} aria-hidden />
          <span className={s.modeTx}>
            <span className={s.modeTag}>{m.tag}</span>
            <span className={s.modeT}>{m.title}</span>
          </span>
          <span className={s.modeGo}>{m.go ?? "Play"}<Icon name="chevron-right" size={16} /></span>
        </Link>
      ))}
    </section>
  );
}

function Ring({ w, l }: { w: number; l: number }) {
  const g = w + l, r = 42, c = 2 * Math.PI * r, f = g ? w / g : 0;
  return (
    <svg className={s.ring} viewBox="0 0 100 100" aria-hidden>
      <circle cx="50" cy="50" r={r} className={s.ringL} />
      {g > 0 && <circle cx="50" cy="50" r={r} className={s.ringW} strokeDasharray={`${c * f} ${c}`} transform="rotate(-90 50 50)" />}
      <text x="50" y="50" className={s.ringTx}>{g ? `${Math.round(f * 100)}%` : "—"}</text>
    </svg>
  );
}

function Card({ title, right, children, testId }: { title: string; right?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <section className={s.card} data-testid={testId}>
      <div className={s.cardHead}><h2 className={s.h3}>{title}</h2>{right}</div>
      {children}
    </section>
  );
}

function Record({ p }: { p: TurboProfile }) {
  const dl = p.duel;
  return (
    <Card title="Duel" right={<span className={s.tag}>{rk(dl?.rank)}</span>} testId="turbo-record">
      <div className={s.rec}>
        <Ring w={dl?.w ?? 0} l={dl?.l ?? 0} />
        <div className={s.recTx}>
          <b>{dl ? <><span className={s.up}>{n0(dl.w)}W</span> <span className={s.down}>{n0(dl.l)}L</span></> : "—"}</b>
          <span>{dl ? `${n0(dl.games)} played` : "Not played"}</span>
        </div>
      </div>
      <dl className={s.kv}>
        <div><dt>Streak</dt><dd>{dl ? n0(dl.streak) : "—"}</dd></div>
        <div><dt>Season points</dt><dd>{dl?.sp != null ? n0(dl.sp) : "—"}</dd></div>
      </dl>
    </Card>
  );
}

function Climb({ p, href }: { p: TurboProfile; href?: string }) {
  return (
    <Card title="Climb" right={<span className={s.tag}>{rk(p.climb?.rank)}</span>} testId="turbo-climb">
      <dl className={s.kv}>
        <div><dt>Best level</dt><dd>{p.climb ? n0(p.climb.level) : "—"}</dd></div>
      </dl>
      {!p.climb && href && <Link href={href} prefetch={false} className={s.link}>Play Climb</Link>}
    </Card>
  );
}

function Trading({ p }: { p: TurboProfile }) {
  const t = p.trading;
  return (
    <Card title="Trading" testId="turbo-trading">
      <dl className={s.kv}>
        <div><dt>Fills</dt><dd>{t ? n0(t.fills) : "—"}</dd></div>
        <div><dt>Volume</dt><dd>{t ? usd(t.volume, 0) : "—"}</dd></div>
        <div><dt>Green closes</dt><dd>{pct(t?.winRate)}</dd></div>
        <div><dt>Fees paid</dt><dd>{t ? usd(t.fees) : "—"}</dd></div>
      </dl>
    </Card>
  );
}

const MODE_TAG: Record<TurboMatch["mode"], string> = { ranked: "Ranked", casual: "Unranked", friend: "Friend" };
const RES: Record<TurboMatch["result"], string> = { win: "Win", loss: "Loss", draw: "Draw" };

function Matches({ list, pilotHref }: { list: TurboMatch[]; pilotHref: TurboData["pilotHref"] }) {
  const [f, setF] = useState<"all" | "ranked" | "casual">("all");
  const shown = useMemo(() => list.filter((m) => f === "all" || m.mode === f || (f === "casual" && m.mode === "friend")), [list, f]);
  const w = list.filter((m) => m.result === "win").length, l = list.filter((m) => m.result === "loss").length;
  return (
    <section className={s.sec} aria-labelledby="tp-duels" data-testid="turbo-matches">
      <div className={s.secHead}>
        <div className={s.secTitle}><h2 id="tp-duels" className={s.h2}>Recent duels</h2>{list.length > 0 && <span className={s.tag}>{list.length}G {w}W {l}L</span>}</div>
        <div className={s.seg} role="tablist" aria-label="Show duels">
          {(["all", "ranked", "casual"] as const).map((k) => <button key={k} type="button" role="tab" aria-selected={f === k} className={f === k ? s.segOn : ""} onClick={() => setF(k)}>{k === "casual" ? "Unranked" : k}</button>)}
        </div>
      </div>
      {shown.length ? (
        <ul className={s.matches}>
          {shown.map((m) => (
            <li key={m.id} className={`${s.match} ${s[m.result]}`} data-testid="turbo-match">
              <div className={s.mWhen}>
                <b>{RES[m.result]}</b>
                <span className={s.mMode}>{MODE_TAG[m.mode]}</span>
                <span className={s.mAgo}>{ago(m.at)} · {clock(m.lenMs)}</span>
              </div>
              <div className={s.mScore}>
                <span className={s.mVs}>
                  <span><i>You</i><b className={tone(m.me)}>{sUsd(m.me)}</b></span>
                  <span><i>Them</i><b className={tone(m.them)}>{sUsd(m.them)}</b></span>
                </span>
              </div>
              <div className={s.mChips}>
                <span className={s.chip}>{m.tier}</span>
                {m.real ? <span className={`${s.chip} ${s.chipReal}`}>Real</span> : <span className={s.chip}>Sim</span>}
                {m.delta !== 0 && <span className={`${s.delta} ${m.delta > 0 ? s.up : s.down}`}>{m.delta > 0 ? "▲" : "▼"}{Math.abs(m.delta)}</span>}
              </div>
              <Link href={pilotHref(m.opp.name, m.opp.wallet)} prefetch={false} className={s.mOpp}>
                <Face name={m.opp.name} pfp={m.opp.pfp} />
                <span>{m.opp.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : <div className={s.empty}>No duels</div>}
    </section>
  );
}

function Fills({ list, missing }: { list: TurboFill[]; missing: boolean }) {
  return (
    <section className={s.sec} aria-labelledby="tp-fills" data-testid="turbo-fills">
      <div className={s.secHead}><div className={s.secTitle}><h2 id="tp-fills" className={s.h2}>Trades</h2><span className={s.tag}>Real money</span></div></div>
      {list.length ? (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead><tr><th>Market</th><th>Side</th><th className={`${s.r} ${s.wideOnly}`}>Size</th><th className={s.r}>Price</th><th className={s.r}>PnL</th><th className={`${s.r} ${s.wideOnly}`}>Fee</th><th className={s.r}>Time</th></tr></thead>
            <tbody>
              {list.map((f, i) => (
                <tr key={`${f.at}-${i}`}>
                  <td className={s.mkt}>{f.market}{f.liq && <span className={`${s.chip} ${s.chipLiq}`}>Liq</span>}</td>
                  <td className={f.side === "buy" ? s.up : s.down}>{f.side === "buy" ? "Buy" : "Sell"}</td>
                  <td className={`${s.r} ${s.wideOnly}`}>{num(f.size)}</td>
                  <td className={s.r}>{usd(f.price, f.price >= 100 ? 2 : 4)}</td>
                  <td className={`${s.r} ${tone(f.pnl)}`}>{f.pnl == null || f.pnl === 0 ? "—" : sUsd(f.pnl)}</td>
                  <td className={`${s.r} ${s.dim} ${s.wideOnly}`}>{f.fee == null ? "—" : usd(f.fee, 4)}</td>
                  <td className={`${s.r} ${s.dim}`}>{ago(f.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className={s.empty}>{missing ? "Trades didn't load" : "No trades"}</div>}
    </section>
  );
}
