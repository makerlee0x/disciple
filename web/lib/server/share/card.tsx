import "server-only";
/**
 * Share card renderer (next/og / satori → PNG). Formats: story 1080×1920, og 1080×1080.
 * Fonts: static Geist Black / Geist Mono Bold instances cut from app/fonts/*VF.woff (satori cannot read variable fonts).
 * Look: near-black, film grain, heavy Geist, green gain. No illustrations: type + the wallet's fills chart.
 */
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import type { PositionPnl } from "@/lib/sharePnl";
import { fmtCt, fmtMcap, fmtMoney, fmtPct } from "@/lib/share/format";

export interface CardData { pnl: PositionPnl; ticker: string; username: string | null; refLabel: string; sample: boolean }
export const SIZES = { story: { width: 1080, height: 1920 }, og: { width: 1080, height: 1080 } } as const;

let fontP: Promise<ArrayBuffer> | null = null;
export function geist(): Promise<ArrayBuffer> {
  return (fontP ??= fs.readFile(path.join(process.cwd(), "app/fonts/static/Geist-Black.woff")).then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer));
}
let monoP: Promise<ArrayBuffer> | null = null;
export function geistMono(): Promise<ArrayBuffer> {
  return (monoP ??= fs.readFile(path.join(process.cwd(), "app/fonts/static/GeistMono-Bold.woff")).then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer));
}

/** Deterministic film-grain tile (PNG data URI), generated once per lambda. */
let grainP: Promise<string> | null = null;
export function grain(): Promise<string> {
  return (grainP ??= (async () => {
    const W = 360, buf = Buffer.alloc(W * W * 4);
    let s = 0x2f6b9d1;
    for (let i = 0; i < W * W; i++) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      const v = (s >>> 0) & 255;
      buf[i * 4] = buf[i * 4 + 1] = buf[i * 4 + 2] = v > 127 ? 255 : 0;
      buf[i * 4 + 3] = Math.floor(((v * 7) & 255) / 255 * 34);
    }
    const png = await sharp(buf, { raw: { width: W, height: W, channels: 4 } }).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  })());
}

