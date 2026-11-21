"use client";
/**
 * /turbo/watch: spectate live Trading Duels (2026-11-21). Phone first; the app loads the same page.
 *   list   the online duels on right now (GET /api/duel/live, every 3 s while the tab is visible), tap one to watch
 *   ?id=   one duel, read-only: followRoom (SSE + polling, the same feed the pilots get), both pilots' profit live at the
 *          server's price, the price line with every trade on it, the trade + chat feed, then the result with
 *          "Duel <winner>" (/vs/<pilot>) and the next live duel
 * Royale has no shared server match yet (the bots run in each player's browser), so there is nothing to watch there.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { duelApi, followRoom } from "@/lib/duel/client";
import { TIERS, fuelOf, profitOf } from "@/lib/duel/rules";
import type { DuelEvent, DuelRoom } from "@/lib/duel/types";
import type { LiveDuel } from "@/lib/server/duel/store";
import { BOT_DUEL_HREF, DUEL_HREF } from "@/lib/features";
import { onWallet } from "@/lib/walletState";
import s from "./watch.module.css";

const TONE = ["#FF9CC4", "#8FE3FF"] as const;
const money = (v: number) => `${v < -0.004 ? "-" : v > 0.004 ? "+" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tone = (v: number) => (v > 0.004 ? s.up : v < -0.004 ? s.down : "");
const clock = (ms: number) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
const sideTx = (side: number) => (side > 0 ? "LONG" : side < 0 ? "SHORT" : "FLAT");
const tierTx = (tier: keyof typeof TIERS, fuel: number) => (fuel === TIERS[tier].fuel ? TIERS[tier].label : `$${fuel.toLocaleString("en-US")}`);

/** a ticking now, corrected by the server's clock */
function useNow(skew: number, ms = 250) {
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => { const id = setInterval(() => setNow(Date.now() + skew), ms); return () => clearInterval(id); }, [skew, ms]);
  return now;
}

/** left vs right lead, 0..1 (0.5 = level) */
const lead = (a: number, b: number, fuel: number) => Math.max(0.04, Math.min(0.96, 0.5 + (a - b) / Math.max(1, fuel) * 2));

function Tug({ a, b, fuel }: { a: number; b: number; fuel: number }) {
  return <div className={s.tug} aria-hidden><i style={{ width: `${Math.round(lead(a, b, fuel) * 100)}%` }} /></div>;
}

/* ── list ─────────────────────────────────────────────────────────────────────────────────────────────────────────── */

function LiveCard({ d, now }: { d: LiveDuel; now: number }) {
  const [a, b] = d.players;
  return (
    <Link href={`/turbo/watch?id=${d.id}`} prefetch={false} className={s.card} data-testid="watch-card">
      <div className={s.cardTop}>
        <span className={s.live}><i aria-hidden />LIVE</span>
        <span className={s.chip}>{tierTx(d.tier, d.fuel)}</span>
        {d.mode === "ranked" && <span className={s.chip}>Ranked</span>}
        {d.ot && <span className={`${s.chip} ${s.ot}`}>OT</span>}
        <b className={s.cardClock} suppressHydrationWarning>{now < d.startAt ? "3·2·1" : clock(d.endAt - now)}</b>
      </div>
      <div className={s.vs}>
        {[a, b].map((p, i) => (
          <div key={p.pid} className={`${s.side} ${i ? s.right : ""}`}>
            <b className={s.pname} style={{ color: TONE[i] }}>{p.name}</b>
            <span className={`${s.pnl} ${tone(p.profit)}`}>{money(p.profit)}</span>
            <span className={s.pos}>{sideTx(p.side)}</span>
          </div>
        ))}
      </div>
      <Tug a={a.profit} b={b.profit} fuel={d.fuel} />
    </Link>
  );
}

function WatchList() {
  const [duels, setDuels] = useState<LiveDuel[] | null>(null);
  const [skew, setSkew] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const now = useNow(skew, 1000);
  useEffect(() => {
    let alive = true, t: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      if (document.visibilityState === "visible") {
        const r = await duelApi.live();
        if (!alive) return;
        if (r.ok) { setDuels(r.duels); setSkew(r.now - Date.now()); setErr(null); } else { setErr(r.reason); setDuels((d) => d ?? []); }
      }
      t = setTimeout(load, 3000);
    };
    void load();
    return () => { alive = false; if (t) clearTimeout(t); };
  }, []);
  return (
    <div className={s.page} data-testid="watch">
      <header className={s.hd}>
        <h1 className={s.h1}>Watch</h1>
        {duels && duels.length > 0 && <span className={s.count}><i aria-hidden />{duels.length} live</span>}
      </header>
      {err && <p className={s.err} role="alert">{err}</p>}
      {!duels ? <div className={s.spin} aria-busy="true" /> : duels.length ? (
        <div className={s.grid}>{duels.map((d) => <LiveCard key={d.id} d={d} now={now} />)}</div>
      ) : (
        <div className={s.empty} data-testid="watch-empty">
          <b>Nothing live</b>
          <Link href={DUEL_HREF} prefetch={false} className={s.btnGold}>Play a duel</Link>
        </div>
      )}
    </div>
  );
}

