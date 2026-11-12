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
import { aaSession, onPrivy, onSessionChange, privyAuthenticated } from "@/lib/aa/session";
import { WALLET_ID_EVENT, walletId } from "@/lib/walletCta";
import LevelChip from "@/components/xp/LevelChip";

type Tab = { href: string; key: string; label: string; you?: boolean };

const TABS: readonly Tab[] = [
  { href: "/", key: "lobby", label: "Lobby" },
  { href: "/create", key: "launch", label: "Launch" },
  { href: "/profile", key: "hangar", label: "Hangar", you: true },
  { href: "/leaderboard", key: "leader", label: "Leaderboard" },
  { href: "/achievements", key: "trophies", label: "Trophies" },
];

export default function LobbyTopBar() {
  const pathname = usePathname() ?? "/";
  const [you, setYou] = useState(false);
  useEffect(() => {
    const sync = () => setYou(privyAuthenticated() || !!aaSession() || !!walletId()?.address);
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
    <header className="lb-bar" data-testid="lobby-topbar">
      <Link href="/" className="lb-brand" aria-label="DISCIPLE lobby">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/disciple-mark-light.svg" alt="" width={28} height={28} />
        <span className="lb-word">DISCIPLE</span>
      </Link>
      <nav className="lb-tabs" aria-label="Main">
        {tabs.map((t) => (
          <Link key={t.key} href={t.href} className={isOn(t.href) ? "on" : ""} aria-current={isOn(t.href) ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
        <button type="button" className="lb-tab-btn" aria-haspopup="dialog" data-testid="topbar-hiw"
          onClick={() => window.dispatchEvent(new Event("dsc:hiw"))}>
          How to play
        </button>
      </nav>
      <LevelChip />
    </header>
  );
}
