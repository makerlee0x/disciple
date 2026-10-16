"use client";

import { useEffect } from "react";
import ProfileIdentity from "./ProfileIdentity";
import CashPanel from "./CashPanel";
import SettingsPanel from "./SettingsPanel";

/** Private account settings: username / wallet / X / referral, Cash (deposit + withdraw), preferences. */
export default function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
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
      <div className="ds-modal" role="dialog" aria-modal="true" aria-label="Settings">
        <header className="ds-modal-head">
          <div>
            <h2>Settings</h2>
            <div className="sub">PRIVATE · ONLY YOU SEE THIS</div>
          </div>
          <button type="button" className="ds-btn" aria-label="Close settings" onClick={onClose}>✕</button>
        </header>
        <div className="ds-modal-body">
          <ProfileIdentity />
          <CashPanel />
          <SettingsPanel />
        </div>
      </div>
    </div>
  );
}
