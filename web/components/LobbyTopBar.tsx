"use client";

/**
 * Brand v3 app shell for non-game routes: a game-lobby tab bar across the top instead of the left sidebar
 * (docs/brand-v3.md, direction doc "App shell"). Game routes (/coin, /flight) keep the Sidebar rail unchanged.
 * The wallet pill (WalletButton, position:fixed top-right) stays where it is; this bar leaves room for it.
 * Desktop: one row (mark, tabs, then the wallet pill's space). Phones: the mark row, then the tabs scroll sideways.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { aaSession, hasSavedSession, onPrivy, onSessionChange, privyAuthenticated, privyLoaded } from "@/lib/aa/sessionState";
import { WALLET_ID_EVENT, walletId } from "@/lib/walletCta";
import LevelChip from "@/components/xp/LevelChip";
import Icon, { type IconName } from "@/components/icons/Icon";

// icons show only in the phone bottom tab bar (≤760px, mobile plan option A); desktop keeps the text tabs
// you: signed-in only. outPhone: on phones, signed-out only (round 2 Quick help board: How to play is the 4th phone tab
// for signed-out pilots; signed-in phones keep their five tabs).
type Tab = { href: string; key: string; label: string; icon: IconName; you?: boolean; outPhone?: boolean };

const TABS: readonly Tab[] = [
  { href: "/", key: "lobby", label: "Lobby", icon: "home" },
  { href: "/create", key: "launch", label: "Launch", icon: "rocket" },
  { href: "/profile", key: "hangar", label: "Hangar", icon: "pilot", you: true },
  { href: "/leaderboard", key: "leader", label: "Leaderboard", icon: "leaderboard" },
  { href: "/achievements", key: "trophies", label: "Trophies", icon: "achievement", you: true },
  { href: "/how-it-works", key: "hiw", label: "How to play", icon: "info", outPhone: true },
];

export default function LobbyTopBar() {
  const pathname = usePathname() ?? "/";
  const [you, setYou] = useState(false);
  useEffect(() => {
    // until Privy has loaded, a saved session counts as signed in (no Play now / missing tabs flash for players)
    const sync = () => setYou(privyAuthenticated() || !!aaSession() || !!walletId()?.address || (!privyLoaded() && hasSavedSession()));
    sync();
    const a = onPrivy(sync), b = onSessionChange(sync);
    addEventListener(WALLET_ID_EVENT, sync);
    return () => { a(); b(); removeEventListener(WALLET_ID_EVENT, sync); };
  }, []);

  // The shell's body class: main-offset drops the sidebar padding and reserves this bar's height instead.
  useEffect(() => {
    document.body.classList.add("lobby");
    return () => document.body.classList.remove("lobby");
  }, []);

  const isOn = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  const tabs = TABS.filter((t) => !t.you || you);

  return (
    <header className={`lb-bar${you ? "" : " lb-out"}`} data-testid="lobby-topbar">
      <Link href="/" className="lb-brand" aria-label="DISCIPLE lobby">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="lb-lockup" src="/brand/disciple-lockup-horizontal-light.svg" alt="DISCIPLE" width={141} height={30} />
      </Link>
      <nav className="lb-tabs" aria-label="Main">
        {tabs.map((t) => (
          <Link key={t.key} href={t.href} className={`${isOn(t.href) ? "on" : ""}${t.outPhone ? " lb-outphone" : ""}`} aria-current={isOn(t.href) ? "page" : undefined} data-testid={t.key === "hiw" ? "topbar-hiw" : undefined}>
            <Icon name={t.icon} size={22} className="lb-ico" />
            <span className="lb-lbl">{t.label}</span>
          </Link>
        ))}
      </nav>
      {!you && (
        <Link href="/play" prefetch={false} className="lb-playnow" data-testid="topbar-play">Play now</Link>
      )}
      <LevelChip toastOnly />
    </header>
  );
}
