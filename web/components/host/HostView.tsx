"use client";
/**
 * /host?coin= (main mode hook loop mockup board "Host mission control", maker 2026-11-13): passengers aboard, crews
 * aboard, the top-10 share and host earnings; passengers since launch with milestone dots; milestone chips; the host log
 * card (Share on X, Save image) and the host's rockets. Counts people and zones, never price targets.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { onWallet } from "@/lib/wallet";
import { devSample } from "@/lib/devSample";
import { difficultyOf } from "@/lib/difficulty";
import { headlineMark, hostLogLine, type HostView as Host } from "@/lib/host";
import s from "./host.module.css";

const W = 640, Hh = 240, BASE = 210, TOP = 30;
const launched = (ts: number) => new Date(ts).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
const wd = (ts: number) => new Date(ts).toLocaleDateString("en-US", { weekday: "short" });

export const HOST_VIEW_COPY = {
  youHost: "Mission control · you host this rocket",
  hostedBy: (n: string) => `Mission control · hosted by ${n}`,
  rule: "Cards count people and zones, never price targets. Your own buys and sells on this rocket never count toward Top pilots.",
  share: (h: Host) => `$${h.ticker} has ${headlineMark(h.passengers)} passengers aboard. ${hostLogLine({ passengers: h.passengers, crews: h.crews, zone: h.zone, day: h.day })}.`,
} as const;

function Chart({ h }: { h: Host }) {
  const pts = h.series, max = Math.max(1, ...pts.map((p) => p.n)), t0 = pts[0]?.at ?? 0, t1 = pts[pts.length - 1]?.at ?? 1;
  const x = (at: number) => ((at - t0) / Math.max(1, t1 - t0)) * W, y = (n: number) => BASE - (n / max) * (BASE - TOP);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)} ${y(p.n).toFixed(1)}`).join(" ");
  const nAt = (at: number) => { let n = 0; for (const p of pts) if (p.at <= at) n = p.n; return n; };
  const dots = h.milestones.filter((m) => m.at !== null && (m.kind === "crew" || (m.kind === "passengers" && m.key !== "p10"))).slice(-3);
  const mid = t0 + (t1 - t0) / 2;
  return (
    <svg width="100%" height={Hh} viewBox={`0 0 ${W} ${Hh}`} role="img" aria-label={`Passengers aboard since launch, now ${h.passengers}, peak ${h.peak}`} className={s.chart}>
      <line x1="0" y1={BASE} x2={W} y2={BASE} stroke="#2E323A" />
      <path d={d} fill="none" stroke="#44D4E2" strokeWidth="3" strokeLinejoin="round" />
      {dots.map((m) => {
        const cx = x(m.at!), cy = y(nAt(m.at!)), right = cx > W - 140;
        return <g key={m.key}><circle cx={cx} cy={cy} r="5" fill="#F2C14E" /><text x={right ? cx - 8 : cx + 8} y={cy - 8} textAnchor={right ? "end" : "start"} fill="#F3DFA8" fontFamily="var(--dsc-font-ui)" fontSize="12">{m.label}</text></g>;
      })}
      <text x="0" y="230" fill="#9EA3B5" fontFamily="var(--dsc-font-ui)" fontSize="12">{wd(t0)}</text>
      {t1 - t0 > 86_400_000 && <text x={W / 2} y="230" textAnchor="middle" fill="#9EA3B5" fontFamily="var(--dsc-font-ui)" fontSize="12">{wd(mid)}</text>}
      <text x={W} y="230" textAnchor="end" fill="#9EA3B5" fontFamily="var(--dsc-font-ui)" fontSize="12">Now</text>
    </svg>
  );
}

/** the host log card as a PNG (Save image): drawn on a canvas so nothing leaves the page */
async function saveImage(h: Host) {
  const c = document.createElement("canvas"), k = 2, w = 720, ht = 400;
  c.width = w * k; c.height = ht * k;
  const g = c.getContext("2d"); if (!g) return;
  g.scale(k, k);
  const bg = g.createLinearGradient(0, 0, 0, ht); bg.addColorStop(0, "#3D4A79"); bg.addColorStop(1, "#202141");
  g.fillStyle = bg; g.fillRect(0, 0, w, ht);
  await document.fonts?.ready;
  const font = (wt: number, px: number, fam: string) => `${wt} ${px}px ${getComputedStyle(document.body).getPropertyValue(fam).trim() || "sans-serif"}`;
  g.fillStyle = "#F3DFA8"; g.font = font(500, 20, "--dsc-font-mono"); g.fillText(`HOST LOG · $${h.ticker}`, 40, 60);
  g.fillStyle = "#FFF6DC"; g.font = font(800, 96, "--dsc-font-game"); g.fillText(`${headlineMark(h.passengers)} PASSENGERS`, 40, 300);
  g.fillStyle = "#D7D9E4"; g.font = font(400, 24, "--dsc-font-ui"); g.fillText(hostLogLine({ passengers: h.passengers, crews: h.crews, zone: h.zone, day: h.day }), 40, 345);
  g.fillStyle = "#9EA3B5"; g.font = font(500, 18, "--dsc-font-mono"); g.fillText("disciple.vip", w - 150, 60);
  const a = document.createElement("a"); a.href = c.toDataURL("image/png"); a.download = `host-log-${h.ticker.toLowerCase()}.png`; a.click();
}

