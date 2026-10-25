"use client";
/**
 * TURBO share card (GAME). Reuses the share-pnl look (lib/share/scene.ts: graded tier sky plate, the pilot's rocket,
 * vignette, heavy type with a glowing $ number, GREEN/RED, CT timestamp from lib/share/format) and ShareModal's actions
 * (Download PNG, copy text, Post on X intent). Rendered client-side to a canvas: nothing is uploaded.
 * Two kinds: "win" (big win) and "wipeout" (SUPERNOVA). SIM · MOCK stamped on every card.
 */
import { useEffect, useRef, useState } from "react";
import { fmtCt, fmtMoney, fmtPct } from "@/lib/share/format";
import { T } from "@/lib/turbo/copy";

export interface TurboShareData { kind: "win" | "wipeout"; pnlUsd: number; betUsd: number; leverage: number; market: string; side: "long" | "short"; at: number }
const GREEN = "#5FF0A0", RED = "#F0307F", INK = "#E8EAEE";
const W = 1200, H = 630;

function load(src: string) { return new Promise<HTMLImageElement | null>((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }); }

export async function renderTurboCard(cv: HTMLCanvasElement, d: TurboShareData) {
  const base = (window as unknown as { __DISCIPLE_BASE_PATH__?: string }).__DISCIPLE_BASE_PATH__ || "";
  const [bg, rocket] = await Promise.all([load(base + (d.kind === "win" ? "/assets/tier6.webp" : "/assets/tier4.webp")), load(base + "/assets/rocket.png")]);
  cv.width = W; cv.height = H; const o = cv.getContext("2d")!;
  o.fillStyle = "#07070d"; o.fillRect(0, 0, W, H);
  if (bg) { const s = Math.max(W / bg.width, H / bg.height); o.globalAlpha = 0.8; o.drawImage(bg, (W - bg.width * s) / 2, (H - bg.height * s) / 2, bg.width * s, bg.height * s); o.globalAlpha = 1; }
  const haze = o.createLinearGradient(0, 0, W, 0); haze.addColorStop(0, "rgba(7,7,13,.92)"); haze.addColorStop(0.55, "rgba(7,7,13,.55)"); haze.addColorStop(1, "rgba(7,7,13,.15)"); o.fillStyle = haze; o.fillRect(0, 0, W, H);
  const col = d.kind === "win" ? GREEN : RED, rx = 930, ry = 330;
  if (d.kind === "wipeout") {   // SUPERNOVA frame: core + rings + rays
    o.globalCompositeOperation = "lighter";
    const g = o.createRadialGradient(rx, ry, 0, rx, ry, 360); g.addColorStop(0, "rgba(255,255,250,1)"); g.addColorStop(0.18, "rgba(255,200,150,.85)"); g.addColorStop(0.5, "rgba(240,48,127,.35)"); g.addColorStop(1, "rgba(0,0,0,0)");
    o.fillStyle = g; o.beginPath(); o.arc(rx, ry, 360, 0, 6.2832); o.fill();
    for (const [r, a, w] of [[210, 0.8, 8], [300, 0.5, 5], [420, 0.25, 3]]) { o.strokeStyle = `rgba(255,230,240,${a})`; o.lineWidth = w; o.beginPath(); o.arc(rx, ry, r, 0, 6.2832); o.stroke(); }
    o.fillStyle = "rgba(255,240,215,.18)"; o.beginPath(); for (let i = 0; i < 18; i++) { const a = i * 2.39996, w = 0.04; o.moveTo(rx, ry); o.arc(rx, ry, 620, a - w, a + w); o.closePath(); } o.fill();
    o.globalCompositeOperation = "source-over";
  } else if (rocket) {
    const h = 380, w = (h * rocket.width) / rocket.height, dive = d.side === "short";
    o.save(); o.translate(rx, dive ? 170 : 500); o.rotate(dive ? Math.PI : 0.12);
    o.globalCompositeOperation = "lighter"; const fg = o.createLinearGradient(0, 0, 0, 260); fg.addColorStop(0, "rgba(255,240,200,.95)"); fg.addColorStop(0.4, dive ? "rgba(255,90,150,.6)" : "rgba(255,150,60,.6)"); fg.addColorStop(1, "rgba(255,80,40,0)");
    o.fillStyle = fg; o.beginPath(); o.moveTo(-26, 0); o.quadraticCurveTo(-18, 130, 0, 260); o.quadraticCurveTo(18, 130, 26, 0); o.fill();
    o.globalCompositeOperation = "source-over"; o.shadowColor = "rgba(200,220,255,.8)"; o.shadowBlur = 30; o.drawImage(rocket, -w / 2, -h * 0.96, w, h); o.restore();
  }
  const vg = o.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.75); vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,.55)"); o.fillStyle = vg; o.fillRect(0, 0, W, H);
  // grain
  const img = o.getImageData(0, 0, W, H), px = img.data; for (let i = 0; i < px.length; i += 16) { const n = (Math.random() - 0.5) * 18; px[i] += n; px[i + 1] += n; px[i + 2] += n; } o.putImageData(img, 0, 0);
  const font = (w: number, s: number) => `${w} ${s}px system-ui, "Helvetica Neue", Arial, sans-serif`;   // canvas fonts cannot use CSS var()
  o.fillStyle = "rgba(232,234,238,.7)"; o.font = font(800, 26); o.fillText("DISCIPLE · TURBO", 64, 84);
  o.fillStyle = col; o.font = font(800, 30); o.fillText(d.kind === "win" ? T.shareTitleWin.toUpperCase() : T.shareTitleLoss.toUpperCase(), 64, 196);
  const big = fmtMoney(d.pnlUsd); o.font = font(900, big.length > 9 ? 120 : 150); o.shadowColor = col; o.shadowBlur = 40; o.fillStyle = col; o.fillText(big, 58, 340); o.shadowBlur = 0;
  o.fillStyle = INK; o.font = font(700, 34);
  o.fillText(T.shareLine(fmtPct(d.betUsd > 0 ? (d.pnlUsd / d.betUsd) * 100 : 0), d.leverage, d.market, d.side === "long" ? T.card.long : T.card.short), 64, 410);
  o.fillStyle = "rgba(232,234,238,.6)"; o.font = font(600, 24); o.fillText(`${T.bet} $${d.betUsd.toFixed(2)} · ${fmtCt(d.at)}`, 64, 456);
  o.font = font(800, 20); const tag = T.simTag, tw = o.measureText(tag).width;
  o.fillStyle = "rgba(255,231,163,.16)"; o.beginPath(); o.roundRect(64, 520, tw + 28, 36, 10); o.fill(); o.fillStyle = "#ffe7a3"; o.fillText(tag, 78, 545);
}

