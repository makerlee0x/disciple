"use client";
/**
 * /logbook: Your logbook (main mode hook loop mockup board "1 Rocket logbook", maker signed off 2026-11-13).
 * Every rocket you've flown and what it did after: filter All / Aboard / News, one row per rocket (monogram, name +
 * badge, the news line, boarded / peak, status), Your record and Share a flight on the right. Real fills only
 * (GET /api/logbook); ?wallet=0x… shows another pilot's closed flights. `next dev` + ?sample=1 paints the mockup data.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { onWallet } from "@/lib/wallet";
import { privyAccessToken } from "@/lib/aa/sessionState";
import { devSample } from "@/lib/devSample";
import type { LogEntry, LogRecord } from "@/lib/logbook";
import ShareModal from "@/components/share/ShareModal";
import s from "./logbook.module.css";

type Book = { entries: LogEntry[]; record: LogRecord; total: number; crew: { tag: string; name: string } | null; own: boolean };
type Filter = "all" | "aboard" | "news";

export const LOGBOOK_COPY = {
  title: "Your logbook",
  titleOf: (n: string) => `${n}'s logbook`,
  sub: "Every rocket you've flown, and what it did after.",
  subOf: "Closed flights only. Rockets they're still aboard aren't shown.",
  filters: { all: "All", aboard: "Aboard", news: "News" } as Record<Filter, string>,
  boarded: "Boarded at", peak: "Peak with you", held: "You held through", firstCrew: (n: number) => `First crew, pilot #${n}`,
  stillAboard: "Still aboard", left: (d: string) => `Left after ${d}`, leftRed: "Left in the red", cashedHigher: "Cashed out higher", leftEven: "Left even",
  foot: "Every line comes from your fills and the rocket's fills. Red flights stay in the logbook.",
  record: "Your record", recordOf: "Their record",
  stats: { rockets: "rockets flown", orbits: "orbits aboard", firstCrews: "first crews", bombsHeld: "bombs held through", green: "green flights", red: "red flights" },
  share: { eyebrow: "Share a flight", body: (t: string, z: string, orbit: boolean) => `"Boarded $${t} at the ${titleCase(z)}.${orbit ? " Aboard for orbit." : ""}" The card shows the climb and your crew, not your bag.`, btn: (t: string) => `Share $${t} flight` },
  empty: { title: "No flights yet", body: "Board a rocket and it lands here, with everything it does after you leave.", cta: "Find a rocket" },
  signIn: "Sign in to see your logbook.",
} as const;

export function titleCase(z: string) { return z.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()).replace("Kármán", "Kármán"); }
export function dur(ms: number) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"}`;
  const d = Math.floor(h / 24), r = h % 24;
  return `${d} ${d === 1 ? "day" : "days"}${r ? ` ${r} ${r === 1 ? "hour" : "hours"}` : ""}`;
}
export function ago(ts: number, now = Date.now()) {
  const m = Math.round((now - ts) / 60000);
  if (m < 60) return m <= 1 ? "just now" : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}
const after = (ms: number) => { const d = Math.max(1, Math.round(ms / 86_400_000)); return ms < 86_400_000 ? `${Math.max(1, Math.round(ms / 3_600_000))} hours` : `${d} ${d === 1 ? "day" : "days"}`; };

/** The row's news line (mockup: "Reached orbit with you aboard, 2 hours ago"). */
export function newsLine(e: LogEntry, crewTag?: string | null): string {
  const n = e.news;
  if (n?.kind === "orbit_aboard") return `Reached orbit with you aboard, ${ago(n.at)}`;
  if (n?.kind === "orbit_after") return `Reached orbit ${after(n.at - (e.leftAt ?? n.at))} after you left`;
  if (n?.kind === "zone_after") return `Crossed the ${titleCase(n.zone ?? "")} ${after(n.at - (e.leftAt ?? n.at))} after you left`;
  if (n?.kind === "crew_aboard") return `Your crew${crewTag ? ` [${crewTag}]` : ""} has ${n.crew} ${n.crew === 1 ? "pilot" : "pilots"} aboard`;
  if (e.status === "aboard") return `In the ${titleCase(e.nowZone)} now`;
  return e.nowZone === "LAUNCH PAD" ? `Back at the Launch Pad. Quiet since ${new Date(e.lastAt).toLocaleDateString("en-US", { weekday: "long" })}.` : `In the ${titleCase(e.nowZone)} now`;
}

