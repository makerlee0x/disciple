"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MODES } from "@/lib/config";
import { DEFAULT_SELLS, MIN_BOOST_USD, validBoost, type SellSlot, type SwapSettings } from "@/lib/trade/swapSettings";
import { ONE_TAP_SLIPPAGE_CHOICES_BPS, oneTapSlippageBps, onSessionChange, setOneTapSlippageBps } from "@/lib/aa/session";
import { playerError } from "@/lib/playerError";
import Icon from "@/components/icons/Icon";

/** Desktop Trade settings (menu → Trade settings): 4 editable boost amounts (default $10/$25/$50/$100), the fixed dump sizes
 *  (10/25/50/100%, read-only), price protection and the rocket tag. Restyled 2026-11-14 on the Hangar popups v2 shell (the
 *  same look as Settings; maker: the old Swap settings popup was the old design). Phones use PhoneBoostSheet. */
export default function SwapSettingsModal({ initial, autoUsd, tier, scope, onSave, onClose }: {
  initial: SwapSettings; autoUsd: number[]; tier: number | null; scope: string;
  onSave: (s: SwapSettings, tier: number | null) => void; onClose: () => void;
}) {
  const [buy, setBuy] = useState<string[]>((initial.buy || autoUsd).map(String));
  const [buyAuto, setBuyAuto] = useState(!initial.buy);
  const [tag, setTag] = useState(initial.tag);
  const t = tier;
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  useEffect(() => { if (buyAuto) setBuy(autoUsd.map(String)); }, [buyAuto, autoUsd]);
  // Leaving the default amounts by focusing a box selects its value, so the first key replaces it. Done in a layout effect,
  // after React writes the raw number in but before the browser takes the next keystroke.
  const selectRef = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => { if (!buyAuto && selectRef.current) { selectRef.current.select(); selectRef.current = null; } }, [buyAuto]);
  const [err, setErr] = useState("");
  const save = () => {
    const b = buy.map((v) => +v);
    // $3 minimum: a smaller boost can't cover the network fee (maker, 2026-11-14)
    if (!buyAuto && !b.every(validBoost)) { setErr(`Each boost needs to be at least $${MIN_BOOST_USD}, which covers the network fee.`); return; }
    // sells are fixed (10/25/50/100% of the bag): never saved from here
    onSave({ buy: buyAuto ? null : b, sells: DEFAULT_SELLS.slice() as SellSlot[], slippage: initial.slippage, tag }, t);
  };
  // price protection = the one-tap session's on-chain max price move (lee, Oct 30), the same control as Settings → Flying.
  // The old Auto / Custom % row is gone (2026-11-14): trades never read it (TradeBridge prices with the session cap).
  const live = scope.startsWith("live");
  const [bps, setBps] = useState(1500), [busy, setBusy] = useState(false), [slipErr, setSlipErr] = useState("");
  useEffect(() => { setBps(oneTapSlippageBps()); return onSessionChange(() => setBps(oneTapSlippageBps())); }, []);
  const pick = async (b: number) => {
    if (busy || b === bps) return;
    setBps(b); setBusy(true); setSlipErr("");
    try { await setOneTapSlippageBps(b); } catch (e) { setSlipErr(playerError(e).slice(0, 120)); } finally { setBusy(false); }
  };
  const where = live ? "Real flights" : scope.includes("sim") ? "Free play" : "Paper flights";
  return (
    <div className="ds-modal-backdrop p5-settings-backdrop p5-trade-backdrop" data-testid="swap-settings-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()}>
      <div className="ds-modal p5-modal p5-settings p5-trade" role="dialog" aria-modal="true" aria-label="Trade settings" data-testid="swap-settings">
        <header className="p5-mhead">
          <h2>Trade settings</h2>
          <span className="p5-trade-where">{where}</span>
          <button type="button" className="p5-icon" aria-label="close" onClick={onClose}><Icon name="close" size={18} /></button>
        </header>
        <section className="p5-sgrp" aria-label="Boost amounts">
          <div className="p5-trade-gh"><span className="gh">Boost amounts</span>
            {!buyAuto && <button type="button" className="p5-trade-reset" onClick={() => { setBuyAuto(true); setErr(""); }}><Icon name="refresh" size={12} /> Reset</button>}</div>
          <div className="p5-sbox">
            <div className="p5-srow col">
              <div className="p5-trade-cells">
                {buy.map((v, i) => <label key={i} className="p5-trade-cell">
                  <kbd>{MODES[i].key}</kbd>
                  <input data-testid={`swap-buy-${i}`} inputMode="decimal" aria-label={`Boost amount ${i + 1}`} className={buyAuto ? "auto" : ""}
                    value={buyAuto ? (+v < 1 ? `$${(+v).toFixed(2)}` : `$${+v}`) : v} onFocus={(e) => { if (buyAuto) { selectRef.current = e.currentTarget; setBuyAuto(false); } }}
                    onChange={(e) => { setBuyAuto(false); setErr(""); const n = [...buy]; n[i] = e.target.value.replace(/[^\d.]/g, ""); setBuy(n); }} /></label>)}
              </div>
              <span data-testid="swap-buy-note" role={err ? "alert" : undefined} className={err ? "p5-err" : "p5-fine"}>
                {err || `Minimum $${MIN_BOOST_USD} per boost, which covers the network fee.`}</span>
            </div>
            <div className="p5-srow">
              <div className="tx"><b>Use defaults</b><span>$10 / $25 / $50 / $100</span></div>
              <button type="button" role="switch" aria-checked={buyAuto} aria-label="Use default boost amounts" className={`p5-switch${buyAuto ? " on" : ""}`}
                data-testid="swap-autoscale" onClick={() => setBuyAuto((x) => !x)}><span /></button>
            </div>
          </div>
        </section>
        <section className="p5-sgrp" aria-label="Dump sizes">
          <span className="gh">Dump sizes</span>
          <div className="p5-sbox">
            <div className="p5-srow col">
              <div className="p5-trade-cells">
                {DEFAULT_SELLS.map((v, i) => <span key={i} className="p5-trade-cell dump" title="Fixed: % of your bag. Use the custom sell field for any other size.">
                  <kbd>{["Z", "X", "C", "V"][i]}</kbd><output data-testid={`swap-sell-${i}`}>{v >= 100 ? "ALL" : v === 50 ? "HALF" : `${v}%`}</output></span>)}
              </div>
              <span className="p5-fine">Share of your bag. Fixed, so the keys always mean the same thing.</span>
            </div>
          </div>
        </section>
        <section className="p5-sgrp" aria-label="Price protection" data-testid="swap-protection">
          <span className="gh">Price protection</span>
          <div className="p5-sbox">
            <div className="p5-srow wrap">
              <span className="p5-sic"><Icon name="chart" size={18} /></span>
              <div className="tx"><b>Max price move</b><span>{live ? "Bigger moves cancel the trade" : "Applies to real flights only"}</span></div>
              {live && <div className="p5-seg" role="radiogroup" aria-label="Max price move" data-testid="swap-slip">
                {ONE_TAP_SLIPPAGE_CHOICES_BPS.map((b) => <button key={b} type="button" role="radio" aria-checked={bps === b} className={bps === b ? "on" : ""} disabled={busy}
                  onClick={() => void pick(b)} data-testid={`swap-slip-${b}`}>{b / 100}%</button>)}
              </div>}
              {slipErr && <span className="p5-err" role="alert">{slipErr}</span>}
            </div>
            <div className="p5-srow">
              <span className="p5-sic"><Icon name="rocket" size={18} /></span>
              <div className="tx"><b>Position tag</b><span>Your bag next to the rocket · P</span></div>
              <button type="button" role="switch" aria-checked={tag} aria-label="Position tag next to the rocket" className={`p5-switch${tag ? " on" : ""}`}
                data-testid="swap-tag" onClick={() => setTag((x) => !x)}><span /></button>
            </div>
          </div>
        </section>
        <button type="button" className="p5-btn gold wide" data-testid="swap-save" onClick={save}>Save</button>
      </div>
    </div>
  );
}
