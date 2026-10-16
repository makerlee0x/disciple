"use client";
/**
 * "Share this trade" modal: preview of the story card + Web Share (file), Download PNG, Copy ref link, Post on X.
 * Media comes from lib/share/media (PNG today; swap shareMediaFor() for a replay video later).
 */
import { useEffect, useMemo, useState } from "react";
import { shareMediaFor, imageMedia, type ShareParams } from "@/lib/share/media";
import { refLink } from "@/lib/referral";
import { fmtMcap, fmtMoney, fmtPct, shareText } from "@/lib/share/format";
import type { PositionPnl } from "@/lib/sharePnl";

export interface ShareTarget { coin: string; ticker: string; wallet: string | null; username: string | null; sample?: boolean }

export default function ShareModal({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const [at] = useState(() => Date.now()); // "now" = the moment Share was pressed
  const [pnl, setPnl] = useState<PositionPnl | null>(null);
  const [msg, setMsg] = useState("");
  const [loaded, setLoaded] = useState(false);
  // Real card once the wallet's indexed fills come back; SAMPLE card when there are none (or no wallet).
  const [demo, setDemo] = useState<boolean | null>(target.sample || !target.wallet ? true : null);
  const params: ShareParams = { coin: target.coin, wallet: target.wallet, ticker: target.ticker, username: target.username, demo: !!demo, at };
  const media = useMemo(() => shareMediaFor(params), [target.coin, target.wallet, target.username, demo, at]); // eslint-disable-line react-hooks/exhaustive-deps
  const og = useMemo(() => imageMedia(params, "og"), [media]); // eslint-disable-line react-hooks/exhaustive-deps
  const link = refLink(target.username, target.wallet);

  useEffect(() => {
    if (demo !== null || !target.wallet) return;
    fetch(`/api/share/pnl?wallet=${target.wallet}&coin=${target.coin}`).then((r) => (r.ok ? r.json() : null))
      .then((p: PositionPnl | null) => { setPnl(p); setDemo(!p || p.kind === "none"); }).catch(() => setDemo(true));
  }, [demo, target.wallet, target.coin]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);

  const text = pnl && pnl.kind !== "none" ? shareText({ ...pnl, ticker: target.ticker }, link) : `Flying $${target.ticker} on DISCIPLE. Board my rocket: ${link}`;
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 1600); };

  async function webShare() {
    try {
      const blob = await media.blob();
      const file = new File([blob], media.filename, { type: media.mime });
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      if (nav.share && nav.canShare?.({ files: [file] })) await nav.share({ files: [file], text, url: link });
      else if (nav.share) await nav.share({ text, url: link });
      else { await download(); flash("Sharing not supported here: downloaded instead"); }
    } catch (e) { if ((e as Error).name !== "AbortError") flash("Share failed"); }
  }
  async function download(m = media) {
    const blob = await m.blob();
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = u; a.download = m.filename; a.click();
    setTimeout(() => URL.revokeObjectURL(u), 2000);
  }
  async function copyLink() { try { await navigator.clipboard.writeText(link); flash("Ref link copied"); } catch { flash(link); } }
  function postX() { window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer"); }

  return (
    <div role="dialog" aria-modal="true" aria-label={`Share ${target.ticker} trade`} className="share-modal-bg" onClick={onClose}>
      <div className="share-modal" onClick={(e) => e.stopPropagation()}>
        <div className="share-modal-head">
          <h3>Share this trade · ${target.ticker}</h3>
          <button type="button" className="ds-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="share-modal-body">
          <div className="share-card-frame">
            {!loaded && <div className="share-card-loading mono tiny">rendering card…</div>}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {demo === null ? null : media.kind === "image" ? <img src={media.url} alt={`${target.ticker} share card`} onLoad={() => setLoaded(true)} /> : <video src={media.url} autoPlay loop muted playsInline />}
          </div>
          <div className="share-side">
            {pnl && pnl.kind !== "none" ? (
              <div className="share-stats">
                <div className={pnl.gainUsd >= 0 ? "pos big" : "neg big"}>{fmtMoney(pnl.gainUsd)}</div>
                <div className={pnl.gainUsd >= 0 ? "pos" : "neg"}>{fmtPct(pnl.gainPct)} · {pnl.kind}</div>
                <div className="muted tiny">mcap {fmtMcap(pnl.mcapEndUsd)} · {pnl.fills.length} fills</div>
              </div>
            ) : <p className="muted tiny">{demo ? "Sample data: this profile has no indexed trades yet." : "Loading position…"}</p>}
            <button type="button" className="ds-btn share-primary" onClick={webShare} disabled={demo === null}>Share…</button>
            <button type="button" className="ds-btn" onClick={() => download()}>Download PNG (story)</button>
            <button type="button" className="ds-btn" onClick={() => download(og)}>Download PNG (square)</button>
            <button type="button" className="ds-btn" onClick={copyLink}>Copy ref link</button>
            <button type="button" className="ds-btn x" onClick={postX}>Post on 𝕏</button>
            <span className="mono tiny share-link">{link.replace(/^https?:\/\//, "")}</span>
            {msg && <span role="status" className="tiny share-flash">{msg}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