function Badge({ e }: { e: LogEntry }) {
  if (e.graduated && e.orbitAboard) return <span className={`${s.badge} ${s.bOrbit}`}>IN ORBIT</span>;
  if (e.news && e.news.kind !== "crew_aboard") return <span className={`${s.badge} ${s.bNews}`}>NEWS</span>;
  if (e.status === "aboard") return <span className={`${s.badge} ${s.bAboard}`}>ABOARD</span>;
  return null;
}

function Row({ e, crewTag, href }: { e: LogEntry; crewTag: string | null; href: string }) {
  const c = LOGBOOK_COPY;
  const dim = e.status !== "aboard" && !e.news;
  const second = e.bombsHeld > 0 && e.status !== "aboard" ? <>{c.held} <b>{e.bombsHeld} {e.bombsHeld === 1 ? "bomb" : "bombs"}</b></>
    : e.firstCrew && e.status === "aboard" && !e.orbitAboard ? <>{c.firstCrew(e.pilotNo)}</>
    : <>{c.peak} <b>{titleCase(e.peakZone)}</b></>;
  const right = e.status === "aboard" ? <span className={s.up}>{c.stillAboard}<br /><span className={s.dim}>{dur(e.aboardMs)}</span></span>
    : e.status === "red" ? <span className={s.down}>{c.leftRed}<br /><span className={s.dim}>after {dur(e.aboardMs)}</span></span>
    : <span className={s.dim}>{c.left(dur(e.aboardMs))}<br />{e.status === "green" ? c.cashedHigher : c.leftEven}</span>;
  return (
    <Link href={href} className={`${s.row}${e.orbitAboard ? " " + s.rowGold : ""}`} data-testid="logbook-row">
      <span className={`${s.mono}${dim ? " " + s.monoDim : ""}`} aria-hidden>{e.ticker.slice(0, 4).toUpperCase()}</span>
      <span className={s.main}>
        <span className={s.nameRow}><b className={`${s.name}${dim ? " " + s.nameDim : ""}`}>${e.ticker} · {e.name}</b><Badge e={e} /></span>
        <span className={`${s.news}${e.orbitAboard ? " " + s.newsGold : dim ? " " + s.newsDim : ""}`}>{newsLine(e, crewTag)}</span>
      </span>
      <span className={s.facts}>{c.boarded} <b>{titleCase(e.boardedZone)}</b><br />{second}</span>
      <span className={s.status}>{right}</span>
    </Link>
  );
}

