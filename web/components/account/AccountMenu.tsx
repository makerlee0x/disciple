"use client";
/**
 * The pilot chip's menu (step 5 board "Sign in, account menu, Hangar signed out", maker 2026-11-13): your ring, name and
 * level bar on top, then Your Hangar, Cash (balance), Rewards (what's ready), Settings, and Sign out on its own.
 * Opens under the chip on desktop; a bottom sheet over the tab bar on phones (CSS, ≤720px).
 */
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { useXp } from "@/lib/xpClient";
import { MAX_LEVEL, levelInfo } from "@/lib/xp";
import { SETTINGS_HREF, onSettingsClick, openCash } from "@/lib/cashLink";
import { useRewards } from "@/components/claims/useRewards";
import { usd2 } from "@/components/cash/bits";

export const ACCOUNT_COPY = {
  hangar: "Your Hangar",
  cash: "Cash",
  rewards: "Rewards",
  ready: (v: string) => `${v} ready`,
  settings: "Settings",
  signOut: "Sign out",
  xpTo: (n: number, next: number) => `${n.toLocaleString("en-US")} XP to ${next}`,
  level: (n: number) => `Level ${n}`,
  max: "Max level",
} as const;
/** Opens the Rewards popup on the Hangar (ProfileDashboard reads it on load and on hashchange). */
export const REWARDS_HREF = "/profile#rewards";

const I = {
  hangar: <path d="M3 10l9-6 9 6v10H3zM9 20v-6h6v6" />,
  cash: <><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /></>,
  rewards: <><rect x="3" y="9" width="18" height="11" rx="2" /><path d="M3 13h18M12 9v11M7 9a3 3 0 0 1 5-3 3 3 0 0 1 5 3" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" /></>,
  out: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />,
};
const Ico = ({ d }: { d: ReactNode }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>{d}</svg>;

export default function AccountMenu({ wallet, name, initial, cashUsd, onClose, onSignOut }: {
  wallet: string; name: string; initial: string; cashUsd: number | null; onClose: () => void; onSignOut: () => void;
}) {
  const { xp } = useXp(wallet);
  const L = xp?.level ?? levelInfo(0);
  const r = useRewards(true);
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
          <span className="am-av" aria-hidden>{initial}</span>
          <div className="am-id">
            <b>{name}</b>
            <span>{ACCOUNT_COPY.level(L.level)} · {L.level >= MAX_LEVEL ? ACCOUNT_COPY.max : ACCOUNT_COPY.xpTo(Math.max(0, L.need - L.into), L.level + 1)}</span>
            <i className="am-bar"><i style={{ width: `${Math.round(L.progress * 100)}%` }} /></i>
          </div>
        </div>
        <span className="am-sep" />
        <a role="menuitem" className="am-i" href="/profile" onClick={onClose}><Ico d={I.hangar} />{ACCOUNT_COPY.hangar}</a>
        <button role="menuitem" type="button" className="am-i" onClick={() => { onClose(); openCash("add"); }}><Ico d={I.cash} />{ACCOUNT_COPY.cash}{cashUsd != null && <span className="am-r">{usd2(cashUsd)}</span>}</button>
        <a role="menuitem" className="am-i" href={REWARDS_HREF} onClick={onClose} data-testid="account-rewards"><Ico d={I.rewards} />{ACCOUNT_COPY.rewards}{ready > 0.004 && <span className="am-r gold">{ACCOUNT_COPY.ready(usd2(ready))}</span>}</a>
        <Link role="menuitem" className="am-i" href={SETTINGS_HREF} scroll={false} onClick={(e) => { onClose(); onSettingsClick(e); }}><Ico d={I.settings} />{ACCOUNT_COPY.settings}</Link>
        <span className="am-sep" />
        <button role="menuitem" type="button" className="am-i dim" onClick={() => { onClose(); onSignOut(); }} data-testid="account-signout"><Ico d={I.out} />{ACCOUNT_COPY.signOut}</button>
      </div>
    </>
  );
}
