"use client";

import { useEffect, useState } from "react";
import { disconnect, onWallet } from "@/lib/wallet";
import type { Address } from "@/lib/protocol";
import { ONE_TAP_SLIPPAGE_CHOICES_BPS, onPrivy, onSessionChange, oneTapSlippageBps, privyAccount, privySecurity, setOneTapSlippageBps, type PrivyAccountInfo, type PrivyMfaMethod, type PrivySecurity } from "@/lib/aa/session";
import { playerError } from "@/lib/playerError";
import Icon from "@/components/icons/Icon";
import { SETTINGS_KEYS } from "@/lib/config";

/** Settings copy (profile r3 README copy list). */
export const SETTINGS_COPY = {
  title: "Settings",
  account: "Account",
  trading: "Flying",
  signedIn: (m: string) => `Signed in with ${m}`,
  wallet: "Your wallet",
  walletHelp: "Deposit and withdraw on the Wallet page.",
  oneTap: "One-tap boosts",
  orbs: "Orbs", orbsHelp: "Show each trade as an orb in flight. O in flight.",
  bombs: "Dump bombs", bombsHelp: "Show dumps as bombs in flight. B in flight.",
  oneTapHelp: "BOOST and DUMP with one tap, no pop-up.",
  on: "On",
  maxMove: "Max price move per trade",
  maxMoveHelp: "If the price moves more than this, the trade is cancelled.",
  choice: (bps: number) => (bps >= 5000 ? "50% (most allowed)" : `${bps / 100}%`),
  security: "Security",
  exportKey: "Export key",
  exportKeyHelp: "See your wallet's private key. Anyone who has it controls your money.",
  exportBtn: "Export",
  twoFa: "Two-factor authentication",
  twoFaOff: "Off",
  totp: "Authenticator app",
  passkey: "Passkey",
  passkeyHelp: "Sign in with your device's biometrics",
  privyOnly: "Available when you sign in with email, Google, X or a wallet.",
  logout: "Log out",
  copy: "Copy", copied: "Copied",
  signedOut: "Sign in to see your account settings.",
} as const;

/** Flight effect switches (lib/config SETTINGS_KEYS, read by the flight screen; "off" = hidden). */
function readFx(key: string) { try { return localStorage.getItem(key) !== "off"; } catch { return true; } }
function writeFx(key: string, on: boolean) { try { localStorage.setItem(key, on ? "on" : "off"); } catch { /* ignore */ } }

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** a••••@gmail.com style: first 3 characters of the name, the domain kept. */
export function maskEmail(e: string): string {
  const [u, d] = e.split("@");
  if (!d) return e;
  return `${u.slice(0, Math.min(3, Math.max(1, u.length - 1)))}•••@${d}`;
}

/**
 * Settings popup (profile r3), opened by the sidebar gear (/profile#settings): Signed in with · Your wallet + Copy ·
 * Security (Export key, Two-factor authentication) · One-tap trading · Max price move per trade · Log out at the bottom.
 * The username moved to Edit profile (lee, Nov 11). Export key and 2FA are Privy's own flows (useExportWallet: the key
 * shows inside Privy's iframe; useMfaEnrollment: authenticator app or passkey). Privy has no PIN method.
 * Desktop: centred modal. Phone: full screen with a back arrow.
 * One-tap trading has no off switch any more (session keys were removed; every trade is a gasless signature from your
 * wallet with no pop-up), so the row shows its state without a toggle.
 */
