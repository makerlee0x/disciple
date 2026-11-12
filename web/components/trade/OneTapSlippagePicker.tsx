"use client";
/**
 * One-tap "Max price move per trade" (lee, Oct 30 11:03 CDT): 5 / 15 / 30 % or the contract's ceiling (50 %; the session
 * policy has no unlimited setting). Default 15 %. Saving replaces a live session at a different limit (lib/aa/session).
 * COPY PENDING LEE APPROVAL (the strings below).
 */
import { useEffect, useState } from "react";
import { ONE_TAP_SLIPPAGE_CHOICES_BPS, oneTapSlippageBps, onSessionChange, setOneTapSlippageBps } from "@/lib/aa/session";
import { playerError } from "@/lib/playerError";

export const ONE_TAP_SLIP_COPY = {
  label: "Max price move per trade",
  choice: (bps: number) => (bps >= 5000 ? "50% (most allowed)" : `${bps / 100}%`),
  hint: "One-tap trades fill as long as the price moves less than this between your tap and the fill.",
  saving: "Updating…",
};

export default function OneTapSlippagePicker({ compact = false }: { compact?: boolean }) {
  const [sel, setSel] = useState<number>(1500);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { setSel(oneTapSlippageBps()); return onSessionChange(() => setSel(oneTapSlippageBps())); }, []);
  const pick = async (b: number) => {
    if (busy || b === sel) return;
    setSel(b); setBusy(true); setErr("");
    try { await setOneTapSlippageBps(b); } catch (e) { setErr(playerError(e).slice(0, 120)); console.warn("[disciple] one-tap slippage change failed", e); } finally { setBusy(false); }
  };
  const chip = (on: boolean): React.CSSProperties => ({ all: "unset", cursor: busy ? "wait" : "pointer", padding: compact ? "2px 7px" : "4px 10px", borderRadius: 7, fontWeight: 600,
    fontSize: compact ? 10 : 12, background: on ? "#2b2f6e" : "rgba(255,255,255,.06)", color: on ? "#aab4ff" : "rgba(255,255,255,.7)" });
  return (
    <div data-testid="onetap-slippage" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span title={ONE_TAP_SLIP_COPY.hint}>{ONE_TAP_SLIP_COPY.label}{busy ? ` · ${ONE_TAP_SLIP_COPY.saving}` : ""}</span>
      <div role="radiogroup" aria-label={ONE_TAP_SLIP_COPY.label} style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {ONE_TAP_SLIPPAGE_CHOICES_BPS.map((b) => (
          <button key={b} type="button" role="radio" aria-checked={sel === b} data-testid={`onetap-slip-${b}`} disabled={busy} onClick={() => void pick(b)} style={chip(sel === b)}>
            {ONE_TAP_SLIP_COPY.choice(b)}
          </button>
        ))}
      </div>
      {err && <span role="alert" style={{ color: "#ffb0c8" }}>{err}</span>}
    </div>
  );
}
