"use client";

import { useEffect, useRef, useState } from "react";
import { isDeployed } from "@/lib/chains";
import { MODES } from "@/lib/config";
import type { Address } from "@/lib/protocol";
import { createViemProtocol, publicClient, readQuote, tokenBalance, usdToAmountIn } from "@/lib/protocol-viem";
import { activeAddress, isSmartMode, onWallet } from "@/lib/wallet";
import AmmoTierNotice from "./AmmoTierNotice";
import { AMMO_TIERS } from "@/lib/flight/ammoTiers";
import { FEE } from "@/lib/pnl";

type Ammo = { tier: number | null; rocketTier?: number | null; name: string | null; usd: number[]; names: string[]; mode: number };

type Bridge = (side: "buy" | "sell", usd: number, o?: { frac?: number }) => Promise<{ ok: boolean; reason?: string; txHash?: string }>;
declare global { interface Window { __discipleTrade?: Bridge } }

/**
 * Ammo bar + bridge: the flight engine's shots (keys / these buttons) become real trades once a wallet is
 * connected — buy/sell(…, recipient) on the curve, DiscipleRouter after graduation; approve once per spender.
 * No chain or no wallet ⇒ no bridge ⇒ engine keeps paper fills (mock/replay unchanged).
 */
type Pos = { size: number; valueUsd: number; costBasis: number };
/** % sells and "sell initials" (recover cost basis incl. fees). Keys Q/W/E/R. */
const SELLS = [{ id: "12", label: "12%", frac: 0.12, key: "KeyQ" }, { id: "33", label: "33%", frac: 0.33, key: "KeyW" },
  { id: "77", label: "77%", frac: 0.77, key: "KeyE" }, { id: "init", label: "INITIALS", frac: 0, key: "KeyR" }] as const;

