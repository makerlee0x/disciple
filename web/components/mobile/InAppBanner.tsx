"use client";
/**
 * "Open in Safari / Chrome" (maker, 2026-11-14 mobile first run): a slim bar at the top when the page is running inside an
 * app's own browser (X, Telegram, Instagram…). Google sign-in can't work there and sound/haptics are patchy, so we say so
 * once, offer the way out, and let the player carry on. Android: an intent link opens Chrome. iOS has no such link, so we
 * copy the page link and show where the app's "Open in browser" lives. Dismissed for the session.
 * Launch prep (maker, 2026-11-16, "play free version in x browser"): X traffic is mostly phones, so the bar no longer says
 * "open in Safari to play". It leads with a free duel that works right here (email and X sign-in work too), and the
 * browser switch is the quieter second option.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { chromeIntent, currentInApp, inAppName, isAndroid, type InAppKind } from "@/lib/inAppBrowser";

const KEY = "disciple.inapp.dismissed";

export default function InAppBanner() {
  const [kind, setKind] = useState<InAppKind>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let off = false;
    try { off = sessionStorage.getItem(KEY) === "1"; } catch { /* private mode */ }
    if (!off) setKind(currentInApp());
  }, []);
  const bar = useRef<HTMLDivElement>(null);
  // the bar sits over the top of the page: everything that clears the notch (--ap-safe-top: lobby bar, phone flight HUD)
  // clears the bar instead, in plain px so PhoneHud can read it
  useEffect(() => {
    const de = document.documentElement, el = bar.current;
    de.classList.toggle("in-app", !!kind);
    if (!kind || !el) return;
    const f = () => de.style.setProperty("--ap-safe-top", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    f(); const ro = new ResizeObserver(f); ro.observe(el);
    return () => { ro.disconnect(); de.classList.remove("in-app"); de.style.removeProperty("--ap-safe-top"); };
  }, [kind]);
  if (!kind) return null;
  const app = inAppName(kind);
  const android = isAndroid(navigator.userAgent);
  const browser = android ? "Chrome" : "Safari";
  const close = () => { try { sessionStorage.setItem(KEY, "1"); } catch { /* private mode */ } setKind(null); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(location.href); setCopied(true); setTimeout(() => setCopied(false), 2400); }
    catch { /* no clipboard: the hint still says where the menu is */ }
  };
  const intent = android ? chromeIntent(location.href) : null;
  return (
    <div ref={bar} className="iab" role="region" aria-label={`Open in ${browser}`} data-testid="inapp-banner">
      <div className="iab-t">
        <b>Play free right here</b>
        <span>{copied ? `Link copied. Paste it in ${browser}.` : <>Email and X sign-in work in {app}. For sound and Google, {intent ? <a href={intent}>open in {browser}</a> : <button type="button" className="iab-link" onClick={copy}>copy the link</button>}.</>}</span>
      </div>
      <Link className="iab-go" href="/turbo/duel?first=1" onClick={close} data-testid="inapp-play">Free duel</Link>
      <button type="button" className="iab-x" aria-label="Dismiss" onClick={close}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}
