"use client";
/**
 * Turbo share card (big wins and liquidations), dollars only. Same actions as today's share modal
 * (components/share/ShareModal.tsx): image preview, Download, Copy text, Post on X. Placeholder art and copy until Brand's
 * pass. The card is drawn on a canvas from the closing event's own numbers.
 */
import { useEffect, useMemo, useState } from "react";
import { withBase } from "@/lib/base-path";
import { RUN_COPY as R, TURBO_COPY as C } from "@/lib/turbo/copy";
import { clock, multipleLabel } from "@/lib/turbo/runs";
import { lev as fmtLev, signedUsd, usd } from "@/lib/turbo/format";
import type { Market, Side } from "@/lib/turbo";
import s from "./turbo.module.css";

export interface TurboShare {
  kind: "win" | "liquidated";
  market: Market; side: Side; leverage: number;
  profitUsd: number;   // after fees (negative on a liquidation = the fuel lost)
  fuelUsd: number; entry: number; exit: number;
  /** v2: cash-out multiple of the fuel put in, and how long the run lasted. */
  multiple?: number; lastedMs?: number;
}

const W = 1200, H = 630;
/** next/font names the face itself (e.g. "__Barlow_Condensed_ab12"), so read the CSS variable it sets. */
let GAME = '"Barlow Condensed", "Arial Narrow", ui-sans-serif, sans-serif';
function gameFont() {
  try { const v = getComputedStyle(document.documentElement).getPropertyValue("--font-barlow-condensed").trim() || getComputedStyle(document.body).getPropertyValue("--font-barlow-condensed").trim(); if (v) GAME = `${v}, ${GAME}`; } catch { /* default */ }
}

/** v2 card (canvas "Turbo mockups" › Share card): text on the left, the chrome rocket climbing on the right.
 *  A win leads with the multiple; an H-BOMB leads with how long you lasted, never the loss. */
