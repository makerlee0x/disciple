"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { disconnect, importLocal, isSmartMode, onWallet, resetLocal } from "@/lib/wallet";
import {
  aaSession, enableOneTap, endOneTap, localExport, onSessionChange, oneTapAvailable, restartOneTap,
  oneTapSlippageBps, oneTapStatus, oneTapSpendLimitUsd, setOneTapSpendLimitUsd,
} from "@/lib/aa/session";
import OneTapSlippagePicker from "@/components/trade/OneTapSlippagePicker";
import { fmtSessionExpiry } from "@/lib/aa/oneTap";
import type { Address } from "@/lib/protocol";
import { playerError } from "@/lib/playerError";
import { DEPOSIT_HREF, onDepositClick } from "@/lib/cashLink";
import { TEST_CASH_COPY } from "@/lib/testCash";
import TestCashButton from "@/components/TestCashButton";

/** COPY PENDING LEE APPROVAL (new strings only; everything else moved as-is from the old account dropdown). */
export const ACCOUNT_SETTINGS_COPY = {
  title: "Account",
  sub: "Your account and one-tap trading",
  signedOut: "Sign in to see your account settings.",
};

/**
 * Account settings (SITE, Oct 30): the contents of the old @name account dropdown (WalletButton), moved as-is into the
 * private profile's Settings modal. Same handlers and session logic (lib/aa/session); only the shell changed.
 * `onClose`: called where the dropdown used to close itself (sign out, deposit link, import / reset).
 */