export default function TurboShareCard({ data, onClose, onAgain }: { data: TurboShareData; onClose: () => void; onAgain?: () => void }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState(""); const [msg, setMsg] = useState("");
  useEffect(() => { let live = true; const c = cv.current; if (!c) return; renderTurboCard(c, data).then(() => { if (live) setUrl(c.toDataURL("image/png")); }); return () => { live = false; }; }, [data]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  const text = data.kind === "win" ? T.shareText(fmtMoney(data.pnlUsd), data.leverage, data.market) : T.shareTextLoss(data.leverage, data.market);
  return (
    <div className="tb-share-wrap" data-testid="turbo-share" role="dialog" aria-modal="true" aria-label={T.share}>
      <div className="tb-share">
        <canvas ref={cv} className="tb-share-cv" data-testid="turbo-share-canvas" />
        <div className="tb-share-row">
          <a className="tb-sbtn" href={url || undefined} download={`disciple-turbo-${data.kind}.png`} aria-disabled={!url}>{T.download}</a>
          <button type="button" className="tb-sbtn" onClick={() => { navigator.clipboard?.writeText(text).then(() => { setMsg(T.copied); setTimeout(() => setMsg(""), 1500); }).catch(() => {}); }}>{msg || T.copyText}</button>
          <a className="tb-sbtn" target="_blank" rel="noreferrer" href={`https://x.com/intent/post?text=${encodeURIComponent(text)}`}>{T.postX}</a>
        </div>
        <div className="tb-share-row">
          {onAgain && <button type="button" className="tb-sbtn tb-primary" data-testid="turbo-again" onClick={onAgain}>{T.again}</button>}
          <button type="button" className="tb-sbtn" data-testid="turbo-share-close" onClick={onClose}>{T.closeModal}</button>
        </div>
      </div>
    </div>
  );
}
