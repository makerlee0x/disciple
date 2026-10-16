"use client";

import { useEffect, useRef, useState } from "react";
import { isDeployed } from "@/lib/chains";
import { MODES } from "@/lib/config";
import type { Address } from "@/lib/protocol";
import { createViemProtocol, publicClient, readQuote, tokenBalance, usdToAmountIn } from "@/lib/protocol-viem";
import { activeAddress, isSmartMode, onWallet } from "@/lib/wallet";
import AmmoTierNotice from "./AmmoTierNotice";
import { AMMO_TIERS } from "@/lib/flight/ammoTiers";
import { fmtMoney } from "@/lib/pnl";
import SwapSettingsModal from "./trade/SwapSettingsModal";
import { SELL_KEYS, SWAP_PREFIX, loadSettings, saveSettings, sellLabel, slippageBps, type SellSlot, type SwapSettings } from "@/lib/trade/swapSettings";

type Ammo = { tier: number | null; rocketTier?: number | null; name: string | null; usd: number[]; names: string[]; mode: number };

type Bridge = (side: "buy" | "sell", usd: number, o?: { frac?: number }) => Promise<{ ok: boolean; reason?: string; txHash?: string }>;
declare global { interface Window { __discipleTrade?: Bridge } }

/**
 * Ammo bar + bridge: the flight engine's shots (keys / these buttons) become real trades once a wallet is
 * connected — buy/sell(…, recipient) on the curve, DiscipleRouter after graduation; approve once per spender.
 * No chain or no wallet ⇒ no bridge ⇒ engine keeps paper fills (mock/replay unchanged).
 */
type Pos = { size: number; valueUsd: number; costBasis: number };
/** % sells (default 10/25/50/100). Keys Z/X/C/V; the 4 slots are editable in Swap settings.
 * The SELL row itself is drawn in the engine's AMMO panel. Clicking a preset only SELECTS it (disciple:sellselect);
 * DUMP / Shift (disciple:dump) sells the selected %, Z/X/C/V sell instantly and select. */
type Sell = { id: string; label: string; frac: number; key: string };
const toSells = (sl: SellSlot[]): Sell[] => sl.map((v, i) => ({ id: String(v), label: sellLabel(v), frac: v / 100, key: SELL_KEYS[i] }));
const DEFAULT_SELL_SEL = 1;   // 25%