export default function HostView() {
  const [coin, setCoin] = useState<string | null | undefined>(undefined);
  const [me, setMe] = useState<string | null>(null);
  const [h, setH] = useState<Host | null>(null);
  const [missing, setMissing] = useState(false);
  const sample = process.env.NODE_ENV === "development" && devSample();
  useEffect(() => { const c = new URLSearchParams(location.search).get("coin"); setCoin(c && /^0x[0-9a-fA-F]{40}$/.test(c) ? c.toLowerCase() : null); return onWallet((a) => setMe(a ? a.toLowerCase() : null)); }, []);
  useEffect(() => {
    if (sample) { import("@/lib/mock/hookLoop").then((m) => setH(m.sampleHost())); return; }
    if (coin === undefined) return;
    if (!coin) { setMissing(true); return; }
    let alive = true;
    fetch(`/api/host?coin=${coin}`).then(async (r) => { if (!alive) return; if (r.ok) setH((await r.json()) as Host); else setMissing(true); }).catch(() => alive && setMissing(true));
    return () => { alive = false; };
  }, [coin, sample]);

  if (!h) return <div className={s.page}>{missing ? <p className={s.sub}>That rocket isn&apos;t in the lobby.</p> : <div className={s.loading} aria-busy="true" />}</div>;
  const mine = sample || (!!me && me === h.creator);
  const host = h.hostName ? `@${h.hostName}` : `${h.creator.slice(0, 6)}…`;
  const mode = difficultyOf(h.mode ?? null)?.label;
  const xHref = `https://x.com/intent/post?text=${encodeURIComponent(HOST_VIEW_COPY.share(h))}&url=${encodeURIComponent(`https://disciple.vip/coin/${h.coin}`)}`;
  return (
    <div className={s.page} data-testid="host">
      <div className={s.head}>
        <div>
          <div className={s.eb}>{mine ? HOST_VIEW_COPY.youHost : HOST_VIEW_COPY.hostedBy(host)}</div>
          <h1 className={s.h1}>${h.ticker} · {h.name}</h1>
          <div className={s.sub}>{["Launched " + launched(h.launchedAt), mode].filter(Boolean).join(" · ")}</div>
        </div>
        <div className={s.now}><div className={s.eb}>Now in</div><div className={s.zone}>{h.graduated ? "IN ORBIT" : h.zone}</div>{h.toOrbitUsd !== null && <div className={s.sub}>${h.toOrbitUsd.toLocaleString("en-US")} to orbit</div>}</div>
      </div>
      <div className={s.stats}>
        <div className={s.stat}><b>{h.passengers}</b><span>passengers aboard now</span></div>
        <div className={s.stat}><b>{h.crews}</b><span>crews aboard</span></div>
        <div className={s.stat}><b>{h.top10Pct === null ? "—" : `${Math.round(h.top10Pct)}%`}</b><span>held by the top 10</span></div>
        {mine ? <Link href="/creator" className={`${s.stat} ${s.statLink}`}><b className={s.gold}>Earnings</b><span>creator fees, in Host earnings</span></Link>
          : <div className={s.stat}><b>{h.peak}</b><span>most passengers at once</span></div>}
      </div>
      <div className={s.cols}>
        <section className={s.panel}>
          <div className={s.eb}>Passengers aboard, since launch</div>
          <Chart h={h} />
          <div className={s.eb}>Milestones</div>
          <div className={s.chips}>{h.milestones.map((m) => <span key={m.key} className={m.at !== null ? s.chipOn : s.chipOff}>{m.label}</span>)}</div>
        </section>
        <aside className={s.side}>
          {mine && (
            <div className={s.logCard}>
              <div className={s.logArt}>
                <div className={`${s.eb} ${s.goldTxt}`}>Host log · ${h.ticker}</div>
                <div><div className={s.logBig}>{headlineMark(h.passengers)} passengers</div><div className={s.logLine}>{hostLogLine({ passengers: h.passengers, crews: h.crews, zone: h.zone, day: h.day })}</div></div>
              </div>
              <div className={s.logBtns}>
                <a href={xHref} target="_blank" rel="noopener noreferrer" className={s.goldBtn}>Share on X</a>
                <button type="button" className={s.ghostBtn} onClick={() => void saveImage(h)}>Save image</button>
              </div>
            </div>
          )}
          {h.rockets && (
            <div className={s.card}>
              <div className={s.eb}>{mine ? "Your rockets" : `${host}'s rockets`}</div>
              <div className={s.kv}><span>Launched</span><b>{h.rockets.launched}</b></div>
              <div className={s.kv}><span>Reached orbit</span><b className={s.goldTxt}>{h.rockets.orbits}</b></div>
              <div className={s.kv}><span>Most passengers</span><b>{h.rockets.mostPassengers}</b></div>
            </div>
          )}
          <p className={s.note}>{HOST_VIEW_COPY.rule}</p>
          <Link href={`/coin/${h.coin}`} className={s.ghostBtn}>Open rocket</Link>
        </aside>
      </div>
    </div>
  );
}

