"use client";

import Sidebar, { isCollapsibleRoute } from "./Sidebar";
import RefCapture from "./RefCapture";
import ReferralOnboarding from "./claims/ReferralOnboarding";
import HowItWorksHost from "./home/HowItWorksHost";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { IS_STATIC_PREVIEW } from "@/lib/base-path";
import { ACTIVE_CHAIN } from "@/lib/chains";

/** Robinhood Chain testnet. A plain "Test network" marker shows in the shell there (GAME play-test, Oct 26 2026). */
const TEST_NETWORK_ID = 46630;

// The wallet pill (viem, @noble/curves, AA session; ~140 KB of JS) is position:fixed chrome, so it loads in its own chunk
// after hydration instead of sitting in every page's first-load JS ahead of the LCP. Fixed positioning = no layout shift.
const WalletButton = dynamic(() => import("./WalletButton"), { ssr: false });

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isGame = isCollapsibleRoute(pathname);
  return (
    <>
      <Sidebar />
      <RefCapture />
      <ReferralOnboarding />
      <HowItWorksHost />
      {!isGame && <div className="ap-topbar" aria-hidden="true" />}
      {/* Game routes are left out: the flight HUD owns that screen space (GAME's lane). */}
      {!isGame && ACTIVE_CHAIN.id === TEST_NETWORK_ID && <div className="ap-testnet" role="note">Test network</div>}
      <WalletButton compact={!isGame} />
      {isGame ? children : <div className="main-offset main-offset-open min-h-screen">{children}</div>}
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
