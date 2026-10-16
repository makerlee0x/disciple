"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { SETTINGS_KEYS } from "@/lib/config";

const NAV = [
  { href: "/", key: "home", label: "Launchpad", icon: "home" },
  { href: "/profile", key: "profile", label: "Profile", icon: "profile" },
  { href: "/rocket", key: "upgrade", label: "Upgrade Rocket", icon: "upgrade" },
  { href: "/leaderboard", key: "leader", label: "Leaderboard", icon: "leader" },
  { href: "/achievements", key: "ach", label: "Achievements", icon: "ach" },
] as const;

function Icon({ name }: { name: string }) {
  const common = {
    viewBox: "0 0 24 24",
    width: 20,
    height: 20,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  switch (name) {
    case "home":
      return (
        <svg {...common}>
          <path d="M3 11l9-7 9 7" />
          <path d="M5 10v10h14V10" />
          <path d="M10 20v-6h4v6" />
        </svg>
      );
    case "profile":
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="4" />
          <ellipse cx="12" cy="3.2" rx="4.5" ry="1.2" />
          <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
        </svg>
      );
    case "upgrade":
      return (
        <svg {...common}>
          <path d="M12 2c3 2 5 6 5 10l-2 4H9l-2-4c0-4 2-8 5-10z" />
          <circle cx="12" cy="10" r="2" />
          <path d="M9 16l-3 4M15 16l3 4" />
        </svg>
      );
    case "leader":
      return (
        <svg {...common}>
          <path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 01-10 0z" />
          <path d="M7 6H4a3 3 0 003 4M17 6h3a3 3 0 01-3 4" />
        </svg>
      );
    case "ach":
      return (
        <svg {...common}>
          <path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.5 6.7 19.4l1.2-6L3.4 9.3l6-.7z" />
        </svg>
      );
    case "wallet":
      return (
        <svg {...common}>
          <rect x="3" y="6" width="18" height="14" rx="3" />
          <path d="M3 10h18" />
          <circle cx="16.5" cy="15" r="1.3" />
          <path d="M6 6l9-3 1.5 3" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
        </svg>
      );
    case "logout":
      return (
        <svg {...common}>
          <path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3" />
          <path d="M10 8l-4 4 4 4M6 12h10" />
        </svg>
      );
    case "create":
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    default:
      return null;
  }
}

function Wings() {
  return (
    <svg viewBox="0 0 80 64" aria-hidden="true" width={80} height={64}>
      <defs>
        <radialGradient id="apHalo" cx="50%" cy="50%">
          <stop offset="0" stopColor="#E8EAEE" />
          <stop offset="1" stopColor="#FF7A3D" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="40" cy="34" r="26" fill="url(#apHalo)" opacity=".45" />
      <ellipse
        cx="40"
        cy="12"
        rx="12"
        ry="3.4"
        fill="none"
        stroke="#C9CED6"
        strokeWidth="2.2"
      />
      <path
        d="M36 34C26 24 12 22 4 28c8 1 12 5 14 9-6-1-10 1-12 4 8 0 14 2 20 0z"
        fill="#E8EAEE"
        stroke="#C9CED6"
        strokeWidth="1"
      />
      <path
        d="M44 34c10-10 24-12 32-6-8 1-12 5-14 9 6-1 10 1 12 4-8 0-14 2-20 0z"
        fill="#E8EAEE"
        stroke="#C9CED6"
        strokeWidth="1"
      />
      <path
        d="M40 18c4 4 5 12 4 22l-4 6-4-6c-1-10 0-18 4-22z"
        fill="#e8ecf5"
        stroke="#9aa6c0"
        strokeWidth="1"
      />
      <circle cx="40" cy="30" r="2.4" fill="#9fd0ff" />
    </svg>
  );
}



/** Only chart / flight (game) routes may collapse the sidebar. Launchpad, create, profile,
 * leaderboard, achievements etc. are always expanded on desktop (mobile keeps a drawer). */
export function isCollapsibleRoute(pathname: string) {
  return pathname.startsWith("/coin/") || pathname.startsWith("/flight");
}