export default function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [addr, setAddr] = useState<Address | null>(null);
  const [acct, setAcct] = useState<PrivyAccountInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [bps, setBps] = useState(1500);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sec, setSec] = useState<PrivySecurity | null>(null);
  const [view, setView] = useState<"main" | "2fa">("main");
  const [secBusy, setSecBusy] = useState("");
  const [secErr, setSecErr] = useState("");
  const [fx, setFx] = useState({ orbs: true, bombs: true });
  useEffect(() => { if (open) setFx({ orbs: readFx(SETTINGS_KEYS.orbs), bombs: readFx(SETTINGS_KEYS.bombs) }); }, [open]);
  useEffect(() => onWallet(setAddr), []);
  useEffect(() => { const read = () => { setAcct(privyAccount()); setSec(privySecurity()); }; read(); return onPrivy(read); }, []);
  useEffect(() => { if (!open) { setView("main"); setSecErr(""); } }, [open]);
  useEffect(() => { setBps(oneTapSlippageBps()); return onSessionChange(() => setBps(oneTapSlippageBps())); }, []);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = prev; };
  }, [open, onClose]);
  if (!open) return null;

  const pick = async (b: number) => {
    if (busy || b === bps) return;
    setBps(b); setBusy(true); setErr("");
    try { await setOneTapSlippageBps(b); } catch (e) { setErr(playerError(e).slice(0, 120)); } finally { setBusy(false); }
  };
  const exportKey = async () => {
    if (!sec?.exportWallet || secBusy) return;
    setSecBusy("export"); setSecErr("");
    try { await sec.exportWallet(); } catch (e) { setSecErr(playerError(e).slice(0, 120)); } finally { setSecBusy(""); }
  };
  const has = (m: PrivyMfaMethod) => !!sec?.mfaEnrolled.includes(m);
  const toggleMfa = async (m: PrivyMfaMethod) => {
    if (!sec || secBusy) return;
    setSecErr("");
    if (!has(m)) { sec.enrollMfa(); return; }   // Privy's enrollment modal (QR code / passkey prompt)
    setSecBusy(m);
    try { await sec.unenrollMfa(m); } catch (e) { setSecErr(playerError(e).slice(0, 120)); } finally { setSecBusy(""); }
  };
  const twoFaState = !sec ? SETTINGS_COPY.twoFaOff
    : [has("totp") && SETTINGS_COPY.totp, has("passkey") && SETTINGS_COPY.passkey].filter(Boolean).join(" · ") || SETTINGS_COPY.twoFaOff;
  const copy = () => { if (!addr) return; navigator.clipboard?.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1200); };

  return (
    <div className="ds-modal-backdrop p5-settings-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="p5-modal p5-settings" role="dialog" aria-modal="true" aria-label={SETTINGS_COPY.title} data-testid="settings-modal">
        {view === "2fa" ? <>
          <header className="p5-mhead p5-subhead">
            <button type="button" className="p5-icon" aria-label="Back" onClick={() => { setView("main"); setSecErr(""); }} data-testid="twofa-back"><Icon name="chevron-left" size={20} /></button>
            <h2>{SETTINGS_COPY.twoFa}</h2>
            <button type="button" className="p5-icon p5-desk" aria-label="Close settings" onClick={onClose}><Icon name="close" size={18} /></button>
          </header>
          <div className="p5-sbox" data-testid="twofa-view">
            {([["totp", SETTINGS_COPY.totp, null], ["passkey", SETTINGS_COPY.passkey, SETTINGS_COPY.passkeyHelp]] as const).map(([m, label, help]) => (
              <div className="p5-srow" key={m}>
                <div className="tx"><b>{label}</b>{help && <span>{help}</span>}</div>
                <button type="button" role="switch" aria-checked={has(m)} aria-label={label} className={`p5-switch${has(m) ? " on" : ""}`}
                  disabled={!sec || !!secBusy} onClick={() => void toggleMfa(m)} data-testid={`twofa-${m}`}><span /></button>
              </div>
            ))}
          </div>
          {!sec && <p className="p5-fine">{SETTINGS_COPY.privyOnly}</p>}
          {secErr && <p className="p5-err" role="alert">{secErr}</p>}
        </> : <>
        <header className="p5-mhead">
          <button type="button" className="p5-icon p5-phone" aria-label="Back" onClick={onClose}><Icon name="chevron-left" size={20} /></button>
          <h2>{SETTINGS_COPY.title}</h2>
          <button type="button" className="p5-icon p5-desk" aria-label="Close settings" onClick={onClose}><Icon name="close" size={18} /></button>
        </header>
        {!addr ? <p className="p5-fine">{SETTINGS_COPY.signedOut}</p> : <>
          <section className="p5-sgrp" aria-label={SETTINGS_COPY.account}>
            <span className="gh">{SETTINGS_COPY.account}</span>
            <div className="p5-sbox">
              {acct?.method && (
                <div className="p5-srow" data-testid="settings-signin">
                  <div className="tx"><b>{SETTINGS_COPY.signedIn(acct.method)}</b>{acct.email && <span>{maskEmail(acct.email)}</span>}</div>
                </div>
              )}
              <div className="p5-srow p5-srow-wallet" data-testid="settings-wallet">
                <div className="tx"><b>{SETTINGS_COPY.wallet}</b><span>{SETTINGS_COPY.walletHelp}</span></div>
                <div className="p5-walletbox"><span className="val" title={addr}>{short(addr)}</span>
                  <button type="button" className="p5-btn sm" onClick={copy}><Icon name="copy" size={16} /> {copied ? SETTINGS_COPY.copied : SETTINGS_COPY.copy}</button>
                </div>
              </div>
            </div>
          </section>
          <section className="p5-sgrp" aria-label={SETTINGS_COPY.trading} data-testid="settings-trading">
            <span className="gh">{SETTINGS_COPY.trading}</span>
            <div className="p5-sbox">
              <div className="p5-srow">
                <div className="tx"><b>{SETTINGS_COPY.oneTap} <span className="p5-pill on">{SETTINGS_COPY.on}</span></b><span>{SETTINGS_COPY.oneTapHelp}</span></div>
              </div>
              <div className="p5-srow col">
                <div className="tx"><b>{SETTINGS_COPY.maxMove}</b><span>{SETTINGS_COPY.maxMoveHelp}</span></div>
                <div className="p5-seg" role="radiogroup" aria-label={SETTINGS_COPY.maxMove} data-testid="onetap-slippage">
                  {ONE_TAP_SLIPPAGE_CHOICES_BPS.map((b) => (
                    <button key={b} type="button" role="radio" aria-checked={bps === b} className={bps === b ? "on" : ""} disabled={busy} onClick={() => void pick(b)} data-testid={`onetap-slip-${b}`}>
                      {SETTINGS_COPY.choice(b)}
                    </button>
                  ))}
                </div>
                {err && <span className="p5-err" role="alert">{err}</span>}
              </div>
              {([["orbs", SETTINGS_COPY.orbs, SETTINGS_COPY.orbsHelp, "setOrbs"], ["bombs", SETTINGS_COPY.bombs, SETTINGS_COPY.bombsHelp, "setBombs"]] as const).map(([k, label, help, fn]) => (
                <div className="p5-srow" key={k}>
                  <div className="tx"><b>{label}</b><span>{help}</span></div>
                  <button type="button" role="switch" aria-checked={fx[k]} aria-label={label} className={`p5-switch${fx[k] ? " on" : ""}`} data-testid={`settings-${k}`}
                    onClick={() => setFx((v) => { const next = !v[k]; writeFx(SETTINGS_KEYS[k], next); (window as unknown as { __flight?: Record<string, (v: boolean) => void> }).__flight?.[fn]?.(next); return { ...v, [k]: next }; })}><span /></button>
                </div>
              ))}
            </div>
          </section>
          <section className="p5-sgrp" aria-label={SETTINGS_COPY.security} data-testid="settings-security">
            <span className="gh">{SETTINGS_COPY.security}</span>
            <div className="p5-sbox">
              <div className="p5-srow" data-testid="settings-export">
                <div className="tx"><b>{SETTINGS_COPY.exportKey}</b><span>{sec ? SETTINGS_COPY.exportKeyHelp : SETTINGS_COPY.privyOnly}</span></div>
                <button type="button" className="p5-btn sm" disabled={!sec?.exportWallet || !!secBusy} onClick={() => void exportKey()} data-testid="export-key">
                  <Icon name="lock" size={16} /> {SETTINGS_COPY.exportBtn}
                </button>
              </div>
              <button type="button" className="p5-srow p5-srow-link" onClick={() => { setView("2fa"); setSecErr(""); }} data-testid="settings-2fa">
                <div className="tx"><b>{SETTINGS_COPY.twoFa}</b><span>{twoFaState}</span></div>
                <Icon name="chevron-right" size={18} />
              </button>
            </div>
            {secErr && <span className="p5-err" role="alert">{secErr}</span>}
          </section>
          <button type="button" className="p5-logout" data-testid="settings-signout" onClick={() => { onClose(); void disconnect(); }}>
            <Icon name="log-out" size={18} /> {SETTINGS_COPY.logout}
          </button>
        </>}
        </>}
      </div>
    </div>
  );
}