export default function AccountSettings({ onClose }: { onClose?: () => void } = {}) {
  const [addr, setAddr] = useState<Address | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [, bump] = useState(0);
  const [shownKey, setShownKey] = useState("");
  const [imp, setImp] = useState("");
  // Opt-in one-tap spend limit ($, Advanced). Blank = no limit (default, per spec 05).
  const [limitUsd, setLimitUsd] = useState("");
  useEffect(() => { const v = oneTapSpendLimitUsd(); setLimitUsd(v ? String(v) : ""); }, []);
  useEffect(() => onWallet(setAddr), []);
  useEffect(() => onSessionChange(() => bump((n) => n + 1)), []);
  const limitNum = () => { const n = Number(limitUsd.replace(/[$,\s]/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
  const saveLimit = () => setOneTapSpendLimitUsd(limitNum());
  const limitLabel = (v: number | null) => v ? `$${v.toLocaleString("en-US")} spend limit` : "no spend limit";
  const close = () => onClose?.();

  const fail = (e: unknown) => setErr(playerError(e).slice(0, 160));
  async function run(label: string, f: () => Promise<unknown>) {
    setErr(""); setBusy(label);
    try { await f(); } catch (e) { fail(e); } finally { setBusy(""); }
  }

  const input: CSSProperties = { minWidth: 0 };
  const advancedLimit = (onApply: () => void, applyLabel: string) => (
    <details>
      <summary style={{ cursor: "pointer", opacity: 0.8 }}>Advanced</summary>
      <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>Spend limit $
        <input className="ds-input" aria-label="one-tap spend limit $" inputMode="decimal" placeholder="none" value={limitUsd} onChange={(e) => setLimitUsd(e.target.value)} style={{ ...input, width: 90 }} />
        <button type="button" className="ds-btn" disabled={!!busy} onClick={onApply}>{applyLabel}</button>
      </label>
      <span className="muted tiny">Optional cap on what one-tap can spend per session. Leave blank for no limit. Price protection (max slippage) always applies.</span>
    </details>
  );

  const smart = isSmartMode();
  const sess = aaSession();
  const oneTap = oneTapStatus();
  const col: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" };
  const brk: CSSProperties = { wordBreak: "break-all" };
  const needsCash = (
    <>
      <span role="status" data-testid="onetap-needs-cash">{TEST_CASH_COPY.needsCash}{" "}
        <a href={DEPOSIT_HREF} onClick={(e) => { close(); onDepositClick(e); }} style={{ fontWeight: 700 }}>{TEST_CASH_COPY.deposit}</a>
      </span>
      {addr && <TestCashButton account={addr} className="ds-btn gold" />}
    </>
  );

  return (
    <section id="account" className="chart-card" aria-label="Account" data-testid="account-settings">
      <h3>{ACCOUNT_SETTINGS_COPY.title}</h3>
      <div className="muted tiny">{ACCOUNT_SETTINGS_COPY.sub}</div>
      <div className="card" style={{ ...col, marginTop: 8 }}>
        {!addr ? (
          <span className="muted">{ACCOUNT_SETTINGS_COPY.signedOut}</span>
        ) : smart && sess?.kind !== "local" ? (
          <>
            <span className="mono" style={brk}>Smart account: {addr} <button type="button" className="ds-btn" onClick={() => navigator.clipboard?.writeText(addr)}>copy</button></span>
            <span className="muted mono" style={brk}>Owner (Privy wallet): {sess?.owner}</span>
            {sess?.oneTap ? (
              <>
                <span style={{ color: "#c8ffe4" }}>One-tap on · max slippage {(sess.oneTap.maxSlippageBps / 100).toString()}% · {limitLabel(oneTapSpendLimitUsd())} · {fmtSessionExpiry(sess.oneTap.validUntil)}</span>
                <button type="button" className="ds-btn" disabled={!!busy} onClick={() => run("ending session", endOneTap)}>End one-tap session</button>
                <OneTapSlippagePicker />
                {advancedLimit(() => run("restarting session", async () => { saveLimit(); await restartOneTap(oneTapSlippageBps()); }), "Apply (new session)")}
              </>
            ) : oneTapAvailable() && oneTap.needsCash && !oneTap.settingUp ? (
              needsCash
            ) : oneTapAvailable() && oneTap.settingUp ? (
              <span>Setting up one-tap trading…</span>
            ) : oneTapAvailable() ? (
              <>
                <span style={{ opacity: 0.8 }}>Trades go through without prompts (your wallet signs them silently).{oneTap.error ? ` One-tap session setup failed: ${oneTap.error}` : ""}</span>
                <OneTapSlippagePicker />
                <button type="button" className="ds-btn gold" disabled={!!busy} onClick={() => run("approve session", () => { saveLimit(); return enableOneTap({ maxSlippageBps: oneTapSlippageBps(), spendLimitUsd: limitNum() }); })}>Enable one-tap trading</button>
                {advancedLimit(saveLimit, "Save")}
                <span className="muted tiny">A 24h session key protects each trade on-chain: a trade whose price moves more than this is cancelled.</span>
              </>
            ) : (
              <span className="muted">One-tap trading is on.</span>
            )}
          </>
        ) : smart && sess?.kind === "local" ? (
          <>
            <span>Testnet wallet stored in this browser. Clearing site data loses it — export the key to back it up.</span>
            <span className="mono" style={brk}>Account: {addr} <button type="button" className="ds-btn" onClick={() => navigator.clipboard?.writeText(addr)}>copy</button></span>
            <span className="muted mono" style={brk}>Owner key address: {sess?.owner}</span>
            {oneTapAvailable() && oneTap.needsCash && !oneTap.settingUp && needsCash}
            {shownKey ? (
              <span className="mono" style={{ ...brk, color: "#ffb0c0" }}>{shownKey} <button type="button" className="ds-btn" onClick={() => setShownKey("")}>hide</button></span>
            ) : (
              <button type="button" className="ds-btn" onClick={() => { if (confirm("Reveal your private key? Anyone with it controls this account. Never share it.")) setShownKey(localExport() || ""); }}>Export key</button>
            )}
            <div style={{ display: "flex", gap: 6, width: "100%" }}>
              <input className="ds-input" aria-label="import key" placeholder="0x… private key" value={imp} onChange={(e) => setImp(e.target.value)} style={{ ...input, flex: 1 }} />
              <button type="button" className="ds-btn" disabled={!imp || !!busy} onClick={() => { if (confirm("Replace this browser's wallet with the imported key? Export the current key first if it holds funds.")) run("importing", async () => { await importLocal(imp); setImp(""); close(); }); }}>Import</button>
            </div>
            <button type="button" className="ds-btn" onClick={() => { if (confirm("Reset wallet? This deletes the key from this browser. Funds are lost unless you exported the key.")) run("", async () => { await resetLocal(); close(); setShownKey(""); }); }} style={{ background: "#7a1f2f", color: "#ffd0d8", borderColor: "#7a1f2f" }}>Reset wallet</button>
          </>
        ) : (
          <span className="mono" style={brk}>Wallet: {addr}</span>
        )}
        {addr && <button type="button" className="ds-btn" onClick={() => { close(); run("", disconnect); }}>Sign out</button>}
        {busy && <span className="muted tiny" role="status">{busy}…</span>}
        {err && <span role="alert" style={{ color: "#ffb0c0" }}>{err}</span>}
      </div>
    </section>
  );
}