export default function Sidebar({ forceCollapsed }: { forceCollapsed?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const isGame = isCollapsibleRoute(pathname);
  const storageKey = isGame ? SETTINGS_KEYS.sidebarGame : SETTINGS_KEYS.sidebarHome;

  const [open, setOpen] = useState(!isGame);
  const [ready, setReady] = useState(false);
  const [logoutNote, setLogoutNote] = useState(false);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(storageKey);
    } catch {
      /* ignore */
    }
    const mobile =
      typeof window !== "undefined" &&
      window.matchMedia("(max-width:760px)").matches;
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
    document.body.classList.toggle(
      "side-hidden",
      !open && window.matchMedia("(max-width:760px)").matches,
    );
    try {
      if (isGame) localStorage.setItem(storageKey, open ? "open" : "collapsed");
    } catch {
      /* ignore */
    }
    window.dispatchEvent(
      new CustomEvent("apsidebar", { detail: { open } }),
    );
    const t = setTimeout(() => window.dispatchEvent(new Event("resize")), 240);
    return () => clearTimeout(t);
  }, [open, ready, storageKey, isGame]);

  const toggle = useCallback((force?: boolean) => {
    const mobile = window.matchMedia("(max-width:760px)").matches;
    if (!isGame && !mobile) return; // not collapsible here
    setOpen((o) => (typeof force === "boolean" ? force : !o));
  }, [isGame]);
  const canCollapse = isGame;


  if (!ready) return null;

  return (
    <>
      <aside
        id="apSide"
        className={open ? "" : "collapsed"}
        aria-label="Main menu"
      >
        <div className="ap-brand">
          <Link href="/" className="ap-logo" aria-label="DISCIPLE home">
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
            ☰
          </button>
        </div>
        <nav className="ap-nav">
          {NAV.map((item) => {
            const on =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.key}
                href={item.href}
                className={on ? "on" : ""}
                title={item.label}
              >
                <span className="ic">
                  <Icon name={item.icon} />
                </span>
                <span className="lb">{item.label}</span>
              </Link>
            );
          })}
          <Link
            href="/create"
            className={pathname === "/create" ? "on" : ""}
            title="Launch a Rocket"
          >
            <span className="ic">
              <Icon name="create" />
            </span>
            <span className="lb">Launch a Rocket</span>
          </Link>
        </nav>
        <div className="ap-promo">
          <div className="ap-illu">
            <Wings />
          </div>
          <h3>Launch a Rocket</h3>
          <p>
            Pair your coin with any ERC-20, pick a call sign, and put it on the
            pad. Everyone aboard flies together.
          </p>
          <Link href="/create" className="ap-cta">
            Launch
          </Link>
        </div>
        <div className="ap-foot">
          <button
            type="button"
            title="Log out"
            onClick={() => setLogoutNote(true)}
          >
            <span className="ic">
              <Icon name="logout" />
            </span>
            <span className="lb">Log out</span>
          </button>
        </div>
      </aside>
      <button
        type="button"
        id="apReopen"
        title="Open menu"
        onClick={() => toggle(true)}
      >
        ☰
      </button>
      {logoutNote && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-sm"
          onClick={() => setLogoutNote(false)}
          role="presentation"
        >
          <div
            className="w-[min(420px,90vw)] rounded-2xl border border-[rgba(201,206,214,.55)] bg-[radial-gradient(120%_80%_at_50%_0%,rgba(232,234,238,.22),rgba(22,24,28,.94)_60%)] p-6 text-[#E8EAEE] shadow-[0_0_60px_rgba(201,206,214,.25)]"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
          >
            <h2 className="m-0 mb-2 font-display text-2xl font-normal text-[#E8EAEE]">
              Log out
            </h2>
            <p className="text-sm opacity-75">
              No account is connected yet (Privy TBD). Nothing to log out of.
            </p>
            <button
              type="button"
              className="mt-4 rounded-xl border border-[rgba(201,206,214,.5)] px-4 py-2 text-[#C9CED6]"
              onClick={() => {
                setLogoutNote(false);
                router.push("/");
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