/* ── one duel ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

type Pt = { t: number; p: number };
type Mark = { t: number; p: number; i: number };
type FeedLine = { seq: number; i: number; text: string; kind: "trade" | "chat" | "bomb" | "sys" };
const CHART_MS = 75_000;

function PriceLine({ pts, marks, now }: { pts: Pt[]; marks: Mark[]; now: number }) {
  const W = 360, H = 120;
  const from = now - CHART_MS;
  const vis = pts.filter((x) => x.t >= from - 5000);
  if (vis.length < 2) return <div className={s.chart} aria-hidden />;
  let lo = Infinity, hi = -Infinity;
  for (const x of vis) { lo = Math.min(lo, x.p); hi = Math.max(hi, x.p); }
  for (const m of marks) if (m.t >= from) { lo = Math.min(lo, m.p); hi = Math.max(hi, m.p); }
  const pad = Math.max((hi - lo) * 0.15, hi * 0.00005);
  lo -= pad; hi += pad;
  const X = (t: number) => ((t - from) / CHART_MS) * W, Y = (p: number) => H - ((p - lo) / (hi - lo)) * H;
  const d = vis.map((x, i) => `${i ? "L" : "M"}${X(x.t).toFixed(1)},${Y(x.p).toFixed(1)}`).join("");
  const last = vis[vis.length - 1];
  return (
    <svg className={s.chart} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`BTC ${last.p.toFixed(2)}`}>
      <path d={d} fill="none" stroke="#E8EAEE" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {marks.filter((m) => m.t >= from).map((m, k) => <circle key={k} cx={X(m.t)} cy={Y(m.p)} r="5" fill={TONE[m.i]} stroke="#0E0F16" strokeWidth="2" />)}
      <circle cx={X(last.t)} cy={Y(last.p)} r="3.5" fill="#F3DFA8" />
    </svg>
  );
}

function WatchDuel({ id }: { id: string }) {
  const router = useRouter();
  const [room, setRoom] = useState<DuelRoom | null>(null);
  const [gone, setGone] = useState(false);
  const [skew, setSkew] = useState(0);
  const [pts, setPts] = useState<Pt[]>([]);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const roomRef = useRef<DuelRoom | null>(null);
  const now = useNow(skew);
  useEffect(() => onWallet((a) => setMe(a ?? null)), []);

  const seatOf = useCallback((pid: string) => Math.max(0, roomRef.current?.players.findIndex((p) => p.pid === pid) ?? 0), []);
  const nameOf = useCallback((pid: string) => roomRef.current?.players.find((p) => p.pid === pid)?.name ?? "pilot", []);
  const addPt = useCallback((p: number, t: number) => setPts((xs) => (xs.length && xs[xs.length - 1].t >= t ? xs : [...xs.slice(-400), { t, p }])), []);

  useEffect(() => {
    setRoom(null); setGone(false); setPts([]); setMarks([]); setFeed([]); setNext(null);
    const onEvent = (e: DuelEvent) => {
      const line = (i: number, text: string, kind: FeedLine["kind"]) => setFeed((f) => [{ seq: e.seq, i, text, kind }, ...f.filter((x) => x.seq !== e.seq)].slice(0, 30));
      if (e.type === "trade") {
        const i = seatOf(e.pid);
        setMarks((m) => [...m.slice(-80), { t: e.ts, p: e.price, i }]); addPt(e.price, e.ts);
        line(i, `${nameOf(e.pid)} ${e.action === "close" ? "cashed out" : e.action === "boost" ? "went LONG" : "went SHORT"}`, "trade");
      } else if (e.type === "bomb") line(seatOf(e.pid), `${nameOf(e.pid)} got NUKED`, "bomb");
      else if (e.type === "chat") line(seatOf(e.pid), `${nameOf(e.pid)}: ${e.text}`, "chat");
      else if (e.type === "overtime") line(-1, "Overtime +30s", "sys");
    };
    const f = followRoom(id, onEvent, (r, serverNow) => {
      roomRef.current = r; setRoom(r); setSkew(serverNow - Date.now());
      if (r.status === "live" && r.mark) addPt(r.mark.p, r.mark.at);
    }, (p, ts) => addPt(p, ts));
    // a room that never loads (bad id, expired) is gone
    const t = setTimeout(() => { if (!roomRef.current) setGone(true); }, 6000);
    return () => { f.stop(); clearTimeout(t); roomRef.current = null; };
  }, [id, seatOf, nameOf, addPt]);

  const done = room?.status === "done" || room?.status === "cancelled";
  // once it's over, line up the next live duel
  useEffect(() => {
    if (!done) return;
    let alive = true;
    void duelApi.live().then((r) => { if (alive && r.ok) setNext(r.duels.find((d) => d.id !== id)?.id ?? null); });
    return () => { alive = false; };
  }, [done, id]);

  const price = pts.length ? pts[pts.length - 1].p : room?.mark?.p ?? null;
  const fuel = room ? fuelOf(room) : 0;
  const profit = useMemo(() => {
    if (!room) return [0, 0];
    if (room.result) return room.players.map((p) => room.result!.profit[p.pid] ?? 0);
    return room.players.map((p) => { const b = room.books[p.pid]; return b ? (price ? profitOf(b, price, fuel) : b.fuel + (b.pos?.coll ?? 0) - fuel) : 0; });
  }, [room, price, fuel]);

  const share = async () => {
    const url = `${location.origin}/turbo/watch?id=${id}${me ? `&ref=${me.toLowerCase()}` : ""}`;
    try { if (navigator.share) { await navigator.share({ url }); return; } } catch { return; }
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* no clipboard */ }
  };

  if (gone && !room) {
    return (
      <div className={s.page}>
        <div className={s.empty} data-testid="watch-gone"><b>That duel is gone</b><Link href="/turbo/watch" prefetch={false} className={s.btnGold}>Live duels</Link></div>
      </div>
    );
  }
  if (!room) return <div className={s.page}><div className={s.spin} aria-busy="true" /></div>;

  const [a, b] = room.players;
  const winner = room.result?.winner ?? null;
  const left = room.startAt && now < room.startAt ? room.startAt - now : (room.endAt ?? now) - now;
  const counting = !!room.startAt && now < room.startAt;
  return (
    <div className={`${s.page} ${s.watching}${done ? ` ${s.done}` : ""}`} data-testid="watch-duel">
      <div className={s.bar}>
        <button type="button" className={s.back} onClick={() => router.push("/turbo/watch")} aria-label="Back">‹</button>
        {room.status === "live" ? <span className={s.live}><i aria-hidden />LIVE</span> : <span className={s.chip}>{done ? "Final" : "Lobby"}</span>}
        <span className={s.chip}>{tierTx(room.tier, fuel)}</span>
        {room.ot && <span className={`${s.chip} ${s.ot}`}>OT</span>}
        <button type="button" className={s.shareBtn} onClick={share} data-testid="watch-share">{copied ? "Copied" : "Share"}</button>
      </div>

      {!done && <div className={s.clockBig} suppressHydrationWarning>{room.status === "live" ? (counting ? Math.ceil(left / 1000) : clock(left)) : ""}</div>}

      <div className={s.vsBig}>
        {[a, b].filter(Boolean).map((p, i) => {
          const pos = room.books[p.pid]?.pos;
          const won = done && winner === p.pid;
          return (
            <div key={p.pid} className={`${s.pilot} ${i ? s.right : ""} ${won ? s.won : ""}`} data-testid={`watch-pilot-${i}`}>
              <b className={s.pname} style={{ color: TONE[i] }}>{p.name}</b>
              <span className={`${s.pnlBig} ${tone(profit[i])}`}>{money(profit[i])}</span>
              <span className={s.pos}>{done ? (won ? "WIN" : winner ? "" : "DRAW") : pos ? `${sideTx(pos.side)} $${pos.coll.toFixed(2)}` : "FLAT"}</span>
            </div>
          );
        })}
      </div>
      {b && <Tug a={profit[0]} b={profit[1]} fuel={fuel} />}

      {(!done || pts.length > 1) && <PriceLine pts={pts} marks={marks} now={done ? (room.endAt ?? now) : now} />}

      {done ? (
        <div className={s.result} data-testid="watch-result">
          <b className={s.resultT}>{winner ? `${room.players.find((p) => p.pid === winner)?.name ?? "pilot"} wins` : room.status === "cancelled" ? "Called off" : "Draw"}</b>
          <div className={s.acts}>
            {winner && <Link href={`/vs/${winner}`} prefetch={false} className={s.btnGold} data-testid="watch-duel-winner">Duel {room.players.find((p) => p.pid === winner)?.name ?? "them"}</Link>}
            {next ? <Link href={`/turbo/watch?id=${next}`} prefetch={false} className={s.btnGhost} data-testid="watch-next">Next duel</Link>
              : <Link href={BOT_DUEL_HREF} prefetch={false} className={s.btnGhost}>Play a duel</Link>}
          </div>
        </div>
      ) : (
        <ul className={s.feed} aria-live="polite" data-testid="watch-feed">
          {feed.map((l) => <li key={l.seq} className={s[l.kind]} style={l.i >= 0 ? { borderColor: TONE[l.i] } : undefined}>{l.text}</li>)}
        </ul>
      )}
    </div>
  );
}

export default function WatchScreen() {
  const q = useSearchParams();
  const id = q.get("id");
  return id && /^[0-9A-Z]{26}$/.test(id) ? <WatchDuel id={id} /> : <WatchList />;
}
