"use client";

import { useState, type CSSProperties } from "react";
import { TEST_CASH_COPY as COPY, TEST_CASH_ENABLED, getTestCash } from "@/lib/testCash";
import type { Address } from "@/lib/protocol";

/**
 * Testnet-only "Get test cash" (renders nothing unless the active chain is RH testnet 46630). Mints test cash to the
 * signed-in player's account via /api/test-cash; the one-tap watcher and balance cards pick it up from CASH_ARRIVED_EVENT.
 */
export default function TestCashButton({ account, className, style, showNote = true }: {
  account: Address | null; className?: string; style?: CSSProperties; showNote?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!TEST_CASH_ENABLED || !account) return null;
  async function go() {
    if (!account) return;
    setBusy(true); setMsg(null);
    const r = await getTestCash(account);
    setMsg(r.ok ? { ok: true, text: COPY.done(r.usd, r.strategyUsd) } : { ok: false, text: r.text });
    setBusy(false);
  }
  return (
    <span data-testid="test-cash" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <button type="button" className={className} style={style} disabled={busy} onClick={go}>{busy ? COPY.busy : COPY.button}</button>
      {showNote && !msg && <span className="muted tiny" style={{ opacity: 0.7 }}>{COPY.note}</span>}
      {msg && <span role={msg.ok ? "status" : "alert"} style={{ color: msg.ok ? "#8ff0c0" : "#ffb0c0" }}>{msg.text}</span>}
    </span>
  );
}
