"use client";

import { useEffect, useState } from "react";
import { ONE_TAP_SLIPPAGE_CHOICES_BPS, parseSlippagePctInput } from "@/lib/aa/session";

function isChoice(bps: number) {
  return (ONE_TAP_SLIPPAGE_CHOICES_BPS as readonly number[]).includes(bps);
}

function shown(bps: number) {
  return String(+(bps / 100).toFixed(2));
}

/** Compact "Other %" box so a player can type any max price move up to 100%. */
export default function MaxPriceMoveInput({ bps, busy, onPick, testId = "slip-custom" }: {
  bps: number; busy: boolean; onPick: (bps: number) => void; testId?: string;
}) {
  const custom = !isChoice(bps);
  const [text, setText] = useState(custom ? shown(bps) : "");
  useEffect(() => { setText(!isChoice(bps) ? shown(bps) : ""); }, [bps]);
  const commit = () => {
    const parsed = parseSlippagePctInput(text);
    if (parsed == null) { setText(!isChoice(bps) ? shown(bps) : ""); return; }
    onPick(parsed);
  };
  return (
    <label className={`p5-slip-custom${custom || text ? " on" : ""}`}>
      <input data-testid={testId} inputMode="decimal" aria-label="Custom max price move, up to 100 percent"
        placeholder="Other" disabled={busy} value={text}
        onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur(); } }} />
      <span aria-hidden="true">%</span>
    </label>
  );
}