export default function LogbookView() {
  const [me, setMe] = useState<string | null>(null);
  const [{ other, name, ready }, setQ] = useState<{ other: string | null; name: string | null; ready: boolean }>({ other: null, name: null, ready: false });
  useEffect(() => { const q = new URLSearchParams(location.search), w = q.get("wallet"); setQ({ other: w && /^0x[0-9a-fA-F]{40}$/.test(w) ? w.toLowerCase() : null, name: q.get("name")?.slice(0, 32) ?? null, ready: true }); }, []);
  const [book, setBook] = useState<Book | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [share, setShare] = useState<LogEntry | null>(null);
  const sample = process.env.NODE_ENV === "development" && devSample();
  useEffect(() => onWallet((a) => setMe(a ?? null)), []);
  const wallet = (other || me || "").toLowerCase();

  useEffect(() => {
    if (sample) { import("@/lib/mock/hookLoop").then((m) => setBook(m.sampleLogbook())); return; }
    if (!wallet || !ready) return;
    let alive = true;
    (async () => {
      const token = !other ? await privyAccessToken().catch(() => null) : null;
      const r = await fetch(`/api/logbook?wallet=${wallet}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, cache: "no-store" }).catch(() => null);
      const d = r && r.ok ? ((await r.json()) as Book) : null;
      if (!alive) return;
      if (d) setBook(d); else setFailed(true);
    })();
    return () => { alive = false; };
  }, [wallet, other, sample, ready]);

  const entries = useMemo(() => {
    const all = book?.entries ?? [];
    return filter === "aboard" ? all.filter((e) => e.status === "aboard") : filter === "news" ? all.filter((e) => e.news && e.news.kind !== "crew_aboard") : all;
  }, [book, filter]);
  const counts: Record<Filter, number> = { all: book?.total ?? 0, aboard: book?.record.aboard ?? 0, news: book?.record.news ?? 0 };
  const own = !other && (book?.own ?? true);
  const c = LOGBOOK_COPY;
  const shareable = book?.entries.find((e) => e.orbitAboard) ?? book?.entries.find((e) => e.status === "aboard") ?? book?.entries[0] ?? null;
  const hrefOf = (e: LogEntry) => `/logbook/${e.coin}${other ? `?wallet=${other}` : sample ? "?sample=1" : ""}`;
  const r = book?.record;

  return (
    <div className={s.page} data-testid="logbook">
      <div className={s.cols}>
        <div className={s.left}>
          <div className={s.head}>
            <div>
              <h1 className={s.h1}>{other ? c.titleOf(name || `${other.slice(0, 6)}…`) : c.title}</h1>
              <p className={s.sub}>{other ? c.subOf : c.sub}</p>
            </div>
            <div className={s.filters} role="tablist" aria-label="Show">
              {(["all", "aboard", "news"] as Filter[]).filter((f) => own || f !== "aboard").map((f) => (
                <button key={f} type="button" role="tab" aria-selected={filter === f} className={`${s.filter}${filter === f ? " " + s.on : ""}`} onClick={() => setFilter(f)}>{c.filters[f]} {counts[f]}</button>
              ))}
            </div>
          </div>
          {!wallet && !sample ? <p className={s.empty}>{c.signIn}</p>
            : !book ? (failed ? <p className={s.empty}>Couldn&apos;t load the logbook. Try again in a moment.</p> : <div className={s.loading} aria-busy="true" />)
            : book.entries.length === 0 ? (
              <div className={s.emptyCard}><b>{c.empty.title}</b><span>{c.empty.body}</span><Link href="/" className={s.gold}>{c.empty.cta}</Link></div>
            ) : (
              <div className={s.list}>{entries.map((e) => <Row key={e.coin} e={e} crewTag={book.crew?.tag ?? null} href={hrefOf(e)} />)}</div>
            )}
          <p className={s.foot}>{c.foot}</p>
        </div>
        <aside className={s.side}>
          <section className={s.card}>
            <span className={s.eb}>{own ? c.record : c.recordOf}</span>
            <div className={s.stats}>
              <div><b>{r?.rockets ?? 0}</b><span>{c.stats.rockets}</span></div>
              <div><b className={s.goldTxt}>{r?.orbits ?? 0}</b><span>{c.stats.orbits}</span></div>
              <div><b>{r?.firstCrews ?? 0}</b><span>{c.stats.firstCrews}</span></div>
              <div><b>{r?.bombsHeld ?? 0}</b><span>{c.stats.bombsHeld}</span></div>
              <div><b className={s.up}>{r?.green ?? 0}</b><span>{c.stats.green}</span></div>
              <div><b className={s.down}>{r?.red ?? 0}</b><span>{c.stats.red}</span></div>
            </div>
          </section>
          {own && (
            <Link href={sample ? "/streaks?sample=1" : "/streaks"} className={`${s.card} ${s.linkCard}`}>
              <span className={s.eb}>Streaks</span><span className={s.linkTxt}>Aboard and check-in days, with a weekly shield</span>
            </Link>
          )}
          {own && shareable && (
            <section className={`${s.card} ${s.shareCard}`}>
              <span className={`${s.eb} ${s.goldTxt}`}>{c.share.eyebrow}</span>
              <p>{c.share.body(shareable.ticker, shareable.boardedZone, shareable.orbitAboard)}</p>
              <button type="button" className={s.gold} onClick={() => setShare(shareable)}>{c.share.btn(shareable.ticker)}</button>
            </section>
          )}
        </aside>
      </div>
      {share && <ShareModal target={{ coin: share.coin, ticker: share.ticker, wallet: wallet || null, username: null, sample }} onClose={() => setShare(null)} />}
    </div>
  );
}
