"use client";

import { useEffect, useState } from "react";
import { isDeployed } from "@/lib/chains";
import { MODES } from "@/lib/config";
import type { Address } from "@/lib/protocol";
import { createViemProtocol, publicClient, readQuote, tokenBalance, usdToAmountIn } from "@/lib/protocol-viem";
import { activeAddress, isSmartMode, onWallet } from "@/lib/wallet";
import AmmoTierNotice from "./AmmoTierNotice";
import { AMMO_TIERS } from "@/lib/flight/ammoTiers";

type Ammo = { tier: number | null; rocketTier?: number | null; name: string | null; usd: number[]; names: string[]; mode: number };

type Bridge = (side: "buy" | "sell", usd: number) => Promise<{ ok: boolean; reason?: string; txHash?: string }>;
declare global { interface Window { __discipleTrade?: Bridge } }

/**
 * Ammo bar + bridge: the flight engine's shots (keys / these buttons) become real trades once a wallet is
 * connected — buy/sell(…, recipient) on the curve, DiscipleRouter after graduation; approve once per spender.
 * No chain or no wallet ⇒ no bridge ⇒ engine keeps paper fills (mock/replay unchanged).
 */
export default function TradeBridge({ token }: { token: string }) {
  const [mode, setMode] = useState(2);
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
    window.__discipleTrade = async (side, usd) => {
      try {
        setLast(`${side === "buy" ? "▲" : "▼"} $${usd} ${isSmartMode() ? "· sending…" : "· confirm in wallet…"}`);
        let amountIn = await usdToAmountIn(pc, token as Address, side, usd);
        if (side === "sell") {
          const me = await activeAddress();
          const bal = await tokenBalance(pc, token as Address, me);
          if (bal === BigInt(0)) { setLast("no tokens to sell"); return { ok: false, reason: "no tokens to sell" }; }
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

  if (!valid) return <AmmoTierNotice />;
  const shoot = (side: "buy" | "sell") => window.dispatchEvent(new CustomEvent("disciple:shoot", { detail: { side, mode } }));
  const btn = { all: "unset" as const, cursor: "pointer", padding: "6px 10px", borderRadius: 8, fontWeight: 700, fontSize: 12 };
  return (
    <>
    <AmmoTierNotice />
    <div aria-label="ammo" style={{ position: "fixed", bottom: 18, left: "50%", transform: "translateX(-50%)", zIndex: 31, display: "flex", gap: 6,
      alignItems: "center", flexWrap: "wrap", maxWidth: "92vw", padding: "6px 8px", borderRadius: 12, background: "rgba(8,10,28,.85)",
      border: "1px solid rgba(255,231,163,.35)", color: "#eef0ff", fontFamily: "ui-monospace,monospace" }}>
      <select aria-label="ammo size" value={mode} onChange={(e) => setMode(+e.target.value)}
        style={{ background: "transparent", color: "#ffe7a3", border: "none", fontSize: 12 }}>
        {MODES.map((m, i) => <option key={m.key} value={i} style={{ color: "#000" }}>{ammo.names[i] ?? m.name} ${(ammo.usd[i] ?? m.usd).toLocaleString()}</option>)}
      </select>
      {ammo.tier != null && (
        <select aria-label="ammo tier" title="ammo tier: presets scale with the rocket's mcap (pick any)" value={ammo.tier}
          onChange={(e) => dispatchEvent(new CustomEvent("disciple:ammo-tier", { detail: { tier: +e.target.value } }))}
          style={{ fontSize: 10, padding: "2px 4px", borderRadius: 6, border: "none", background: "rgba(159,243,200,.14)", color: "#9ff3c8" }}>
          {AMMO_TIERS.map((t, i) => <option key={t.id} value={i} style={{ color: "#000" }}>{t.name}{i === ammo.rocketTier ? " ●" : ""}</option>)}
        </select>
      )}
      <button type="button" aria-label="buy" onClick={() => shoot("buy")} style={{ ...btn, background: "#1f6f4a", color: "#c8ffe4" }}>▲ FUEL (buy)</button>
      <button type="button" aria-label="sell" onClick={() => shoot("sell")} style={{ ...btn, background: "#7a2236", color: "#ffd0dc" }}>▼ BOMB (sell)</button>
      <span style={{ fontSize: 11, color: live ? "#9ff3c8" : "#ffe7a3" }}>{live ? "LIVE · wallet signs" : "PAPER · connect wallet to trade"}</span>
      {preview && <span style={{ fontSize: 11, opacity: 0.75 }}>{preview}</span>}
      {last && <span style={{ fontSize: 11, color: "#ffe7a3" }}>{last}</span>}
    </div>
    </>
  );
}
