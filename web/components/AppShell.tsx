"use client";

import Sidebar, { isCollapsibleRoute } from "./Sidebar";
import LobbyTopBar from "./LobbyTopBar";
import RefCapture from "./RefCapture";
import HowItWorksHost from "./home/HowItWorksHost";
import TouchKit from "./TouchKit";
import InviteBanner from "./invites/InviteBanner";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { IS_STATIC_PREVIEW } from "@/lib/base-path";

// The wallet pill (viem, @noble/curves, AA session; ~140 KB of JS) is position:fixed chrome, so it loads in its own chunk
// after hydration instead of sitting in every page's first-load JS ahead of the LCP. Fixed positioning = no layout shift.
// Until that chunk lands, a quiet placeholder holds the Sign in / pilot chip slot so the top bar never shows a gap
// (phones: Sign in used to pop in a beat after Play now). It can't know yet whether you're signed in, so it's a blank pill.
const WalletButton = dynamic(() => import("./WalletButton"), {
  ssr: false,
  loading: () => <div aria-hidden className="wb-root wb-slot" data-compact="true"><div className="wb-row"><span className="wb-skel" /></div></div>,
});
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
const InstallPrompt = dynamic(() => import("./mobile/InstallPrompt"), { ssr: false });

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isGame = isCollapsibleRoute(pathname);
  return (
    <>
      {/* brand v3: game routes keep the sidebar rail; every other route gets the lobby tab bar */}
      {isGame ? <Sidebar /> : <LobbyTopBar />}
      <RefCapture />
      <ReferralOnboarding />
      <HowItWorksHost />
      <CashHost />
      {!IS_STATIC_PREVIEW && <InAppBanner />}
      {!IS_STATIC_PREVIEW && <FirstRunHost />}
      {!IS_STATIC_PREVIEW && <InstallPrompt />}
      {/* the plain "Test network" marker lives in the wallet strip (WalletButton), so it shows on every route incl. the game */}
      {!isGame && !IS_STATIC_PREVIEW && <InviteBanner />}
      {/* profile r3: no cash pill on a profile (the page's portfolio block shows Cash); every other route unchanged */}
      <WalletButton compact={!isGame} hideCash={/^\/(profile|u\/)/.test(pathname ?? "")} />
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