/** Mini chart of the wallet's fills: mcap path through fills (+ end point), buys ▲ green, sells ▼ red. */
export function fillsChartSvg(p: PositionPnl, w: number, h: number, accent = "#39ff6a"): string {
  const pts = p.fills.map((f) => ({ t: f.ts, m: f.mcapUsd, side: f.side as string }));
  if (p.kind === "unrealized") pts.push({ t: p.endTs, m: p.mcapEndUsd, side: "now" });
  if (pts.length === 0) return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"></svg>`;
  // x = fill order (fills cluster in time), y = log mcap with a minimum span so flat paths sit mid-chart.
  const ms = pts.map((q) => Math.log10(Math.max(1, q.m)));
  let lo = Math.min(...ms), hi = Math.max(...ms);
  if (hi - lo < 0.08) { const c = (hi + lo) / 2; lo = c - 0.04; hi = c + 0.04; }
  const pad = 28;
  const idx = new Map(pts.map((q, i) => [q, i]));
  const X0 = (i: number) => pad + (pts.length > 1 ? i / (pts.length - 1) : 0.5) * (w - pad * 2);
  const Y = (m: number) => h - pad - ((Math.log10(Math.max(1, m)) - lo) / (hi - lo)) * (h - pad * 2);
  const X = (q: (typeof pts)[number]) => X0(idx.get(q) ?? 0);
  const line = pts.map((q, i) => `${i ? "L" : "M"}${X(q).toFixed(1)},${Y(q.m).toFixed(1)}`).join(" ");
  const area = `${line} L${X(pts[pts.length - 1]).toFixed(1)},${h - pad} L${X(pts[0]).toFixed(1)},${h - pad} Z`;
  const grid = [0.25, 0.5, 0.75].map((f) => `<line x1="${pad}" x2="${w - pad}" y1="${(pad + f * (h - 2 * pad)).toFixed(1)}" y2="${(pad + f * (h - 2 * pad)).toFixed(1)}" stroke="#ffffff" stroke-opacity=".07" stroke-width="2"/>`).join("");
  const marks = pts.map((q) => {
    const x = X(q), y = Y(q.m);
    if (q.side === "buy") return `<path d="M${x - 15},${y + 13} L${x},${y - 15} L${x + 15},${y + 13} Z" fill="#39ff6a" stroke="#0a0a0a" stroke-width="4"/>`;
    if (q.side === "sell") return `<path d="M${x - 15},${y - 13} L${x},${y + 15} L${x + 15},${y - 13} Z" fill="#ff3b3b" stroke="#0a0a0a" stroke-width="4"/>`;
    return `<circle cx="${x}" cy="${y}" r="12" fill="#f4f1e8"/><circle cx="${x}" cy="${y}" r="22" fill="none" stroke="#f4f1e8" stroke-opacity=".5" stroke-width="3"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${grid}<path d="${area}" fill="${accent}" fill-opacity=".10"/><path d="${line}" fill="none" stroke="#f4f1e8" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>${marks}</svg>`;
}

const GREEN = "#39ff6a", RED = "#ff3b3b", INK = "#f4f1e8", DIM = "rgba(244,241,232,.55)";

export function CardEl({ d, format, grainUri }: { d: CardData; format: "story" | "og"; grainUri: string }) {
  const { pnl } = d;
  const story = format === "story";
  const W = 1080, H = story ? 1920 : 1080;
  const up = pnl.gainUsd >= 0;
  const color = up ? GREEN : RED;
  const big = fmtMoney(pnl.gainUsd);
  const bigSize = Math.min(story ? 250 : 150, Math.floor((W - 120) / (big.length * 0.6)));
  const chartH = story ? 560 : 210;
  const chart = `data:image/svg+xml;base64,${Buffer.from(fillsChartSvg(pnl, W - 120, chartH, color)).toString("base64")}`;
  const status = pnl.kind === "realized" ? "REALIZED" : "UNREALIZED · STILL HOLDING";
  return (
    <div style={{ width: W, height: H, display: "flex", flexDirection: "column", background: "#0a0a0a", color: INK, fontFamily: "Geist", position: "relative", padding: story ? "90px 60px 80px" : "56px 60px 50px" }}>
      {/* warm vignette */}
      <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H, display: "flex", backgroundImage: "radial-gradient(circle at 20% 10%, rgba(255,214,120,.10), rgba(0,0,0,0) 55%), radial-gradient(circle at 90% 100%, rgba(57,255,106,.08), rgba(0,0,0,0) 50%)" }} />
      {/* header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: "GeistMono", fontSize: story ? 30 : 26, letterSpacing: 6 }}>
        <div style={{ display: "flex", fontWeight: 800, color: INK }}>DISCIPLE</div>
        <div style={{ display: "flex", color: DIM }}>{fmtCt(pnl.endTs || Date.now())}</div>
      </div>
      <div style={{ display: "flex", height: 6, background: INK, marginTop: story ? 28 : 20 }} />
      {/* ticker + status */}
      <div style={{ display: "flex", flexDirection: "column", marginTop: story ? 90 : 28 }}>
        <div style={{ display: "flex", fontSize: story ? 120 : 72, fontWeight: 900, letterSpacing: -4, lineHeight: 1 }}>${d.ticker}</div>
        <div style={{ display: "flex", fontFamily: "GeistMono", fontSize: story ? 30 : 22, color: DIM, marginTop: story ? 18 : 10, letterSpacing: 4 }}>{status}</div>
      </div>
      {/* gain */}
      <div style={{ display: "flex", flexDirection: "column", marginTop: story ? 70 : 18 }}>
        <div style={{ display: "flex", fontSize: bigSize, fontWeight: 900, color, letterSpacing: -8, lineHeight: 0.95 }}>{big}</div>
        <div style={{ display: "flex", alignItems: "baseline", marginTop: 10 }}>
          <div style={{ display: "flex", fontSize: story ? 130 : 76, fontWeight: 900, color, letterSpacing: -4 }}>{fmtPct(pnl.gainPct)}</div>
        </div>
      </div>
      {/* stats row */}
      <div style={{ display: "flex", fontFamily: "GeistMono", fontSize: story ? 30 : 24, marginTop: story ? 50 : 20, gap: 50 }}>
        <div style={{ display: "flex", flexDirection: "column" }}><span style={{ color: DIM, letterSpacing: 4 }}>ENTRY MCAP</span><span style={{ fontSize: story ? 46 : 36, fontFamily: "Geist", fontWeight: 900, marginTop: 6 }}>{fmtMcap(pnl.mcapStartUsd)}</span></div>
        <div style={{ display: "flex", flexDirection: "column" }}><span style={{ color: DIM, letterSpacing: 4 }}>{pnl.kind === "realized" ? "EXIT MCAP" : "MCAP NOW"}</span><span style={{ fontSize: story ? 46 : 36, fontFamily: "Geist", fontWeight: 900, marginTop: 6 }}>{fmtMcap(pnl.mcapEndUsd)}</span></div>
        <div style={{ display: "flex", flexDirection: "column" }}><span style={{ color: DIM, letterSpacing: 4 }}>FILLS</span><span style={{ fontSize: story ? 46 : 36, fontFamily: "Geist", fontWeight: 900, marginTop: 6 }}>{pnl.fills.length}</span></div>
      </div>
      {/* chart */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={chart} width={W - 120} height={chartH} style={{ marginTop: story ? 60 : 12 }} alt="" />
      {/* footer */}
      <div style={{ display: "flex", flexGrow: 1 }} />
      <div style={{ display: "flex", height: 3, background: "rgba(244,241,232,.35)" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: story ? 26 : 18 }}>
        <div style={{ display: "flex", fontSize: story ? 56 : 40, fontWeight: 900, letterSpacing: -1 }}>{d.username ? `@${d.username}` : d.refLabel.split("/r/")[1] || ""}</div>
        <div style={{ display: "flex", fontFamily: "GeistMono", fontSize: story ? 30 : 26, color: INK, background: "rgba(244,241,232,.08)", border: "2px solid rgba(244,241,232,.35)", padding: "10px 18px" }}>{d.refLabel}</div>
      </div>
      {/* grain on top */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H, display: "flex", backgroundImage: `url(${grainUri})`, backgroundRepeat: "repeat", backgroundSize: "360px 360px" }} />
      {d.sample && (
        <div style={{ position: "absolute", right: 60, top: story ? 170 : 120, display: "flex", fontFamily: "GeistMono", fontSize: 26, letterSpacing: 6, color: "#0a0a0a", background: "#ffd166", padding: "8px 16px", transform: "rotate(4deg)" }}>SAMPLE DATA</div>
      )}
    </div>
  );
}
