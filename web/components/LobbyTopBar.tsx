"use client";

/**
 * Brand v3 app shell for non-game routes: a game-lobby tab bar across the top instead of the left sidebar
 * (docs/brand-v3.md, direction doc "App shell"). Game routes (/coin, /flight) keep the Sidebar rail unchanged.
 * The wallet pill (WalletButton, position:fixed top-right) stays where it is; this bar leaves room for it.
 * Desktop: one row (mark, tabs, then the wallet pill's space). Phones: the mark row, then the tabs scroll sideways.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { haptic } from "@/lib/game/haptics";
import { aaSession, hasSavedSession, onPrivy, onSessionChange, privyAuthenticated, privyLoaded } from "@/lib/aa/sessionState";
import { WALLET_ID_EVENT, walletId } from "@/lib/walletCta";
import LevelChip from "@/components/xp/LevelChip";
import Icon, { type IconName } from "@/components/icons/Icon";
import HelpButton from "@/components/HelpButton";
import SiteSearch from "@/components/search/SiteSearch";
import { QUICK_PLAY_EVENT } from "@/components/app/events";
import { FLIGHTS_HREF, MARKET_ENABLED } from "@/lib/features";
import { isTurboEnabled, turboEnvOn } from "@/lib/turbo/flag";

// Nav rework (maker 2026-11-16, order 2026-11-18): the DISCIPLE mark is the way to the lobby, so there is no Lobby tab.
// Desktop tabs: Turbo (the Turbo page, where Duel and Climb start; maker 2026-11-20 "no more dropdown"), Market (MARKET_ENABLED), Top pilots, Hangar. Launch is not a desktop tab
// (maker 2026-11-18): the gold LAUNCH NOW button on the right opens the launch flow. Signed in on narrow desktops (≤1024px)
// the button is hidden for room, so the Launch tab comes back there (lb-launch-tab, CSS). Phones keep Launch first in the
// bottom tab bar, then Turbo, Market, Top pilots, Hangar (signed-out phones get How to play there). Live flights is out of
// the bar (maker 2026-11-18); /live still works. How to play is also the "?" (HelpButton).
// Turbo shows for everyone now (lib/turbo/flag.ts, on since 2026-11-16).
// icons show only in the phone bottom tab bar (≤760px); desktop keeps the text tabs.
// phone: phone bottom bar only. desk: desktop top bar only. you: signed-in only. out: signed-out only. menu: the Turbo tab (Turbo flag; lit on every /turbo route).
type Tab = { href: string; key: string; label: string; short?: string; icon: IconName; phone?: boolean; desk?: boolean; you?: boolean; out?: boolean; menu?: boolean; cls?: string };

const TABS: readonly Tab[] = [
  { href: "/create", key: "launch", label: "Launch", icon: "rocket", phone: true },
  { href: "/create", key: "launch", label: "Launch", icon: "rocket", desk: true, cls: "lb-launch-tab" },
  { href: "/turbo", key: "turbo", label: "Turbo", icon: "bolt", menu: true },
  ...(MARKET_ENABLED ? [{ href: "/market", key: "market", label: "Market", icon: "grid" } as Tab] : []),
  { href: "/leaderboard", key: "leader", label: "Leaderboard", short: "Leaderboard", icon: "leaderboard" },
  { href: "/profile", key: "hangar", label: "Hangar", icon: "pilot", desk: true },
  { href: "/profile", key: "hangar", label: "Hangar", icon: "pilot", phone: true, you: true },
  { href: "/how-it-works", key: "hiw", label: "How to play", icon: "info", phone: true, out: true },
];


// The iPhone app's own tab bar (app home concept C, maker 2026-11-16): Top pilots, Play (the app home, big in the middle) and
// Hangar on the right (maker 2026-11-17). Shown only with html.app (root layout APP_JS); the website's bars are hidden there. Launch lives on the Play tab.
const APP_TABS: readonly Tab[] = [
  { href: "/leaderboard", key: "leader", label: "Leaderboard", icon: "leaderboard" },
  { href: "/", key: "play", label: "Play", icon: "rocket" },
  { href: "/profile", key: "hangar", label: "Hangar", icon: "pilot" },
];

export default function LobbyTopBar() {
  const pathname = usePathname() ?? "/";
  const [you, setYou] = useState(false);
  useEffect(() => {
    // until Privy has loaded, a saved session counts as signed in (no Launch now / missing tabs flash for players)
    // html[data-you] drives the signed-in / signed-out layout in CSS: the root layout's YOU_JS sets it before the first
    // paint from the same saved session, so the bar doesn't paint signed out and then jump (maker 2026-11-18)
    const sync = () => {
      const v = privyAuthenticated() || !!aaSession() || !!walletId()?.address || (!privyLoaded() && hasSavedSession());
      document.documentElement.toggleAttribute("data-you", v);
      setYou(v);
    };
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

  // phones: hide the bottom tab bar while typing. With the iOS keyboard up, fixed bars ride up into the page and the
  // header scrolls away (maker 2026-11-13: "it floated all the way up to the top")
  useEffect(() => {
    const field = (t: EventTarget | null) => t instanceof HTMLElement && (t.matches("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]), textarea, select") || t.isContentEditable);
    const on = (e: FocusEvent) => { if (field(e.target)) document.documentElement.classList.add("lb-typing"); };
    const off = () => { window.setTimeout(() => { if (!field(document.activeElement)) document.documentElement.classList.remove("lb-typing"); }, 50); };
    addEventListener("focusin", on); addEventListener("focusout", off);
    return () => { removeEventListener("focusin", on); removeEventListener("focusout", off); document.documentElement.classList.remove("lb-typing"); };
  }, []);

  // Tab bar taps feel instant (maker 2026-11-16: "there's a delay when you press the buttons footer"): the tapped tab
  // lights up on touch, before the next page has rendered, and the tab pages are prefetched up front so the switch
  // itself has nothing to wait for. The app dock also navigates on touch-down, like a native tab bar.
  const router = useRouter();
  const [pressed, setPressed] = useState<string | null>(null);
  const pushedOnDown = useRef<string | null>(null);
  useEffect(() => { setPressed(null); }, [pathname]);
  useEffect(() => {
    const t = window.setTimeout(() => { for (const h of ["/", FLIGHTS_HREF, "/profile", "/leaderboard", "/create"]) { try { router.prefetch(h); } catch { /* ignore */ } } }, 600);
    return () => window.clearTimeout(t);
  }, [router]);
  const at = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  const isOn = (href: string) => (pressed != null ? pressed === href : at(href));
  const press = (href: string) => { if (!at(href)) setPressed(href); };

  // Turbo: the localStorage part of the flag is read after mount (server and first paint match)
  const [turbo, setTurbo] = useState(turboEnvOn);   // on in this build: the tab is in the first paint (no pop-in)
  useEffect(() => { setTurbo(isTurboEnabled()); }, []);
  const turboOn = pathname.startsWith("/turbo");

  const nav = (dock: boolean) => (
    <nav className={`lb-tabs${dock ? " lb-dock" : " lb-top"}`} aria-label="Main">
      {/* signed-in / signed-out tabs are both rendered and shown by html[data-you] (CSS), so they never pop in after load */}
      {TABS.filter((t) => (dock ? !t.desk : !t.phone) && (!t.menu || turbo)).map((t) => (
        <Link key={t.key} href={t.href} className={[(t.menu ? turboOn : isOn(t.href)) ? "on" : "", t.you ? "lb-you-only" : "", t.out ? "lb-out-only" : "", t.cls ?? ""].filter(Boolean).join(" ") || undefined} aria-current={at(t.href) ? "page" : undefined}
          onPointerDown={dock ? () => press(t.href) : undefined} data-testid={`nav-${t.key}`}>
          <Icon name={t.icon} size={22} className="lb-ico" />
          <span className="lb-lbl">{dock && t.short ? t.short : t.label}</span>
        </Link>
      ))}
    </nav>
  );

  return (<>
    <header className="lb-bar" data-testid="lobby-topbar">
      <Link href="/" className="lb-brand" aria-label="DISCIPLE lobby">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="lb-lockup" src="/brand/disciple-lockup-horizontal-light.svg" alt="DISCIPLE" width={141} height={30} />
      </Link>
      {nav(false)}
      {/* site search (maker 2026-11-19): a field on wide desktops, a magnifier that opens a full-screen search elsewhere */}
      <SiteSearch />
      {!you && <HelpButton className="lb-help-out" />}
      <Link href="/create" className="lb-playnow" data-testid="topbar-launch" data-sfx="primary">Launch now</Link>
      <LevelChip toastOnly />
    </header>
    {/* phones: the bottom tab bar lives outside the header, so nothing about the header (scroll, compositing) can move it */}
    {nav(true)}
    <nav className="lb-tabs lb-dock lb-appdock" aria-label="Main">
      {APP_TABS.map((t) => (
        <Link key={t.key} href={t.href} className={`${t.key === "play" ? "lb-play " : ""}${isOn(t.href) ? "on" : ""}`.trim() || undefined}
          aria-current={at(t.href) ? "page" : undefined} data-testid={`app-tab-${t.key}`}
          onPointerDown={(e) => {
            if (e.button !== 0 || (t.key === "play" && pathname === "/") || at(t.href)) return;
            haptic("tap", true); press(t.href); pushedOnDown.current = t.href; router.push(t.href);
          }}
          onClick={(e) => {
            if (t.key === "play" && pathname === "/") { e.preventDefault(); dispatchEvent(new Event(QUICK_PLAY_EVENT)); return; }
            // already on its way from the touch-down: don't navigate twice
            if (pushedOnDown.current === t.href) { e.preventDefault(); pushedOnDown.current = null; }
          }}>
          <Icon name={t.icon} size={t.key === "play" ? 26 : 22} className="lb-ico" />
          <span className="lb-lbl">{t.label}</span>
        </Link>
      ))}
    </nav>
  </>);
}
