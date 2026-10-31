"use client";

/**
 * App navigation, premium-ui-r1 (BRAND mockups/premium-ui-r1, DIRECTION.md "Sidebar"):
 * one silver "Launch a Rocket" button on top, six places in two groups (Launchpad / Leaderboard / Achievements, then
 * You: Profile / Your rockets / Wallet), How it works near the bottom, and who you are at the bottom (picture, name,
 * guild tag, settings) or, signed out, one "Join the war" card with one Sign in button. Sign out lives in Settings.
 * Game routes collapse to the 64px rail (silver + for Launch). Phones: a drawer; Launch sits in the top bar.
 * Upgrade Rocket is hidden from the menu until it does something (the /rocket route stays).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { SETTINGS_KEYS } from "@/lib/config";
import { aaSession, onPrivy, onSessionChange, privyAuthenticated } from "@/lib/aa/session";
import Icon, { type IconName } from "@/components/icons/Icon";
import { GuildTagFor } from "@/components/guilds/GuildChip";
import { withBase } from "@/lib/base-path";
import { SETTINGS_HREF, onSettingsClick } from "@/lib/cashLink";
import { defaultUsername } from "@/lib/defaultUsername";
import { PROFILE_CHANGED_EVENT } from "@/lib/profile";
import { pfpUrl } from "@/lib/profileMeta";
import { fetchProfileMeta } from "@/lib/profileMetaClient";
import {
  SETTINGS_OPEN_EVENT, WALLET_CTA_CLICK_EVENT, WALLET_CTA_EVENT, WALLET_ID_EVENT, walletCtaLabel, walletId, type WalletId,
} from "@/lib/walletCta";

type NavItem = { href: string; key: string; label: string; icon: IconName };

const NAV: readonly NavItem[] = [
  { href: "/", key: "home", label: "Launchpad", icon: "home" },
  { href: "/leaderboard", key: "leader", label: "Leaderboard", icon: "leaderboard" },
  { href: "/achievements", key: "ach", label: "Achievements", icon: "achievement" },
];
/** "You" group: signed in only (nothing of yours to show signed out). Upgrade Rocket (/rocket) is hidden, not deleted. */
const NAV_YOU: readonly NavItem[] = [
  { href: "/profile", key: "profile", label: "Profile", icon: "profile" },
  // Copy pending lee approval: "Your rockets"
  { href: "/creator", key: "creator", label: "Your rockets", icon: "rocket" },
  // Copy pending lee approval: "Wallet"
  { href: "/wallet", key: "wallet", label: "Wallet", icon: "wallet" },
];

// Copy pending lee approval: "You" (group label)
const YOU_LABEL = "You";
// Copy pending lee approval: "Join the war" (signed-out card title, from the r1 mock)
const JOIN_TITLE = "Join the war";
// Copy pending lee approval: signed-out line (lee's approved sign-in line, as edited in home-r2/CHANGES.md)
const JOIN_LINE = "Sign in with email, Google, X or wallet to BOOST, DUMP and launch.";
// Copy pending lee approval: "How it works" (replaces "Help")
const HIW_LABEL = "How it works";
// Copy pending lee approval: "Launch" (phone top-bar button)
const PHONE_LAUNCH = "Launch";

/** Only chart / flight (game) routes may collapse the sidebar. Launchpad, create, profile,
 * leaderboard, achievements etc. are always expanded on desktop (mobile keeps a drawer). */
export function isCollapsibleRoute(pathname: string) {
  return pathname.startsWith("/coin/") || pathname.startsWith("/flight");
}

const isMobile = () => typeof window !== "undefined" && window.matchMedia("(max-width:760px)").matches;

/** The account's picture (profile meta), else its initial. Real data only: no sample picture. */
function Avatar({ address, name, size }: { address: string; name: string; size: number }) {
  const [img, setImg] = useState("");
  useEffect(() => {
    let alive = true;
    const load = () => { fetchProfileMeta(address).then((m) => { if (alive) setImg(pfpUrl(m.pfp)); }).catch(() => {}); };
    load();
    addEventListener(PROFILE_CHANGED_EVENT, load);
    return () => { alive = false; removeEventListener(PROFILE_CHANGED_EVENT, load); };
  }, [address]);
  return (
    <span className="ap-av" style={{ width: size, height: size }} aria-hidden="true">
      {img
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={withBase(img)} alt="" width={size} height={size} />
        : <span className="ap-av-in">{(name.replace(/^@/, "")[0] || "?").toUpperCase()}</span>}
    </span>
  );
}

