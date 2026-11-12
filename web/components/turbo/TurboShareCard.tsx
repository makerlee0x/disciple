"use client";
/**
 * Turbo share card (big wins and liquidations), dollars only. Same actions as today's share modal
 * (components/share/ShareModal.tsx): image preview, Download, Copy text, Post on X. Placeholder art and copy until Brand's
 * pass. The card is drawn on a canvas from the closing event's own numbers.
 */
import { useEffect, useMemo, useState } from "react";
import { withBase } from "@/lib/base-path";
import { TURBO_COPY as C } from "@/lib/turbo/copy";
import { lev as fmtLev, price as fmtPrice, signedUsd, usd } from "@/lib/turbo/format";
import type { Market, Side } from "@/lib/turbo";
import s from "./turbo.module.css";

export interface TurboShare {
  kind: "win" | "liquidated";
  market: Market; side: Side; leverage: number;
  profitUsd: number;   // after fees (negative on a liquidation = the fuel lost)
  fuelUsd: number; entry: number; exit: number;
}

const W = 1200, H = 630;

function draw(cv: HTMLCanvasElement, d: TurboShare, rocket: HTMLImageElement | null) {
  cv.width = W; cv.height = H;
  const g = cv.getContext("2d"); if (!g) return;
  const win = d.kind === "win";
  const bg = g.createLinearGradient(0, 0, 0, H);
  if (win) { bg.addColorStop(0, "#121327"); bg.addColorStop(1, "#202141"); } else { bg.addColorStop(0, "#2a0b0b"); bg.addColorStop(0.55, "#5a1a10"); bg.addColorStop(1, "#0B0C0E"); }
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  if (!win) { // bomb frame: white-hot core + shock rings
    const c = g.createRadialGradient(860, 300, 10, 860, 300, 360); c.addColorStop(0, "rgba(255,255,240,.95)"); c.addColorStop(0.25, "rgba(255,190,90,.75)"); c.addColorStop(0.6, "rgba(240,48,127,.25)"); c.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = c; g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(255,230,200,.5)"; g.lineWidth = 6; g.beginPath(); g.arc(860, 300, 250, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = "rgba(255,230,200,.25)"; g.lineWidth = 3; g.beginPath(); g.arc(860, 300, 330, 0, Math.PI * 2); g.stroke();
  } else if (rocket) { // rocket pose: nose up on BOOST, nose-down dive on DUMP (same sprite)
    const h = 420, w = (h * rocket.width) / rocket.height;
    g.save(); g.translate(880, 320); g.rotate(d.side === "short" ? (135 * Math.PI) / 180 : (8 * Math.PI) / 180);
    const fl = g.createLinearGradient(0, h / 2, 0, h / 2 + 220); fl.addColorStop(0, "rgba(255,200,90,.9)"); fl.addColorStop(1, "rgba(255,90,40,0)");
    g.fillStyle = fl; g.beginPath(); g.moveTo(-w * 0.18, h / 2 - 10); g.lineTo(w * 0.18, h / 2 - 10); g.lineTo(0, h / 2 + 220); g.closePath(); g.fill();
    g.drawImage(rocket, -w / 2, -h / 2, w, h); g.restore();
  }
  g.fillStyle = "#E8EAEE"; g.font = "700 30px ui-sans-serif, system-ui, sans-serif"; g.fillText("DISCIPLE TURBO", 64, 86);
  g.fillStyle = win ? "#5FF0A0" : "#FFB0C8"; g.font = "700 40px ui-sans-serif, system-ui, sans-serif";
  g.fillText(win ? C.shareWinTitle : C.shareLiqTitle(fmtLev(d.leverage)), 64, 176);
  g.fillStyle = win ? "#5FF0A0" : "#F0307F"; g.font = "800 120px ui-sans-serif, system-ui, sans-serif";
  g.fillText(signedUsd(d.profitUsd), 60, 320);
  g.fillStyle = "#C9CED6"; g.font = "600 30px ui-sans-serif, system-ui, sans-serif";
  g.fillText(`${d.side === "long" ? "BOOST" : "DUMP"} ${d.market} · ${fmtLev(d.leverage)} · ${usd(d.fuelUsd)} fuel`, 64, 392);
  g.fillStyle = "#9095A0"; g.font = "500 26px ui-sans-serif, system-ui, sans-serif";
  g.fillText(`Entry ${fmtPrice(d.entry)} → ${win ? "Exit" : "Liquidated at"} ${fmtPrice(d.exit)}`, 64, 440);
  g.fillStyle = "#9095A0"; g.font = "500 22px ui-sans-serif, system-ui, sans-serif"; g.fillText("Profit shown after fees.", 64, H - 56);
}

export default function TurboShareCard({ data, onClose }: { data: TurboShare; onClose: () => void }) {
  const [url, setUrl] = useState<string>("");
  const [msg, setMsg] = useState("");
  const text = useMemo(() => data.kind === "win"
    ? C.shareWinText(usd(data.profitUsd), fmtLev(data.leverage), data.market, data.side === "long" ? "BOOST" : "DUMP")
    : C.shareLiqText(fmtLev(data.leverage), data.market), [data]);
  useEffect(() => {
    let alive = true;
    const cv = document.createElement("canvas");
    const img = new Image();
    const done = (im: HTMLImageElement | null) => { if (!alive) return; draw(cv, data, im); try { setUrl(cv.toDataURL("image/png")); } catch { /* ignore */ } };
    img.onload = () => done(img); img.onerror = () => done(null); img.src = withBase("/assets/rocket-hi.webp");
    return () => { alive = false; };
  }, [data]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className={s.dim} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Share" className={`${s.sheet} ${s.shareSheet}`} data-testid="turbo-share-card" data-kind={data.kind}>
        <button type="button" className={s.x} aria-label={C.shareClose} onClick={onClose}>×</button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url ? <img src={url} alt={text} className={s.shareImg} /> : <div className={s.shareImg} />}
        <div className={s.shareBtns}>
          <a className={s.ghostBtn} href={url || undefined} download={`disciple-turbo-${data.kind}.png`}>{C.shareDownload}</a>
          <button type="button" className={s.ghostBtn} onClick={async () => { try { await navigator.clipboard.writeText(text); setMsg(C.shareCopied); setTimeout(() => setMsg(""), 1500); } catch { /* ignore */ } }}>{msg || C.shareCopyText}</button>
          <a className={s.ghostBtn} href={`https://x.com/intent/post?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">{C.sharePostX}</a>
        </div>
      </div>
    </div>
  );
}