function draw(cv: HTMLCanvasElement, d: TurboShare, rocket: HTMLImageElement | null) {
  cv.width = W; cv.height = H;
  const g = cv.getContext("2d"); if (!g) return;
  const win = d.kind === "win";
  g.fillStyle = "#121327"; g.fillRect(0, 0, W, H);
  // sky on the right
  const sky = g.createRadialGradient(930, 260, 20, 930, 300, 520);
  if (win) { sky.addColorStop(0, "#3B4A8C"); sky.addColorStop(0.55, "#232A5C"); sky.addColorStop(1, "rgba(18,19,39,0)"); }
  else { sky.addColorStop(0, "rgba(255,214,150,.9)"); sky.addColorStop(0.3, "rgba(240,48,127,.55)"); sky.addColorStop(0.7, "rgba(26,14,31,.6)"); sky.addColorStop(1, "rgba(18,19,39,0)"); }
  g.fillStyle = sky; g.fillRect(560, 0, W - 560, H);
  if (win && rocket) {
    const h = 430, w = (h * rocket.width) / rocket.height;
    g.save(); g.translate(930, 300); g.rotate((6 * Math.PI) / 180);
    const fl = g.createLinearGradient(0, h / 2, 0, h / 2 + 240); fl.addColorStop(0, "rgba(255,210,110,.95)"); fl.addColorStop(1, "rgba(255,90,40,0)");
    g.fillStyle = fl; g.beginPath(); g.moveTo(-w * 0.16, h / 2 - 12); g.lineTo(w * 0.16, h / 2 - 12); g.lineTo(0, h / 2 + 240); g.closePath(); g.fill();
    g.drawImage(rocket, -w / 2, -h / 2, w, h); g.restore();
  } else if (!win) {
    g.strokeStyle = "rgba(255,230,200,.5)"; g.lineWidth = 6; g.beginPath(); g.arc(930, 290, 220, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = "rgba(255,230,200,.25)"; g.lineWidth = 3; g.beginPath(); g.arc(930, 290, 300, 0, Math.PI * 2); g.stroke();
  }
  const fade = g.createLinearGradient(0, 0, W, 0); fade.addColorStop(0, "#121327"); fade.addColorStop(0.46, "#121327"); fade.addColorStop(0.72, "rgba(18,19,39,.2)"); fade.addColorStop(1, "rgba(18,19,39,0)");
  g.fillStyle = fade; g.fillRect(0, 0, W, H);

  const L = 72;
  g.textBaseline = "alphabetic";
  g.fillStyle = "#F3DFA8"; g.font = `italic 800 40px ${GAME}`; g.fillText("DISCIPLE TURBO", L, 104);
  const lasted = d.lastedMs != null ? clock(d.lastedMs) : "";
  if (win) {
    g.fillStyle = "#F3DFA8"; g.font = `700 30px ${GAME}`; g.fillText("CASHED OUT", L, 178);
    g.fillStyle = (d.multiple ?? 1) >= 1 ? "#F2C14E" : "#FF7FB2"; g.font = `800 200px ${GAME}`; g.fillText(multipleLabel(d.multiple ?? 1 + d.profitUsd / d.fuelUsd), L - 6, 352);
    g.fillStyle = d.profitUsd >= 0 ? "#5FF0A0" : "#FF7FB2"; g.font = `800 52px ${GAME}`; g.fillText(signedUsd(d.profitUsd), L, 418);
  } else {
    g.fillStyle = "#F2F3F7"; g.font = `800 64px ${GAME}`; g.fillText("H-BOMB'D", L, 190);
    g.fillStyle = "#FFE1EC"; g.font = `700 30px ${GAME}`; g.fillText("LASTED", L, 236);
    g.fillStyle = "#F2C14E"; g.font = `800 180px ${GAME}`; g.fillText(lasted || "—", L - 6, 398);
  }
  // chips
  g.font = `700 28px ${GAME}`;
  const chips: [string, string?][] = [[`${d.side === "long" ? "BOOST ▲" : "DUMP ▼"} ${d.market}`, d.side === "long" ? "#F2C14E" : "#FF7FB2"], [fmtLev(d.leverage)]];
  if (win && lasted) chips.push([lasted]);
  let x = L;
  for (const [t, col] of chips) {
    const w = g.measureText(t).width + 28;
    g.fillStyle = "rgba(18,19,39,.7)"; g.strokeStyle = "#2E323A"; g.lineWidth = 2;
    g.beginPath(); if (g.roundRect) g.roundRect(x, 470, w, 48, 10); else g.rect(x, 470, w, 48); g.fill(); g.stroke();
    g.fillStyle = col ?? "#F2F3F7"; g.fillText(t, x + 14, 504); x += w + 12;
  }
  g.fillStyle = "rgba(215,217,228,.9)"; g.font = "500 22px ui-sans-serif, system-ui, sans-serif"; g.fillText(R.shareFooter, L, 566);
}

export default function TurboShareCard({ data, onClose }: { data: TurboShare; onClose: () => void }) {
  const [url, setUrl] = useState<string>("");
  const [msg, setMsg] = useState("");
  const text = useMemo(() => {
    const t = data.lastedMs != null ? clock(data.lastedMs) : "";
    return data.kind === "win"
      ? R.shareWinText(multipleLabel(data.multiple ?? 1 + data.profitUsd / data.fuelUsd), usd(Math.max(0, data.profitUsd)), fmtLev(data.leverage), data.side === "long" ? "BOOST" : "DUMP", data.market, t)
      : R.shareBombText(t, fmtLev(data.leverage), data.market);
  }, [data]);
  useEffect(() => {
    let alive = true;
    const cv = document.createElement("canvas");
    const img = new Image();
    const done = async (im: HTMLImageElement | null) => { gameFont(); try { await document.fonts?.ready; } catch { /* ignore */ } if (!alive) return; draw(cv, data, im); try { setUrl(cv.toDataURL("image/png")); } catch { /* ignore */ } };
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