export default function Sidebar({ forceCollapsed }: { forceCollapsed?: boolean }) {
  const pathname = usePathname();
  const isGame = isCollapsibleRoute(pathname);
  const storageKey = isGame ? SETTINGS_KEYS.sidebarGame : SETTINGS_KEYS.sidebarHome;

  const [open, setOpen] = useState(!isGame);
  const [ready, setReady] = useState(false);
  // Sign out only while signed in: false until Privy reports ready+authenticated (or a session exists), so no flash on load
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    const sync = () => setSignedIn(privyAuthenticated() || !!aaSession());
    sync();
    const a = onPrivy(sync), b = onSessionChange(sync);
    return () => { a(); b(); };
  }, []);
  // The wallet pill's signed-out action ("Play" / "Sign in") also runs from the Sidebar's Sign in card (see lib/walletCta.ts).
  const [cta, setCta] = useState<string | null>(null);
  useEffect(() => {
    setCta(walletCtaLabel());
    const f = (e: Event) => setCta((e as CustomEvent<{ label: string | null }>).detail?.label ?? null);
    window.addEventListener(WALLET_CTA_EVENT, f);
    return () => window.removeEventListener(WALLET_CTA_EVENT, f);
  }, []);
  // Who you are (address + claimed name), published by the wallet pill.
  const [me, setMe] = useState<WalletId | null>(null);
  useEffect(() => {
    setMe(walletId());
    const f = (e: Event) => setMe((e as CustomEvent<WalletId | null>).detail ?? null);
    window.addEventListener(WALLET_ID_EVENT, f);
    return () => window.removeEventListener(WALLET_ID_EVENT, f);
  }, []);
  const hasMe = !!me?.address;
  const you = signedIn || hasMe;

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(storageKey);
    } catch {
      /* ignore */
    }
    const mobile = isMobile();
    let next = saved ? saved === "open" : !isGame;
    if (forceCollapsed) next = false;
    if (mobile && !saved) next = false;
    // Marketing / launchpad / profile routes: always expanded on desktop.
    if (!isGame && !mobile) next = true;
    setOpen(next);
    setReady(true);
  }, [storageKey, isGame, forceCollapsed]);

  useEffect(() => {
    if (!ready) return;
    document.body.classList.toggle("side-open", open);
    document.body.classList.toggle("game", isGame);
    document.body.classList.toggle("side-hidden", !open && isMobile());
    try {
      if (isGame) localStorage.setItem(storageKey, open ? "open" : "collapsed");
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent("apsidebar", { detail: { open } }));
    const t = setTimeout(() => window.dispatchEvent(new Event("resize")), 240);
    return () => clearTimeout(t);
  }, [open, ready, storageKey, isGame]);

  const toggle = useCallback((force?: boolean) => {
    if (!isGame && !isMobile()) return; // not collapsible here
    setOpen((o) => (typeof force === "boolean" ? force : !o));
  }, [isGame]);
  const canCollapse = isGame;
  /** Phones: the drawer closes once you pick something. */
  const closeIfMobile = useCallback(() => { if (isMobile()) setOpen(false); }, []);

  if (!ready) return null;

  const isOn = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  const navLink = (item: NavItem) => (
    <Link key={item.key} href={item.href} className={isOn(item.href) ? "on" : ""} title={item.label}
      aria-current={isOn(item.href) ? "page" : undefined} onClick={closeIfMobile}>
      <span className="ic"><Icon name={item.icon} size={20} /></span>
      <span className="lb">{item.label}</span>
    </Link>
  );
  const name = me ? (me.name ? me.name.replace(/^@/, "") : defaultUsername(me.address)) : "";
  // Settings: on game routes GAME's settings menu (SETTINGS_OPEN_EVENT, #149: sound etc., also signed out); elsewhere the
  // account Settings popup (/profile#settings, #216), which holds Sign out, so it shows signed in only.
  const showSettings = isGame || you;
  const settingsProps = isGame
    ? { onClick: () => { closeIfMobile(); window.dispatchEvent(new Event(SETTINGS_OPEN_EVENT)); } }
    : null;
  const settingsInner = (
    <>
      <span className="ic"><Icon name="settings" size={20} /></span>
      <span className="lb">Settings</span>
    </>
  );

  return (
    <>
      <aside id="apSide" className={open ? "" : "collapsed"} aria-label="Main menu">
        <div className="ap-brand">
          <Link href="/" className="ap-logo" aria-label="DISCIPLE home" onClick={closeIfMobile}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="ap-lockup" src="/brand/disciple-lockup-horizontal-light.svg" alt="DISCIPLE" width={176} height={45} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="ap-mark" src="/brand/disciple-mark-light.svg" alt="DISCIPLE" width={32} height={32} />
          </Link>
          <button
            type="button"
            className={`ap-tog${canCollapse ? "" : " ap-tog-mobile"}`}
            title="Collapse / expand menu"
            aria-label="Toggle menu"
            onClick={() => toggle()}
          >
            <span className="ap-tog-menu"><Icon name="menu" size={20} /></span>
            <span className="ap-tog-close"><Icon name="close" size={20} /></span>
          </button>
        </div>

        {/* One Launch button (the old nav item + winged promo card are gone); the silver + on the rail */}
        <Link href="/create" className={`ap-launch${isGame ? " ap-launch-game" : ""}`} title="Launch a Rocket"
          data-testid="side-launch" onClick={closeIfMobile}>
          <Icon name="plus" size={18} />
          <span className="lb">Launch a Rocket</span>
        </Link>

        <nav className="ap-nav" aria-label="Main">{NAV.map(navLink)}</nav>
        {you && (
          <nav className="ap-nav ap-nav-you" aria-label={YOU_LABEL}>
            <div className="ap-grp">{YOU_LABEL}</div>
            {NAV_YOU.map(navLink)}
          </nav>
        )}

        <div className="ap-spacer" />

        <div className="ap-foot">
          <button type="button" title={HIW_LABEL} aria-haspopup="dialog" data-testid="side-hiw"
            onClick={() => { closeIfMobile(); window.dispatchEvent(new Event("dsc:hiw")); }}>
            <span className="ic"><Icon name="info" size={20} /></span>
            <span className="lb">{HIW_LABEL}</span>
          </button>
          {showSettings && (settingsProps
            ? <button type="button" title="Settings" data-testid="side-settings" aria-haspopup="dialog"
                className={`ap-set${hasMe ? " has-me" : ""}`} {...settingsProps}>{settingsInner}</button>
            : <Link href={SETTINGS_HREF} title="Settings" data-testid="side-settings"
                className={`ap-set${hasMe ? " has-me" : ""}`}
                onClick={(e) => { closeIfMobile(); onSettingsClick(e); }}>{settingsInner}</Link>)}
        </div>

        {me && hasMe ? (
          <div className="ap-me" data-testid="side-account">
            <Link href="/profile" className="ap-me-id" title={name} onClick={closeIfMobile}>
              <Avatar address={me.address} name={name} size={36} />
              <span className="ap-me-who">
                <span className="ap-me-nm">{name}</span>
                <GuildTagFor address={me.address} />
              </span>
            </Link>
            {settingsProps
              ? <button type="button" className="ap-me-gear" title="Settings" aria-label="Settings" aria-haspopup="dialog" {...settingsProps}>
                  <Icon name="settings" size={18} />
                </button>
              : <Link href={SETTINGS_HREF} className="ap-me-gear" title="Settings" aria-label="Settings"
                  onClick={(e) => { closeIfMobile(); onSettingsClick(e); }}>
                  <Icon name="settings" size={18} />
                </Link>}
          </div>
        ) : !you ? (
          <div className="ap-join" data-testid="side-join">
            <div className="ap-join-t">{JOIN_TITLE}</div>
            <p className="ap-join-p">{JOIN_LINE}</p>
            {/* the wallet pill's own action ("Play" = guest account, else its sign-in menu); #149 phone Play */}
            <button
              type="button"
              className="ap-join-btn ap-side-cta"
              data-testid="side-wallet-cta"
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(new Event(WALLET_CTA_CLICK_EVENT));
              }}
            >
              {cta ?? "Sign in"}
            </button>
          </div>
        ) : null}
      </aside>
      {/* phones: the dimmed page behind the open drawer; tapping it closes the drawer (CSS shows it on phones only) */}
      {open && <div className="ap-scrim" aria-hidden="true" onClick={() => toggle(false)} />}
      <button type="button" id="apReopen" title="Open menu" aria-label="Open menu" onClick={() => toggle(true)}>
        <Icon name="menu" size={20} />
      </button>
      {/* Phones (non-game routes): the one Launch button sits in the top bar, so the drawer doesn't repeat it */}
      {!isGame && (
        <Link href="/create" className="ap-phone-launch" data-testid="topbar-launch" title="Launch a Rocket">
          <Icon name="plus" size={16} />
          <span>{PHONE_LAUNCH}</span>
        </Link>
      )}
    </>
  );
}
