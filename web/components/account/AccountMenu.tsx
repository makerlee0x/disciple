"use client";
/**
 * The pilot chip's menu (step 5 board "Sign in, account menu, Hangar signed out", maker 2026-11-13): your ring, name and
 * level bar on top, then Your Hangar, Rewards (what's ready), Settings, and Sign out on its own.
 * Opens under the chip on desktop; a bottom sheet over the tab bar on phones (CSS, ≤720px).
 */
import { CREW_ENABLED, LOGBOOK_ENABLED } from "@/lib/features";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { shareInvite } from "@/lib/invite";
import { useXp } from "@/lib/xpClient";
import { MAX_LEVEL, levelInfo } from "@/lib/xp";
import { SETTINGS_HREF, onSettingsClick } from "@/lib/cashLink";
import { usePilotPfp } from "@/lib/pilotPfp";
import { useRewards } from "@/components/claims/useRewards";
import { usd2 } from "@/components/cash/bits";

export const ACCOUNT_COPY = {
  hangar: "Your Hangar",
  trophies: "Trophies",
  topPilots: "Top pilots",
  logbook: "Logbook",
  crew: "Crew",
  cash: "Cash",
  rewards: "Rewards",
  invite: "Invite",
  copied: "Link copied",
  ready: (v: string) => `${v} ready`,
  settings: "Settings",
  howToPlay: "How to play",
  docs: "Docs",
  signOut: "Sign out",
  xpTo: (n: number, next: number) => `${n.toLocaleString("en-US")} XP to ${next}`,
  level: (n: number) => `Level ${n}`,
  max: "Max level",
} as const;
/** Opens the Rewards popup on the Hangar (ProfileDashboard reads it on load and on hashchange). */
export const REWARDS_HREF = "/profile#rewards";

const I = {
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01" /></>,
  docs: <path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5" />,
  hangar: <path d="M3 10l9-6 9 6v10H3zM9 20v-6h6v6" />,
  topPilots: <path d="M5 20V12M12 20V5M19 20v-5" />,
  trophies: <path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8" />,
  logbook: <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11M9 8h6" />,
  crew: <><circle cx="9" cy="9" r="3" /><circle cx="17" cy="10" r="2.5" /><path d="M3 20a6 6 0 0 1 12 0M14 20a4 4 0 0 1 7-2.6" /></>,
  cash: <><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /></>,
  rewards: <><rect x="3" y="9" width="18" height="11" rx="2" /><path d="M3 13h18M12 9v11M7 9a3 3 0 0 1 5-3 3 3 0 0 1 5 3" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" /></>,
  invite: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6" /></>,
  out: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />,
};
const Ico = ({ d }: { d: ReactNode }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>{d}</svg>;

export default function AccountMenu({ wallet, name, initial, onClose, onSignOut }: {
  wallet: string; name: string; initial: string; /** unused since maker 2026-11-17 (Cash left the menu: the cash pill sits beside it) */ cashUsd?: number | null; onClose: () => void; onSignOut: () => void;
}) {
  const { xp } = useXp(wallet);
  const pfp = usePilotPfp(wallet);
  const L = xp?.level ?? levelInfo(0);
  const r = useRewards(true);
  const [copied, setCopied] = useState(false);
  const invite = async () => { const how = await shareInvite(wallet); if (how === "copied") { setCopied(true); setTimeout(() => setCopied(false), 1400); } else if (how === "shared") onClose(); };
  const ready = useMemo(() => {
    const k = r.data?.claimableByKind;
    return k ? k.referral + k.creator + k.crew : 0;
  }, [r.data]);
  return (
    <>
      <button type="button" className="am-scrim" aria-label="Close menu" onClick={onClose} />
      <div className="am-menu" role="menu" aria-label="Your account" data-testid="account-menu">
        <span className="am-grab" aria-hidden />
        <div className="am-who">
          {pfp.img
            // eslint-disable-next-line @next/next/no-img-element
            ? <span className={`am-av has-img${pfp.nft ? " pfp-hex" : ""}`} aria-hidden><img src={pfp.img} alt="" width={48} height={48} /></span>
            : <span className="am-av" aria-hidden>{initial}</span>}
          <div className="am-id">
            <b>{name}</b>
            <span>{ACCOUNT_COPY.level(L.level)} · {L.level >= MAX_LEVEL ? ACCOUNT_COPY.max : ACCOUNT_COPY.xpTo(Math.max(0, L.need - L.into), L.level + 1)}</span>
            <i className="am-bar"><i style={{ width: `${Math.round(L.progress * 100)}%` }} /></i>
          </div>
        </div>
        <span className="am-sep" />
        <a role="menuitem" className="am-i" href="/profile" onClick={onClose}><Ico d={I.hangar} />{ACCOUNT_COPY.hangar}</a>
        {/* plain row, no gold or "n left today" (maker 2026-11-18: "why are we featuring that at all") */}
        <Link role="menuitem" className="am-i" href="/achievements" onClick={onClose} data-testid="account-trophies"><Ico d={I.trophies} />{ACCOUNT_COPY.trophies}</Link>
        {/* phones: Top pilots left the bottom tab bar for Market (nav rework, maker 2026-11-16), so it lives here */}
        <Link role="menuitem" className="am-i am-phone" href="/leaderboard" onClick={onClose}><Ico d={I.topPilots} />{ACCOUNT_COPY.topPilots}</Link>
        {LOGBOOK_ENABLED && <Link role="menuitem" className="am-i" href="/logbook" onClick={onClose}><Ico d={I.logbook} />{ACCOUNT_COPY.logbook}</Link>}
        {CREW_ENABLED && <Link role="menuitem" className="am-i" href="/crew" onClick={onClose}><Ico d={I.crew} />{ACCOUNT_COPY.crew}</Link>}
        <a role="menuitem" className="am-i" href={REWARDS_HREF} onClick={onClose} data-testid="account-rewards"><Ico d={I.rewards} />{ACCOUNT_COPY.rewards}{ready > 0.004 && <span className="am-r gold">{ACCOUNT_COPY.ready(usd2(ready))}</span>}</a>
        <button role="menuitem" type="button" className="am-i" onClick={() => void invite()} data-testid="account-invite"><Ico d={I.invite} />{copied ? ACCOUNT_COPY.copied : ACCOUNT_COPY.invite}</button>
        <Link role="menuitem" className="am-i" href={SETTINGS_HREF} scroll={false} onClick={(e) => { onClose(); onSettingsClick(e); }}><Ico d={I.settings} />{ACCOUNT_COPY.settings}</Link>
        {/* the top bar "?" moved in here when the balance joined the pilot pill (maker 2026-11-19) */}
        <Link role="menuitem" className="am-i" href="/how-it-works" onClick={onClose}><Ico d={I.help} />{ACCOUNT_COPY.howToPlay}</Link>
        <Link role="menuitem" className="am-i" href="/docs" onClick={onClose}><Ico d={I.docs} />{ACCOUNT_COPY.docs}</Link>
        <span className="am-sep" />
        <button role="menuitem" type="button" className="am-i dim" onClick={() => { onClose(); onSignOut(); }} data-testid="account-signout"><Ico d={I.out} />{ACCOUNT_COPY.signOut}</button>
      </div>
    </>
  );
}