/** Bottom bar = custom $ + BOOST (buy) / DUMP (sell) + position/paper badge. storagePrefix scopes Swap settings (sim has its own). */
export default function TradeBridge({ token, storagePrefix = SWAP_PREFIX }: { token: string; storagePrefix?: string }) {
  const [mode, setMode] = useState(2);
  const [custom, setCustom] = useState("");
  const sellRef = useRef<((s: Sell) => void) | null>(null);
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
  // Swap settings, per scope (sim / paper / live)
  const scope = storagePrefix + (live ? "live" : "paper");
  const [cfg, setCfg] = useState<SwapSettings>(() => loadSettings(scope));
  const cfgRef = useRef(cfg); cfgRef.current = cfg;
  const [showCfg, setShowCfg] = useState(false);
  useEffect(() => { setCfg(loadSettings(scope)); }, [scope]);
  const SELLS = toSells(cfg.sells);
  // push overrides + tag state to the engine (again whenever it (re)announces ammo, i.e. after boot)
  const pushCfg = useRef(() => {});
  pushCfg.current = () => { dispatchEvent(new CustomEvent("disciple:ammo-override", { detail: { usd: cfgRef.current.buy } })); dispatchEvent(new CustomEvent("disciple:pnltag", { detail: { on: cfgRef.current.tag } })); };
  const booted = useRef(false);
  useEffect(() => { pushCfg.current(); }, [cfg]);
  useEffect(() => { const h = () => { if (!booted.current) { booted.current = true; pushCfg.current(); } }; addEventListener("disciple:ammo", h); return () => removeEventListener("disciple:ammo", h); }, []);
  useEffect(() => { const o = () => setShowCfg(true); const t = (e: Event) => { const on = !!(e as CustomEvent<{ on: boolean }>).detail?.on; if (on !== cfgRef.current.tag) { const n = { ...cfgRef.current, tag: on }; setCfg(n); saveSettings(scope, n); } };
    addEventListener("disciple:swapsettings", o); addEventListener("disciple:pnltag-state", t); return () => { removeEventListener("disciple:swapsettings", o); removeEventListener("disciple:pnltag-state", t); }; }, [scope]);

  useEffect(() => {
    if (!live) return;
    const client = createViemProtocol();
    const pc = publicClient();
    window.__discipleTrade = async (side, usd, o) => {
      try {
        setLast(`${side === "buy" ? "▲" : "▼"} ${fmtMoney(usd)} ${isSmartMode() ? "· sending…" : "· confirm in wallet…"}`);
        let amountIn = await usdToAmountIn(pc, token as Address, side, usd);
        if (side === "sell") {
          const me = await activeAddress();
          const bal = await tokenBalance(pc, token as Address, me);
          if (bal === BigInt(0)) { setLast("NO TOKENS IN WALLET"); return { ok: false, reason: "NO TOKENS IN WALLET" }; }
          if (o?.frac && o.frac > 0) amountIn = (bal * BigInt(Math.round(Math.min(1, o.frac) * 1e6))) / BigInt(1e6);   // % of the real balance
          if (amountIn > bal) amountIn = bal;
        }
        // minAmountOut 0 ⇒ protocol-viem derives it from an on-chain quote − slippage (Swap settings: Auto = 1% default, or Custom)
        const r = await (side === "buy" ? client.buy : client.sell)({ token: token as Address, side, amountIn, minAmountOut: BigInt(0), deadline: 0, slippageBps: slippageBps(cfgRef.current) });
        setLast(`${side === "buy" ? "▲" : "▼"} ${fmtMoney(usd)} ✓ ${r.txHash.slice(0, 10)}…`);
        setTimeout(() => dispatchEvent(new Event("disciple:livetrade")), 1500);   // refresh the real balance
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

  // remembered selections: buy preset (engine S.mode, restored on boot) and sell preset (default 25% = slot 0)
  const SEL_KEY = storagePrefix + "sel";
  const [sellSel, setSellSel] = useState(DEFAULT_SELL_SEL);
  const [sellCustom, setSellCustom] = useState("");
  const [sellUnit, setSellUnit] = useState<"%" | "$">("%");
  const selSell = useRef<(i: number) => void>(() => {}); selSell.current = (i: number) => { setSellSel(i); try { const o = JSON.parse(localStorage.getItem(SEL_KEY) || "{}"); localStorage.setItem(SEL_KEY, JSON.stringify({ ...o, sell: i, sv: 2 })); } catch { /* */ } };
  useEffect(() => { try { const o = JSON.parse(localStorage.getItem(SEL_KEY) || "{}");
    if (o.sell >= 0 && o.sell < 4) { const i = o.sv === 2 ? o.sell : [1, 2, 3, DEFAULT_SELL_SEL][o.sell];   // pre-10% layout: 25/50/100 shift right, INITIALS → 25%
      setSellSel(i); if (o.sv !== 2) localStorage.setItem(SEL_KEY, JSON.stringify({ ...o, sell: i, sv: 2 })); }
    if (o.sellUnit === "$" || o.sellUnit === "%") setSellUnit(o.sellUnit); } catch { /* */ } }, [SEL_KEY]);
  const pickUnit = (u: "%" | "$") => { setSellUnit(u); try { const o = JSON.parse(localStorage.getItem(SEL_KEY) || "{}"); localStorage.setItem(SEL_KEY, JSON.stringify({ ...o, sellUnit: u })); } catch { /* */ } };
  useEffect(() => {   // restore the buy selection once the engine announces its ammo, then remember every change
    let restored = false, tries = 0;   // retry until the engine (maybe still booting in its worker) echoes the saved mode
    const h = (e: Event) => { const m = (e as CustomEvent<{ mode: number }>).detail?.mode;
      try { const o = JSON.parse(localStorage.getItem(SEL_KEY) || "{}");
        if (!restored) { if (!(o.buy >= 0 && o.buy < 6) || o.buy === m || ++tries > 20) restored = true; else { dispatchEvent(new CustomEvent("disciple:shoot", { detail: { mode: o.buy } })); setMode(o.buy); return; } }
        if (typeof m === "number" && o.buy !== m) localStorage.setItem(SEL_KEY, JSON.stringify({ ...o, buy: m })); } catch { /* */ } };
    addEventListener("disciple:ammo", h); return () => removeEventListener("disciple:ammo", h);
  }, [SEL_KEY]);
  const dumpRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const i = (SELL_KEYS as readonly string[]).indexOf(e.code); if (i >= 0 && !e.repeat && !e.ctrlKey && !e.metaKey) { selSell.current(i); sellRef.current?.(toSells(cfgRef.current.sells)[i]); }   // shortcut: sell now + select
    };
    const c = (e: Event) => { const i = (e as CustomEvent<{ i: number }>).detail?.i; if (i >= 0 && i < 4) selSell.current(i); };
    const d = () => dumpRef.current?.();
    addEventListener("keydown", k); addEventListener("disciple:sellselect", c); addEventListener("disciple:dump", d);
    return () => { removeEventListener("keydown", k); removeEventListener("disciple:sellselect", c); removeEventListener("disciple:dump", d); };
  }, []);
  // SELL row labels/enabled → engine ammo panel
  // live: the wallet's real token balance decides whether selling is possible (polled + after each trade) → engine guard
  const [liveHas, setLiveHas] = useState<boolean | null>(null);
  useEffect(() => {
    if (!live) { setLiveHas(null); dispatchEvent(new CustomEvent("disciple:holdings", { detail: null })); return; }
    let alive = true; const pc = publicClient();
    const poll = async () => { try { const me = await activeAddress(); if (!me) return; const b = await tokenBalance(pc, token as Address, me);
      if (alive) { setLiveHas(b > BigInt(0)); dispatchEvent(new CustomEvent("disciple:holdings", { detail: { has: b > BigInt(0) } })); } } catch { /* keep last */ } };
    void poll(); const iv = setInterval(poll, 10_000); addEventListener("disciple:livetrade", poll);
    return () => { alive = false; clearInterval(iv); removeEventListener("disciple:livetrade", poll); };
  }, [live, token]);
  const has = live && liveHas != null ? liveHas : pos.size > 0;
  const [hint, setHint] = useState("");
  useEffect(() => { if (!hint) return; const t = setTimeout(() => setHint(""), 1400); return () => clearTimeout(t); }, [hint]);
  const sellSig = SELLS.map((x) => x.id).join() + "|" + (has ? 1 : 0) + "|" + (pos.costBasis > 0 ? 1 : 0) + "|" + sellSel;
  const pushSells = useRef(() => {});
  pushSells.current = () => { const items = toSells(cfgRef.current.sells).map((x, i) => ({ label: x.label, key: x.key.slice(3), on: has, sel: i === sellSel }));
    dispatchEvent(new CustomEvent("disciple:sellpresets", { detail: { items } })); };
  useEffect(() => { pushSells.current(); }, [sellSig]);
  useEffect(() => { let n = 0; const h = () => { if (n++ < 3) pushSells.current(); }; addEventListener("disciple:ammo", h); return () => removeEventListener("disciple:ammo", h); }, []);   // engine may boot after mount (worker)
  const customUsd = +custom > 0 ? +custom : 0;
  const shoot = (side: "buy" | "sell", extra?: { usd?: number; frac?: number }) =>
    window.dispatchEvent(new CustomEvent("disciple:shoot", { detail: { side, mode, ...(extra || (customUsd ? { usd: customUsd } : {})) } }));
  // sell sizing from the PnL ledger (real mark): x% of the position value
  const sellPlan = (frac: number) => {
    if (!(pos.valueUsd > 0)) return live && liveHas ? { usd: 0.01, frac } : null;   // live wallet bag the ledger doesn't know: frac of the real balance
    return { usd: pos.valueUsd * frac, frac };
  };
  const sellFrac = (frac: number) => { if (!has) { setHint("NO TOKENS IN WALLET"); return; } const p = sellPlan(Math.min(1, frac)); if (p && p.usd > 0) shoot("sell", { usd: +p.usd.toFixed(2), frac: p.frac }); };
  const sell = (s: Sell) => sellFrac(s.frac);
  sellRef.current = sell;
  const selSellPreset = SELLS[sellSel] || SELLS[DEFAULT_SELL_SEL];
  // custom sell: % of holdings (≤ 100) or a $ value capped at the position value; overrides the selected preset (same rule as custom buy $)
  const sellCustomN = +sellCustom > 0 ? +sellCustom : 0;
  const customSellPct = sellUnit === "%" && sellCustomN ? Math.min(100, sellCustomN) : 0;
  const customSellUsd = sellUnit === "$" && sellCustomN ? (pos.valueUsd > 0 ? Math.min(sellCustomN, pos.valueUsd) : sellCustomN) : 0;
  const dumpLabel = customSellPct ? `${+customSellPct.toFixed(2)}%` : customSellUsd ? fmtMoney(customSellUsd) : selSellPreset.label;
  dumpRef.current = () => {
    if (customSellPct) return sellFrac(customSellPct / 100);
    if (customSellUsd) { if (!has) { setHint("NO TOKENS IN WALLET"); return; } if (!(pos.valueUsd > 0)) { setHint("position value unknown: use %"); return; }
      return shoot("sell", { usd: +customSellUsd.toFixed(2), frac: Math.min(1, customSellUsd / pos.valueUsd) }); }
    sell(selSellPreset);
  };
  const fmtShot = fmtMoney;   // shared shorthand: $0.20 · $129.12 · $129.12K · $1.50M
  const btn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "8px 14px", borderRadius: 9, fontWeight: 800, fontSize: 13, letterSpacing: 0.5, textAlign: "center" };
  const autoUsd = ammo.tier != null ? AMMO_TIERS[ammo.tier].usd.slice() : MODES.map((m) => m.usd);
  const shotUsd = customUsd || (ammo.usd[mode] ?? MODES[mode].usd);
  return (
    <>
    <AmmoTierNotice />
    <div aria-label="trade bar" data-testid="trade-bar" className="ap-bc" style={{ bottom: 14, zIndex: 31, display: "flex", flexDirection: "column", gap: 3,
      padding: "6px 8px", borderRadius: 14, background: "rgba(8,10,28,.85)", border: "1px solid rgba(255,231,163,.3)", color: "#eef0ff", fontFamily: "ui-monospace,monospace" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
        <input aria-label="custom amount" inputMode="decimal" placeholder={fmtMoney(ammo.usd[mode] ?? MODES[mode].usd)} value={custom} title="custom $: when filled it overrides the selected BUY preset for BOOST / Space (clear it to use the preset)"
          onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ""))}
          onKeyDown={(e) => { if (e.key === "Enter" && customUsd) { e.preventDefault(); shoot("buy"); } e.stopPropagation(); }}
          style={{ width: 78, fontSize: 12, padding: "7px 8px", borderRadius: 8, border: `1px solid ${customUsd ? "#9ff3c8" : "rgba(255,255,255,.18)"}`, background: "rgba(0,0,0,.4)", color: "#fff" }} />
        <button type="button" aria-label="buy" data-testid="buy-btn" title={`BOOST (Space): buy ${fmtShot(shotUsd)}${customUsd ? " — custom amount (overrides the selected preset)" : " — the selected preset"}`} onClick={() => shoot("buy")} style={{ ...btn, minWidth: 116, background: "#1f6f4a", color: "#c8ffe4" }}>▲ BOOST {fmtShot(shotUsd)}{customUsd ? <span style={{ fontSize: 9, opacity: 0.8, fontWeight: 600 }}> custom</span> : null}</button>
        <button type="button" aria-label="sell" data-testid="sell-btn" title={has ? `DUMP (Shift): sell ${dumpLabel}${sellCustomN ? ` — custom ${sellUnit === "%" ? "% of holdings" : "$ (capped at position value)"}, overrides the selected preset` : " — the selected SELL preset"}` : "NO TOKENS IN WALLET"} aria-disabled={!has} disabled={!has} onClick={() => dumpRef.current?.()}
          style={{ ...btn, minWidth: 104, background: "#7a2236", color: "#ffd0dc", opacity: has ? 1 : 0.4, cursor: has ? "pointer" : "not-allowed" }}>▼ DUMP {dumpLabel}{sellCustomN ? <span style={{ fontSize: 9, opacity: 0.8, fontWeight: 600 }}> custom</span> : null}</button>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
          <input aria-label="custom sell amount" data-testid="custom-sell" inputMode="decimal" placeholder={sellUnit === "%" ? selSellPreset.label : "$ value"} value={sellCustom}
            title={`custom sell: ${sellUnit === "%" ? "% of holdings" : "$ value, capped at your position value"}. When filled it overrides the selected SELL preset for DUMP / Shift (clear it to use the preset)`}
            onChange={(e) => setSellCustom(e.target.value.replace(/[^\d.]/g, ""))}
            onKeyDown={(e) => { if (e.key === "Enter" && sellCustomN) { e.preventDefault(); dumpRef.current?.(); } e.stopPropagation(); }}
            style={{ width: 58, fontSize: 12, padding: "7px 6px", borderRadius: 8, border: `1px solid ${sellCustomN ? "#ffb0c8" : "rgba(255,255,255,.18)"}`, background: "rgba(0,0,0,.4)", color: "#fff" }} />
          <button type="button" data-testid="sell-unit" aria-label={`custom sell unit: ${sellUnit}`} title="toggle: % of holdings ↔ $ value" onClick={() => pickUnit(sellUnit === "%" ? "$" : "%")}
            style={{ ...btn, padding: "6px 7px", fontSize: 11, background: "rgba(255,176,200,.14)", color: "#ffd0dc" }}>{sellUnit}</button>
        </span>
        <div style={{ display: "grid", gap: 1, fontSize: 10, lineHeight: 1.2, minWidth: 64 }}>
          <span title={live ? "wallet signs each shot" : "paper trades — connect wallet to trade"} style={{ justifySelf: "start", padding: "1px 6px", borderRadius: 5,
            background: live ? "rgba(159,243,200,.14)" : "rgba(255,231,163,.14)", color: live ? "#9ff3c8" : "#ffe7a3" }}>{live ? "LIVE" : valid ? "PAPER" : token === "SIMULATOR" ? "SIM" : "PAPER"}</span>
          <span style={{ opacity: 0.65 }}>{pos.valueUsd > 0 ? `pos ${fmtMoney(pos.valueUsd)}` : "no position"}</span>
        </div>
      </div>
      {hint && <div data-testid="trade-hint" style={{ fontSize: 10, color: "#ffb0c8" }}>{hint}</div>}
      {!hint && (last || preview) && <div style={{ fontSize: 10, opacity: 0.8, maxWidth: 380, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: last ? "#ffe7a3" : undefined }}>{last || preview}</div>}
    </div>
    {showCfg && <SwapSettingsModal initial={cfg} autoUsd={autoUsd} tier={ammo.tier} scope={`${live ? "live" : storagePrefix.includes("sim") ? "simulator" : "paper"} settings`}
      onClose={() => setShowCfg(false)}
      onSave={(n, t) => { setCfg(n); saveSettings(scope, n); if (t != null && t !== ammo.tier && !n.buy) dispatchEvent(new CustomEvent("disciple:ammo-tier", { detail: { tier: t } })); setShowCfg(false); }} />}
    </>
  );
}
