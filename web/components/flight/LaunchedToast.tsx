"use client";
/**
 * "Your rocket is live" (launch funnel item 8, maker 2026-11-17). Right after a launch (Launch page → flight, still no
 * share screen in between) the flight fades in from the liftoff flash and a share card sits at the top: the rocket's
 * link preview card (/api/og/rocket), a ready-to-post X message, Share on X and Copy link. It never covers the trade bar
 * or takes focus, and closes itself after 3 s (maker 2026-11-20), held open while the pointer is on it or a warning
 * note shows. The same card opens from the creator's "first boosts" push (?share=1).
 * The link carries the creator's ?ref= for attribution only: invites and posts earn nothing (maker 2026-11-14).
 */
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { withBase } from "@/lib/base-path";
import { takeLaunchHandoff, type LaunchHandoff } from "@/lib/launchHandoff";
import { coinRefLink } from "@/lib/referral";
import { connectedAddress } from "@/lib/walletState";
import s from "./launchedToast.module.css";

/** The X post. Short, CT voice, link last so X shows the rocket's card. */
export const launchPost = (ticker: string, url: string) => `$${ticker} just lifted off on @disciplevip\n\nget aboard early 👇\n${url}`;

export const AUTO_CLOSE_MS = 3000;

export default function LaunchedToast({ token, share = false, ticker = null }: { token: string; share?: boolean; ticker?: string | null }) {
  const [h, setH] = useState<LaunchHandoff | null>(null);
  const [copied, setCopied] = useState(false);
  const took = useRef(false);   // the note is read once, so React's dev double-effect can't lose it

  useEffect(() => {
    if (took.current) return;
    took.current = true;
    const note = takeLaunchHandoff(token);
    if (note) { setH(note); return; }
    // from the first-boosts push: same card, no arrival fade
    if (share && ticker) setH({ name: ticker, ticker: ticker.replace(/^\$/, "").toUpperCase(), mode: "", note: null, at: 0 });
  }, [token, share, ticker]);

  // ?r=<username> on the share link (maker 2026-11-20); the wallet stands in until the name loads or when there is none
  const [uname, setUname] = useState<string | null>(null);
  useEffect(() => {
    const a = connectedAddress();
    if (!h || !a) return;
    let alive = true;
    fetch(withBase(`/api/profile/username?address=${a.toLowerCase()}`)).then((r) => (r.ok ? r.json() : null))
      .then((j: { username?: string | null } | null) => { if (alive && j?.username) setUname(j.username); }).catch(() => undefined);
    return () => { alive = false; };
  }, [h]);
  // auto-close after 3 s (maker 2026-11-20); hovering holds it open so Post it / Copy link stay reachable; a warning note stays
  const [hold, setHold] = useState(false);
  useEffect(() => {
    if (!h || h.note || hold) return;
    const t = window.setTimeout(() => setH(null), AUTO_CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [h, hold]);

  if (!h) return null;
  // blur after a click so Space / Enter keep flying the rocket instead of pressing the button again
  const done = (e: MouseEvent<HTMLButtonElement>) => e.currentTarget.blur();
  const url = coinRefLink(token, uname, connectedAddress(), window.location.origin + withBase(""));
  const post = launchPost(h.ticker, url);
  const toX = () => window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(post)}`, "_blank", "noopener,noreferrer");
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked */ }
  };

  return (
    <>
      {h.at > 0 && <div className={s.arrive} aria-hidden data-testid="launch-arrive" />}
      <div className={s.toast} role="status" data-testid="launched-toast" onPointerEnter={() => setHold(true)} onPointerLeave={() => setHold(false)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={s.card} src={withBase(`/api/og/rocket?coin=${token.toLowerCase()}`)} alt="" decoding="async" />
        <div className={s.body}>
          <div className={s.top}>
            <span className={s.live}>Live</span>
            <b className={s.t}>${h.ticker} is flying</b>
            <button type="button" className={s.close} onClick={() => setH(null)} aria-label="Close" tabIndex={-1}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </div>
          {h.note && <p className={s.note} role="alert">{h.note}</p>}
          <p className={s.post} data-testid="launched-post">{post}</p>
          <div className={s.acts}>
            <button type="button" className={s.x} onClick={(e) => { done(e); toX(); }} data-testid="share-x" tabIndex={-1}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M17.5 3h3.2l-7 8 8.3 10h-6.5l-5-6.2L4.8 21H1.6l7.5-8.6L1.2 3h6.6l4.6 5.7L17.5 3z" /></svg>
              Post it
            </button>
            <button type="button" className={s.btn} onClick={(e) => { done(e); void copy(); }} data-testid="copy-link" tabIndex={-1}>{copied ? "Copied" : "Copy link"}</button>
          </div>
        </div>
      </div>
    </>
  );
}
