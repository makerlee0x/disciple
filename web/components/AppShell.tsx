"use client";

import Sidebar, { isCollapsibleRoute } from "./Sidebar";
import LobbyTopBar from "./LobbyTopBar";
import RefCapture from "./RefCapture";
import HowItWorksHost from "./home/HowItWorksHost";
import TouchKit from "./TouchKit";
import InviteBanner from "./invites/InviteBanner";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { NATIVE_UA_TAG } from "@/lib/native";
import { IS_STATIC_PREVIEW } from "@/lib/base-path";

// The wallet pill (viem, @noble/curves, AA session; ~140 KB of JS) is position:fixed chrome, so it loads in its own chunk
// after hydration instead of sitting in every page's first-load JS ahead of the LCP. Fixed positioning = no layout shift.
// Until that chunk lands, a quiet placeholder holds the Sign in / pilot chip slot so the top bar never shows a gap
// (phones: Sign in used to pop in a beat after Play now). A returning player (html[data-you], root layout) gets the signed-in
// strip itself, drawn with the same classes and filled before the first paint from the pill saved last time (root layout
// YOU_JS sets --pp-cash / --pp-name / --pp-lv / --pp-img), so cash, name, level and picture are there at once (maker 2026-11-18).
const WalletSlot = () => (
  <div aria-hidden className="wb-root wb-slot" data-compact="true">
    <div className="wb-row">
      <span className="wb-skel wb-skel-out" />
      <span className="wb-pilot wb-pp">
        <span className="wb-pfp pp-av" />
        <span className="wb-id"><span className="wb-name pp-name" /><span className="wb-bal">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /></svg>
          <b className="pp-cash" />
        </span></span>
        <b className="wb-lv pp-lv" />
        <svg className="wb-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M6 9l6 6 6-6" /></svg>
      </span>
    </div>
  </div>
);
const WalletButton = dynamic(() => import("./WalletButton"), { ssr: false, loading: WalletSlot });
// Funnel counter beacon (lib/funnelClient): client-only, own chunk, fails silently.
const FunnelBeacon = dynamic(() => import("./FunnelBeacon"), { ssr: false });
// Referral deposit sheet (viem + the claims contracts): an overlay that only shows after a referral link, so it loads after
// hydration in its own chunk (mobile plan speed fix 1), not in every page's first-load JS.
const ReferralOnboarding = dynamic(() => import("./claims/ReferralOnboarding"), { ssr: false });
// The Cash popup (round 2 "Cash" board): opened by any cash link (lib/cashLink OPEN_CASH_EVENT). Its body loads on open.
const CashHost = dynamic(() => import("./cash/CashHost"), { ssr: false });
// Phone first run (maker, 2026-11-14): app-browser banner, pick-a-rocket coach / throttle intro / $0 card / first boost,
// and the Add to Home Screen sheet. Client-only, own chunks, nothing until they have something to show.
const InAppBanner = dynamic(() => import("./mobile/InAppBanner"), { ssr: false });
const FirstRunHost = dynamic(() => import("./mobile/FirstRunHost"), { ssr: false });
const WelcomeIntro = dynamic(() => import("./mobile/WelcomeIntro"), { ssr: false });
const InstallPrompt = dynamic(() => import("./mobile/InstallPrompt"), { ssr: false });

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isGame = isCollapsibleRoute(pathname);
  // Trading Duel + Turbo Royale show their own fuel in the HUD; the wallet pill sat on top of the duel title, rating, clock
  // and PnL on phones (app audit 2026-11-15). Kept mounted (sign-in, wallet id events), just not drawn.
  const hideWallet = /^\/turbo\/(duel|royale)(\/|$)/.test(pathname ?? "");
  // html.app (root layout APP_JS) is set before paint, but a page that calls notFound() re-renders the root <html> on the
  // client and React writes its className back without it: the website's 4-tab bar and Play now then showed in the app.
  // Put it back whenever anything rewrites the class.
  useEffect(() => {
    if (!navigator.userAgent.includes(NATIVE_UA_TAG)) return;
    const html = document.documentElement;
    const keep = () => { if (!html.classList.contains("app")) html.classList.add("app"); };
    keep();
    const mo = new MutationObserver(keep);
    mo.observe(html, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  // /duel: the duel-only demo page (maker 2026-11-16, for the Nova team). Nothing but the duel: no nav, wallet, banners or
  // first-run sheets.
  if (/^\/duel(\/|$)/.test(pathname ?? "")) return <>{children}</>;
  return (
    <>
      {hideWallet && <style>{".wb-root{display:none!important}"}</style>}
      {/* brand v3: game routes keep the sidebar rail; every other route gets the lobby tab bar */}
      {isGame ? <Sidebar /> : <LobbyTopBar />}
      <RefCapture />
      <ReferralOnboarding />
      <HowItWorksHost />
      <CashHost />
      {!IS_STATIC_PREVIEW && <InAppBanner />}
      {!IS_STATIC_PREVIEW && <FirstRunHost />}
      {!IS_STATIC_PREVIEW && <WelcomeIntro />}
      {!IS_STATIC_PREVIEW && <InstallPrompt />}
      {/* the plain "Test network" marker lives in the wallet strip (WalletButton), so it shows on every route incl. the game */}
      {!isGame && !IS_STATIC_PREVIEW && <InviteBanner />}
      {/* profile r3: no cash pill on a profile (the page's portfolio block shows Cash); every other route unchanged */}
      <WalletButton compact={!isGame} />
      <FunnelBeacon />
      <TouchKit />
      {isGame ? children : <div className="main-offset main-offset-lobby min-h-screen">{children}</div>}
      {IS_STATIC_PREVIEW && (
        <div
          aria-label="Static preview"
          style={{
            position: "fixed",
            right: 10,
            bottom: 10,
            zIndex: 9999,
            padding: "4px 8px",
            borderRadius: 8,
            fontSize: 10,
            letterSpacing: ".08em",
            color: "#0B0C0E",
            background: "rgba(201,206,214,.92)",
            border: "1px solid rgba(201,206,214,.8)",
            boxShadow: "0 2px 12px rgba(0,0,0,.35)",
            pointerEvents: "none",
          }}
        >
          Static preview
        </div>
      )}
    </>
  );
}
