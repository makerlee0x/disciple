"use client";

import { useEffect, useState } from "react";
import ProfileIdentity from "./ProfileIdentity";
import OneTapSlippagePicker from "@/components/trade/OneTapSlippagePicker";
import { disconnect, onWallet } from "@/lib/wallet";
import type { Address } from "@/lib/protocol";
import Icon from "@/components/icons/Icon";

/**
 * Private Settings popup (lee, Oct 30: "that whole settings module doesnt make any sense"): only the username, the max
 * price move picker, and Sign out when signed in. Cash (balance, Deposit, Withdraw) moved to /wallet; no pair-token
 * balance, no network name.
 */
export default function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [addr, setAddr] = useState<Address | null>(null);
  useEffect(() => onWallet(setAddr), []);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = prev; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="ds-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ds-modal" role="dialog" aria-modal="true" aria-label="Settings" data-testid="settings-modal">
        <header className="ds-modal-head">
          <div>
            <h2>Settings</h2>
            <div className="sub">PRIVATE · ONLY YOU SEE THIS</div>
          </div>
          <button type="button" className="ds-btn" aria-label="Close settings" onClick={onClose}><Icon name="close" size={16} /></button>
        </header>
        <div className="ds-modal-body">
          {!addr ? <p className="muted">Sign in to see your account settings.</p> : <>
            <ProfileIdentity usernameOnly />
            <section className="chart-card" aria-label="Trading" data-testid="settings-trading"><OneTapSlippagePicker /></section>
            <button type="button" className="ds-btn" data-testid="settings-signout" onClick={() => { onClose(); void disconnect(); }}>Sign out</button>
          </>}
        </div>
      </div>
    </div>
  );
}
