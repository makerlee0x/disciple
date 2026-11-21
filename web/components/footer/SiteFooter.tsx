/**
 * Site footer (maker 2026-11-20): every website page outside the game routes (coin flight, Turbo) gets it. Left: the site's
 * pages. Middle: "Built by Strategy Coin" with their white mark, linked to strategycoin.io. Right: help pages and X.
 * Bottom row: © line and the legal pages. Links only, no explainer copy (CLAUDE.md copy rule).
 * The iPhone app hides it (.app-web): the app has its own tab dock and Settings, and an app screen has no web footer.
 */
import Link from "next/link";
import { CLIMB_HREF, DUEL_HREF, MARKET_ENABLED } from "@/lib/features";
import s from "./footer.module.css";

type L = { href: string; label: string };

const PLAY: readonly L[] = [
  { href: "/create", label: "Launch" },
  { href: DUEL_HREF, label: "Duel" },
  { href: CLIMB_HREF, label: "Climb" },
  ...(MARKET_ENABLED ? [{ href: "/market", label: "Market" }] : []),
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/profile", label: "Hangar" },
];

const HELP: readonly L[] = [
  { href: "/how-it-works", label: "How to play" },
  { href: "/docs", label: "Docs" },
  { href: "/security", label: "Security" },
];

const LEGAL: readonly L[] = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/risk", label: "Risk" },
  { href: "/support", label: "Support" },
];

export const X_URL = "https://x.com/disciplevip";
const STRATEGY_URL = "https://www.strategycoin.io/";

function XMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export default function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className={`${s.foot} app-web`} data-testid="site-footer">
      <div className={s.top}>
        <nav className={s.links} aria-label="Play">
          {PLAY.map((l) => <Link key={l.href} href={l.href}>{l.label}</Link>)}
        </nav>
        <a className={s.built} href={STRATEGY_URL} target="_blank" rel="noopener noreferrer" data-testid="footer-strategy">
          <span>Built by</span>
          {/* eslint-disable-next-line @next/next/no-img-element -- 2.6 KB white mark, no optimizer needed */}
          <img src="/brand/strategy-coin-white.png" alt="" width={32} height={22} />
          <b>Strategy Coin</b>
        </a>
        <nav className={`${s.links} ${s.end}`} aria-label="Help">
          {HELP.map((l) => <Link key={l.href} href={l.href}>{l.label}</Link>)}
          <a className={s.x} href={X_URL} target="_blank" rel="noopener noreferrer" aria-label="DISCIPLE on X" data-testid="footer-x">
            <XMark />
          </a>
        </nav>
      </div>
      <div className={s.base}>
        <span>© {year} DISCIPLE</span>
        <nav className={s.legal} aria-label="Legal">
          {LEGAL.map((l) => <Link key={l.href} href={l.href}>{l.label}</Link>)}
        </nav>
      </div>
    </footer>
  );
}
