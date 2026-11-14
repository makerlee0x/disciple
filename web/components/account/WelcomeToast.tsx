"use client";
/**
 * "You're in, pilot" (step 5 board, maker 2026-11-13): once, right after a pilot signs in on this browser for the first
 * time, a gold toast points at cash. Add cash opens the Cash popup; Later or 8 seconds closes it.
 */
import { useEffect, useState } from "react";
import { openCash } from "@/lib/cashLink";
import { SIGN_IN_COPY } from "@/lib/walletCta";
import { levelInfo } from "@/lib/xp";
import { useXp } from "@/lib/xpClient";

const PENDING = "disciple.signin.pending";
const SEEN = "disciple.welcomed.v1";
/** Fired when a top-bar popover opens (help card, pilot menu): the toast steps aside so they never stack. */
export const TOPBAR_POPOVER_EVENT = "disciple:topbar-popover";
/** Mark that this tab just started a sign-in (the toast only follows a real sign-in, never a restored session). */
export function markSignInStarted() { try { sessionStorage.setItem(PENDING, "1"); } catch { /* private mode */ } }

export default function WelcomeToast({ wallet }: { wallet: string | null }) {
  const [show, setShow] = useState(false);
  const { xp } = useXp(wallet);
  useEffect(() => {
    if (!wallet) return;
    try {
      if (sessionStorage.getItem(PENDING) !== "1") return;
      sessionStorage.removeItem(PENDING);
      const seen = JSON.parse(localStorage.getItem(SEEN) || "[]") as string[];
      const k = wallet.toLowerCase();
      if (seen.includes(k)) return;
      localStorage.setItem(SEEN, JSON.stringify([...seen, k].slice(-20)));
      setShow(true);
    } catch { /* storage blocked: no toast */ }
  }, [wallet]);
  useEffect(() => {
    if (!show) return;
    const t = setTimeout(() => setShow(false), 8000);
    const hide = () => setShow(false);
    addEventListener(TOPBAR_POPOVER_EVENT, hide);
    return () => { clearTimeout(t); removeEventListener(TOPBAR_POPOVER_EVENT, hide); };
  }, [show]);
  if (!show) return null;
  const L = xp?.level ?? levelInfo(0);
  return (
    <div className="am-toast" role="status" data-testid="welcome-toast">
      <span className="am-tring" aria-hidden>{L.level}</span>
      <div className="am-tbody">
        <b>{SIGN_IN_COPY.welcomeTitle}</b>
        <span>{SIGN_IN_COPY.welcomeBody}</span>
        <div className="am-tacts">
          <button type="button" className="r2-gold" onClick={() => { setShow(false); openCash("add"); }}>{SIGN_IN_COPY.addCash}</button>
          <button type="button" className="r2-btn" onClick={() => setShow(false)}>{SIGN_IN_COPY.later}</button>
        </div>
      </div>
    </div>
  );
}