export default function TradeBridge({ token }: { token: string }) {
  const [mode, setMode] = useState(2);
  const [custom, setCustom] = useState("");
  const sellRef = useRef<((s: (typeof SELLS)[number]) => void) | null>(null);
  const [pos, setPos] = useState<Pos>({ size: 0, valueUsd: 0, costBasis: 0 });
  useEffect(() => {
    const h = (e: Event) => setPos((e as CustomEvent<Pos>).detail);
    addEventListener("disciple:position", h);
    return () => removeEventListener("disciple:position", h);
  }, []);
  // Preset $ sizes come from the engine (scaled by the rocket's ammo tier, see lib/flight/ammoTiers.ts).
  const [ammo, setAmmo] = useState<Ammo>({ tier: null, name: null, usd: MODES.map((m) => m.usd), names: MODES.map((m) => m.name), mode: 2 });
  useEffect(() => {
    const h = (e: Event) => { const d = (e as CustomEvent<Ammo>).detail; setAmmo(d); if (typeof d.mode === "number") setMode(d.mode); };
    addEventListener("disciple:ammo", h);
    dispatchEvent(new Event("disciple:ammo-query"));
    return () => removeEventListener("disciple:ammo", h);
  }, []);
  const [addr, setAddr] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const [last, setLast] = useState("");
  const valid = isDeployed() && /^0x[0-9a-fA-F]{40}$/.test(token);
  useEffect(() => onWallet(setAddr), []);
  const live = valid && !!addr;

  useEffect(() => {
    if (!live) return;
    const client = createViemProtocol();
    const pc = publicClient();
    window.__discipleTrade = async (side, usd, o) => {
      try {
        setLast(`${side === "buy" ? "▲" : "▼"} $${usd} ${isSmartMode() ? "· sending…" : "· confirm in wallet…"}`);
        let amountIn = await usdToAmountIn(pc, token as Address, side, usd);
        if (side === "sell") {
          const me = await activeAddress();
          const bal = await tokenBalance(pc, token as Address, me);
          if (bal === BigInt(0)) { setLast("no tokens to sell"); return { ok: false, reason: "no tokens to sell" }; }
          if (o?.frac && o.frac > 0) amountIn = (bal * BigInt(Math.round(Math.min(1, o.frac) * 1e6))) / BigInt(1e6);   // % of the real balance
          if (amountIn > bal) amountIn = bal;
        }
        const r = await (side === "buy" ? client.buy : client.sell)({ token: token as Address, side, amountIn, minAmountOut: BigInt(0), deadline: 0 });
        setLast(`${side === "buy" ? "▲" : "▼"} $${usd} ✓ ${r.txHash.slice(0, 10)}…`);
        return { ok: r.ok, txHash: r.txHash, reason: r.reason };
      } catch (e) {
        const m = (e as Error).message.split("\n")[0].slice(0, 90);
        setLast(`✕ ${m}`);
        return { ok: false, reason: m };
      }
    };
    return () => { delete window.__discipleTrade; };
  }, [token, live]);

  // Preview for the selected ammo from on-chain views (curve quoteBuy/quoteSell, router quoteExactIn).
  useEffect(() => {
    if (!valid) return;
    let alive = true;
    const usd = ammo.usd[mode] ?? MODES[mode].usd;
    (async () => {
      try {
        const pc = publicClient();
        const b = await readQuote(pc, token as Address, "buy", await usdToAmountIn(pc, token as Address, "buy", usd));
        const s = await readQuote(pc, token as Address, "sell", await usdToAmountIn(pc, token as Address, "sell", usd));
        if (alive) setPreview(`impact ▲${b.impactPct.toFixed(2)}% ▼${Math.abs(s.impactPct).toFixed(2)}% · ${b.venue}${b.snipeFee > BigInt(0) ? " · anti-snipe fee" : ""}`);
      } catch { if (alive) setPreview(""); }
    })();
    return () => { alive = false; };
  }, [mode, token, valid, ammo.usd]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const s = SELLS.find((x) => x.key === e.code); if (s && !e.repeat && !e.ctrlKey && !e.metaKey) sellRef.current?.(s);
    };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, []);
  if (!valid) return <AmmoTierNotice />;
  const customUsd = +custom > 0 ? +custom : 0;
  const shoot = (side: "buy" | "sell", extra?: { usd?: number; frac?: number }) =>
    window.dispatchEvent(new CustomEvent("disciple:shoot", { detail: { side, mode, ...(extra || (customUsd ? { usd: customUsd } : {})) } }));
  // sell sizing from the PnL ledger (real mark): x% of the position value, or enough to recover the cost basis
  const sellPlan = (s: (typeof SELLS)[number]) => {
    if (!(pos.valueUsd > 0)) return null;
    if (s.id === "init") { const usd = Math.min(pos.valueUsd, pos.costBasis / (1 - FEE)); return { usd, frac: usd / pos.valueUsd }; }
    return { usd: pos.valueUsd * s.frac, frac: s.frac };
  };
  const sell = (s: (typeof SELLS)[number]) => { const p = sellPlan(s); if (p && p.usd > 0) shoot("sell", { usd: +p.usd.toFixed(2), frac: p.frac }); };
  sellRef.current = sell;
  const btn = { all: "unset" as const, cursor: "pointer", padding: "6px 10px", borderRadius: 8, fontWeight: 700, fontSize: 12 };
  return (
    <>
    <AmmoTierNotice />
    <div aria-label="ammo" className="ap-bc" style={{ bottom: 14, zIndex: 31, display: "flex", flexDirection: "column", gap: 2,
      maxWidth: "min(530px, 92vw)", padding: "5px 8px", borderRadius: 12, background: "rgba(8,10,28,.85)",
      border: "1px solid rgba(255,231,163,.35)", color: "#eef0ff", fontFamily: "ui-monospace,monospace" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "nowrap", whiteSpace: "nowrap" }}>
      <input aria-label="custom buy amount" inputMode="decimal" placeholder="$ custom" value={custom}
        onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ""))}
        onKeyDown={(e) => { if (e.key === "Enter" && customUsd) { e.preventDefault(); shoot("buy"); } e.stopPropagation(); }}
        style={{ width: 70, fontSize: 11, padding: "3px 6px", borderRadius: 6, border: `1px solid ${customUsd ? "#9ff3c8" : "rgba(255,255,255,.2)"}`, background: "rgba(0,0,0,.4)", color: "#fff" }} />
      <select aria-label="ammo size" value={mode} onChange={(e) => setMode(+e.target.value)}
        style={{ background: "transparent", color: "#ffe7a3", border: "none", fontSize: 12, maxWidth: 130 }}>
        {MODES.map((m, i) => <option key={m.key} value={i} style={{ color: "#000" }}>{ammo.names[i] ?? m.name} ${(ammo.usd[i] ?? m.usd).toLocaleString()}</option>)}
      </select>
      {ammo.tier != null && (
        <select aria-label="ammo tier" title="ammo tier: presets scale with the rocket's mcap (pick any)" value={ammo.tier}
          onChange={(e) => dispatchEvent(new CustomEvent("disciple:ammo-tier", { detail: { tier: +e.target.value } }))}
          style={{ fontSize: 10, padding: "2px 4px", borderRadius: 6, border: "none", background: "rgba(159,243,200,.14)", color: "#9ff3c8" }}>
          {AMMO_TIERS.map((t, i) => <option key={t.id} value={i} style={{ color: "#000" }}>{t.name}{i === ammo.rocketTier ? " ●" : ""}</option>)}
        </select>
      )}
      <button type="button" aria-label="buy" onClick={() => shoot("buy")} style={{ ...btn, background: "#1f6f4a", color: "#c8ffe4" }}>▲ FUEL {customUsd ? `$${customUsd}` : "(buy)"}</button>
      <button type="button" aria-label="sell" onClick={() => shoot("sell")} style={{ ...btn, background: "#7a2236", color: "#ffd0dc" }}>▼ BOMB {customUsd ? `$${customUsd}` : "(sell)"}</button>
      </div>
      <div aria-label="sell presets" style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 10 }}>
        <span style={{ opacity: 0.6 }}>SELL</span>
        {SELLS.map((s) => { const p = sellPlan(s); return (
          <button key={s.id} type="button" aria-label={`sell ${s.label}`} disabled={!p || !(p.usd > 0)} onClick={() => sell(s)}
            title={`${s.id === "init" ? "sell enough to recover your cost basis" : `sell ${s.label} of your position`}${p ? ` ≈ $${p.usd.toFixed(2)}` : ""} · key ${s.key.slice(3)}`}
            className="ap-sellbtn"
            style={{ all: "unset", cursor: p && p.usd > 0 ? "pointer" : "default", padding: "2px 7px", borderRadius: 6, fontWeight: 700,
              background: "rgba(122,34,54,.55)", color: "#ffd0dc", opacity: p && p.usd > 0 ? 1 : 0.4 }}>{s.label}<span style={{ opacity: 0.55, marginLeft: 3 }}>{s.key.slice(3)}</span></button>); })}
        <span style={{ opacity: 0.6, marginLeft: "auto" }}>{pos.valueUsd > 0 ? `pos $${pos.valueUsd.toFixed(2)}` : "no position"}</span>
        <span title={live ? "wallet signs each shot" : "paper trades — connect wallet to trade"} style={{ fontSize: 10, padding: "2px 6px", borderRadius: 6,
        background: live ? "rgba(159,243,200,.14)" : "rgba(255,231,163,.14)", color: live ? "#9ff3c8" : "#ffe7a3" }}>{live ? "LIVE" : "PAPER"}</span>
      </div>
      {(last || preview) && <div style={{ fontSize: 10, opacity: 0.8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: last ? "#ffe7a3" : undefined }}>{last || preview}</div>}
    </div>
    </>
  );
}
