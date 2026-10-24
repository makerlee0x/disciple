"use client";
/**
 * "Share this trade" modal: card preview + VIDEO (replay + end card → MP4) with progress, Web Share (file),
 * Download, Copy ref link, Post on X. Media comes from lib/share/media (PNG) / lib/share/video (MP4, PNG fallback).
 */
import { useEffect, useMemo, useState } from "react";
import { shareMediaFor, imageMedia, videoMedia, canEncodeVideo, type ShareMedia, type ShareParams } from "@/lib/share/media";
import { refLabel, refLink } from "@/lib/referral";
import { fmtMcap, fmtMoney, fmtPct, shareText } from "@/lib/share/format";
import { localLoadoutIds, loadoutFromIds } from "@/lib/share/loadout";
import type { PositionPnl } from "@/lib/sharePnl";
import type { Fill } from "@/lib/trades";
import Icon from "@/components/icons/Icon";

export interface ShareTarget { coin: string; ticker: string; wallet: string | null; username: string | null; sample?: boolean }
type Pnl = PositionPnl & { sample?: boolean };

export default function ShareModal({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const [at] = useState(() => Date.now()); // "now" = the moment Share was pressed
  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [msg, setMsg] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [ids] = useState(() => (typeof window !== "undefined" ? localLoadoutIds() : { skin: "chrome", coin: "halo", thruster: "stock" }));
  // Real card once the wallet's indexed fills come back; SAMPLE card when there are none (or no wallet).
  const [demo, setDemo] = useState<boolean | null>(target.sample || !target.wallet ? true : null);
  const [video, setVideo] = useState<ShareMedia | null>(null);
  const [vp, setVp] = useState<{ p: number; stage: string } | null>(null);
  const [vNote, setVNote] = useState("");
  const params: ShareParams = { coin: target.coin, wallet: target.wallet, ticker: target.ticker, username: target.username, demo: !!demo, at, loadout: ids };
  const png = useMemo(() => shareMediaFor(params), [target.coin, target.wallet, target.username, demo, at]); // eslint-disable-line react-hooks/exhaustive-deps
  const og = useMemo(() => imageMedia(params, "og"), [png]); // eslint-disable-line react-hooks/exhaustive-deps
  const media = video ?? png;
  const link = refLink(target.username, target.wallet);

  useEffect(() => {
    if (demo === false || (demo === true && pnl)) return;
    const q = demo ? `demo=1&at=${at}&wallet=${target.wallet ?? ""}&coin=${target.coin}` : `wallet=${target.wallet}&coin=${target.coin}`;
    fetch(`/api/share/pnl?${q}`).then((r) => (r.ok ? r.json() : null))
      .then((p: Pnl | null) => { if (demo) { setPnl(p); return; } if (!p || p.kind === "none") setDemo(true); else { setPnl(p); setDemo(false); } })
      .catch(() => setDemo(true));
  }, [demo, pnl, at, target.wallet, target.coin]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  useEffect(() => () => { if (video) URL.revokeObjectURL(video.url); }, [video]);

  const text = pnl && pnl.kind !== "none" && !demo ? shareText({ ...pnl, ticker: target.ticker }, link) : `Flying $${target.ticker} on DISCIPLE. Board my rocket: ${link}`;
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 1800); };

  async function makeVideo() {
    if (!pnl || vp) return;
    setVNote(""); setVp({ p: 0, stage: "starting" });
    try {
      const { renderShareVideo } = await import("@/lib/share/video");
      const coinFills: Fill[] = demo ? pnl.fills
        : await fetch(`/api/trades?coin=${target.coin}`).then((r) => r.json()).then((j: { fills?: Fill[] }) => j.fills ?? []).catch(() => pnl.fills);
      const res = await renderShareVideo({
        coin: target.coin, ticker: target.ticker, wallet: target.wallet ?? pnl.wallet, pnl, coinFills, loadout: loadoutFromIds(ids), loadoutIds: ids,
        scene: { gainUsd: pnl.gainUsd, gainPct: pnl.gainPct, kind: pnl.kind, ticker: target.ticker, mcapStart: pnl.mcapStartUsd, mcapEnd: pnl.mcapEndUsd,
          endTs: pnl.endTs || at, username: target.username, refLabel: refLabel(target.username, target.wallet, window.location.host), sample: !!demo, wallet: target.wallet ?? pnl.wallet,
          fills: pnl.fills.map((f) => ({ side: f.side, mcapUsd: f.mcapUsd })) },
        onProgress: (p, stage) => setVp({ p, stage }),
      });
      if (!res) { setVNote("Video isn't available in this browser (or the replay engine isn't deployed yet), so here's the PNG."); return; }
      setVideo(videoMedia(res.blob, res.mime, res.ext, target.ticker));
      if (res.ext !== "mp4") setVNote("This browser can only record WebM; X and iOS may need the PNG.");
    } catch (e) { console.warn(e); setVNote("Video render failed, so here's the PNG."); }
    finally { setVp(null); }
  }

  async function webShare() {
    try {
      const blob = await media.blob();
      const file = new File([blob], media.filename, { type: media.mime });
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      if (nav.share && nav.canShare?.({ files: [file] })) await nav.share({ files: [file], text, url: link });
      else if (nav.share) await nav.share({ text, url: link });
      else { await download(); flash("Sharing isn't supported here, so it downloaded instead"); }
    } catch (e) { if ((e as Error).name !== "AbortError") flash("Share failed"); }
  }
  async function download(m: ShareMedia = media) {
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
          <button type="button" className="ds-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={16} /></button>
        </div>
        <div className="share-modal-body">
          <div className="share-card-frame">
            {!loaded && !video && <div className="share-card-loading mono tiny">rendering card…</div>}
            {demo === null ? null : media.kind === "video"
              ? <video data-testid="share-video" src={media.url} autoPlay loop muted playsInline controls />
              // eslint-disable-next-line @next/next/no-img-element
              : <img src={media.url} alt={`${target.ticker} share card`} onLoad={() => setLoaded(true)} />}
          </div>
          <div className="share-side">
            {pnl && pnl.kind !== "none" ? (
              <div className="share-stats">
                <div className={pnl.gainUsd >= 0 ? "pos big" : "neg big"}>{fmtMoney(pnl.gainUsd)}</div>
                <div className={pnl.gainUsd >= 0 ? "pos" : "neg"}>{fmtPct(pnl.gainPct)} · {pnl.kind}</div>
                <div className="muted tiny">mcap {fmtMcap(pnl.mcapEndUsd)} · {pnl.fills.length} fills{demo ? " · sample data" : ""}</div>
              </div>
            ) : <p className="muted tiny">Loading position…</p>}
            {canEncodeVideo() && !video && (
              <button type="button" className="ds-btn share-video-btn" data-testid="share-make-video" onClick={makeVideo} disabled={!pnl || !!vp}>
                {vp ? "Rendering video…" : <><Icon name="video" size={16} /> Make video (15s)</>}
              </button>
            )}
            {vp && (
              <div className="share-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(vp.p * 100)}>
                <div className="share-progress-fill" style={{ width: `${Math.round(vp.p * 100)}%` }} />
                <span>{vp.stage} · {Math.round(vp.p * 100)}%</span>
              </div>
            )}
            {vNote && <span className="tiny share-flash">{vNote}</span>}
            <button type="button" className="ds-btn share-primary" onClick={webShare} disabled={demo === null || !!vp}>Share{video ? " video" : ""}…</button>
            <button type="button" className="ds-btn" data-testid="share-download" onClick={() => download()} disabled={!!vp}>{video ? `Download ${video.filename.endsWith(".mp4") ? "MP4" : "WebM"}` : "Download PNG (story)"}</button>
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
