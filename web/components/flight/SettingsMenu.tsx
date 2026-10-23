"use client";
/**
 * ESC SETTINGS MENU (flight page). ESC (or the gear top-right, or / · F1 for Controls) opens it, ESC closes it.
 * While it is open (or the Share modal it launched), gameplay hotkeys don't fire: a window capture-phase listener swallows
 * keys aimed at the game, and the engine also gets disciple:menu {open} (belt and braces, incl. the worker render path).
 * ESC is left to whatever owns it first: Touch Grass (exits), an open Swap settings / Share modal, a wallet popover, or a
 * focused text field.
 *
 * Sections: Share (ShareModal "share your trade" + rocket-card PNG), Hotkeys (key per buy preset / sell size, persisted in
 * lib/game/settings; amounts = Swap settings via TradeBridge), Sound (SFX / music on/off + volume, persisted; no audio
 * engine yet, see lib/game/audio.ts), Language (lib/game/i18n, drafts pending review), Display (Touch Grass, Orbs),
 * Controls (reference + live mode line). Look: the HUD's navy glass + gold hairline (PnlHud / trade bar).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/icons/Icon";
import ShareButton from "@/components/ShareButton";
import ShareModal, { type ShareTarget } from "@/components/share/ShareModal";
import ControlsReference, { useControlsFeed } from "@/components/ControlsPill";
import { MODES } from "@/lib/config";
import { DEFAULT_BUY, DEFAULT_SELLS } from "@/lib/trade/swapSettings";
import { onWallet } from "@/lib/wallet";
import { localUsername } from "@/lib/profile";
import { DEFAULT_BUY_KEYS, DEFAULT_SELL_KEYS, bindKey, broadcast, isBindable, keyLabel, setGameSettings, useGameSettings } from "@/lib/game/settings";
import { LOCALES, REVIEW_STATUS, useT, type I18nKey } from "@/lib/game/i18n";
import { previewBlip } from "@/lib/game/audio";

type Tab = "share" | "hotkeys" | "audio" | "lang" | "display" | "controls";
const TABS: [Tab, I18nKey][] = [["share", "sec.share"], ["hotkeys", "sec.hotkeys"], ["audio", "sec.audio"], ["lang", "sec.lang"], ["display", "sec.display"], ["controls", "sec.controls"]];
type Slot = { kind: "buy" | "sell"; i: number };
const typing = (t: EventTarget | null) => { const e = t as HTMLElement | null; return !!e && !!e.tagName && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)); };
const GOLD = "#ffe7a3", INK = "#fff7df", DIM = "rgba(220,228,255,.62)";
const money = (v: number) => (v < 1 ? (+v.toFixed(2)).toString() : (+v.toPrecision(6)).toString());

export default function SettingsMenu({ coin, ticker, icon, simulator = false }: { coin: string; ticker: string; icon?: string | null; simulator?: boolean }) {
  const t = useT();
  const gs = useGameSettings();
  const ctl = useControlsFeed();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("share");
  const [listen, setListen] = useState<Slot | null>(null);
  const [note, setNote] = useState("");
  const [share, setShare] = useState<ShareTarget | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [grass, setGrass] = useState(false);
  const [orbs, setOrbs] = useState(true);
  const [ammoUsd, setAmmoUsd] = useState<number[]>(MODES.map((m) => m.usd));
  const [presets, setPresets] = useState<{ buy: number[] | null; sells: number[] }>({ buy: null, sells: DEFAULT_SELLS });
  const [buyDraft, setBuyDraft] = useState<string[]>([]);
  const [sellDraft, setSellDraft] = useState<string[]>([]);
  const [buyAuto, setBuyAuto] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const st = useRef({ open, listen, share: !!share }); st.current = { open, listen, share: !!share };

  const flash = (m: string) => { setNote(m); window.setTimeout(() => setNote((n) => (n === m ? "" : n)), 1600); };
  const openMenu = useCallback((tb?: Tab) => { if (tb) setTab(tb); setOpen(true); dispatchEvent(new Event("disciple:presets-query")); dispatchEvent(new CustomEvent("disciple:orbs", { detail: {} })); }, []);
  const close = useCallback(() => { setOpen(false); setListen(null); }, []);

  // engine/game state mirrors
  useEffect(() => onWallet((a) => setWallet(a ? a.toLowerCase() : null)), []);
  useEffect(() => {
    try { setOrbs(localStorage.getItem("disciple.orbs") !== "off"); } catch { /* */ }
    const g = (e: Event) => setGrass(!!(e as CustomEvent<{ on: boolean }>).detail?.on);
    const o = (e: Event) => setOrbs(!!(e as CustomEvent<{ on: boolean }>).detail?.on);
    const a = (e: Event) => { const d = (e as CustomEvent<{ usd: number[] }>).detail; if (Array.isArray(d?.usd)) setAmmoUsd(d.usd); };
    const p = (e: Event) => { const d = (e as CustomEvent<{ buy: number[] | null; sells: number[] }>).detail; if (d) setPresets({ buy: d.buy, sells: d.sells }); };
    // hotkeys → engine again whenever it (re)announces itself (boot / worker restart); first few only
    let n = 0; const boot = () => { if (n++ < 3) broadcast(); };
    addEventListener("disciple:grass", g); addEventListener("disciple:orbstate", o); addEventListener("disciple:ammo", a); addEventListener("disciple:presets", p); addEventListener("disciple:ammo", boot);
    broadcast(); dispatchEvent(new Event("disciple:presets-query"));
    return () => { removeEventListener("disciple:grass", g); removeEventListener("disciple:orbstate", o); removeEventListener("disciple:ammo", a); removeEventListener("disciple:presets", p); removeEventListener("disciple:ammo", boot); };
  }, []);
  // amount drafts follow the live values while the hotkeys tab isn't being edited
  const editing = useRef(false);
  useEffect(() => { if (editing.current) return; setBuyAuto(!presets.buy); setBuyDraft((presets.buy || DEFAULT_BUY).map(money)); setSellDraft(DEFAULT_SELLS.map(String)); }, [presets, ammoUsd, open]);   // sells are fixed

  // tell the engine (and anyone else) that gameplay input is paused
  const paused = open || !!share;
  useEffect(() => { dispatchEvent(new CustomEvent("disciple:menu", { detail: { open: paused } })); }, [paused]);
  useEffect(() => () => { dispatchEvent(new CustomEvent("disciple:menu", { detail: { open: false } })); }, []);
  useEffect(() => { if (open) window.setTimeout(() => boxRef.current?.focus(), 0); else editing.current = false; }, [open]);

  // keyboard: capture phase so it runs before the engine / trade bar / chat listeners
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const s = st.current;
      if (s.share) { if (e.code !== "Escape") e.stopImmediatePropagation(); return; }   // Share modal: it owns ESC; game keys paused
      if (s.open) {
        if (s.listen) {   // rebinding: next key press is the new binding
          e.preventDefault(); e.stopImmediatePropagation();
          if (e.code === "Escape") { setListen(null); return; }
          if (!isBindable(e.code)) { flash(t("hk.reserved") + ` (${e.code})`); return; }
          setGameSettings((g) => bindKey(g, s.listen!, e.code)); setListen(null); return;
        }
        if (e.code === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
        if (boxRef.current && boxRef.current.contains(e.target as Node)) return;   // inputs/buttons in the menu work (its onKeyDown stops bubbling to the game)
        e.stopImmediatePropagation();   // everything aimed at the game is swallowed while the menu is open
        return;
      }
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      const blocked = () => document.documentElement.classList.contains("ap-grass")
        || !!document.querySelector('[data-testid="swap-settings"], [role="dialog"][aria-modal="true"], [aria-label="wallet"] [role="menu"], [aria-label="Share card preview"]');
      if (e.code === "Escape") { if (blocked()) return; e.preventDefault(); e.stopImmediatePropagation(); openMenu(); return; }
      if (e.code === "F1" || (e.code === "Slash" && !e.shiftKey)) { if (blocked()) return; e.preventDefault(); e.stopImmediatePropagation(); openMenu("controls"); }
    };
    addEventListener("keydown", k, true);
    const o = () => openMenu(); addEventListener("disciple:settings-open", o);
    return () => { removeEventListener("keydown", k, true); removeEventListener("disciple:settings-open", o); };
  }, [close, openMenu, t]);

  const saveAmounts = () => {
    const b = buyDraft.map((v) => +v);   // only buy amounts are customisable; sell sizes are fixed 10/25/50/100%
    dispatchEvent(new CustomEvent("disciple:presets-set", { detail: { buy: buyAuto || !b.every((v) => v > 0 && Number.isFinite(v)) ? null : b } }));
    editing.current = false; flash(t("hk.saved"));
  };

  const card: React.CSSProperties = { position: "relative", width: 600, maxWidth: "94vw", maxHeight: "86vh", display: "flex", flexDirection: "column", borderRadius: 16, outline: "none",
    background: "linear-gradient(180deg,rgba(16,14,40,.96),rgba(8,10,26,.95))", border: "1px solid rgba(255,231,163,.5)", boxShadow: "0 0 0 1px rgba(0,0,0,.4), 0 24px 70px rgba(0,0,0,.65), 0 0 30px rgba(255,220,150,.12)",
    color: INK, font: "12px ui-monospace,monospace" };
  const pill = (on: boolean): React.CSSProperties => ({ all: "unset", cursor: "pointer", padding: "5px 10px", borderRadius: 9, fontWeight: 700, fontSize: 11, letterSpacing: ".05em", whiteSpace: "nowrap",
    border: `1px solid ${on ? "rgba(255,231,163,.85)" : "rgba(255,255,255,.16)"}`, background: on ? GOLD : "rgba(255,255,255,.04)", color: on ? "#151830" : "#e8ecff" });
  const btn: React.CSSProperties = { all: "unset", cursor: "pointer", boxSizing: "border-box", padding: "9px 12px", borderRadius: 10, fontWeight: 800, fontSize: 12, letterSpacing: ".04em",
    border: "1px solid rgba(255,231,163,.55)", background: "rgba(255,231,163,.08)", color: GOLD, display: "inline-flex", alignItems: "center", gap: 6 };
  const field: React.CSSProperties = { width: 74, boxSizing: "border-box", padding: "5px 6px", borderRadius: 7, border: "1px solid rgba(255,255,255,.18)", background: "rgba(0,0,0,.4)", color: "#fff", font: "12px ui-monospace,monospace", textAlign: "right" };
  const label: React.CSSProperties = { color: DIM, fontSize: 10, letterSpacing: ".08em" };
  const h = (k: I18nKey) => <div style={{ color: GOLD, fontWeight: 800, letterSpacing: ".08em", margin: "4px 0 8px", fontSize: 11 }}>{t(k).toUpperCase()}</div>;
  const toggle = (on: boolean, set: (v: boolean) => void, id: string) => (
    <button type="button" role="switch" aria-checked={on} data-testid={id} onClick={() => set(!on)} style={{ ...pill(on), minWidth: 44, textAlign: "center" }}>{on ? t("on") : t("off")}</button>);
  const keyBtn = (slot: Slot, code: string) => {
    const on = listen && listen.kind === slot.kind && listen.i === slot.i;
    return <button type="button" data-testid={`hk-${slot.kind}-${slot.i}`} onClick={() => setListen(on ? null : slot)} title={code}
      style={{ ...pill(!!on), minWidth: 64, textAlign: "center", color: on ? "#151830" : slot.kind === "buy" ? "#9ff3c8" : "#ffb0c8" }}>{on ? t("hk.press") : keyLabel(code) || "—"}</button>;
  };
  const shareable = /^0x[0-9a-fA-F]{40}$/.test(coin);

  return (
    <>
      <button type="button" data-testid="settings-btn" aria-label={t("settings.open")} title={t("settings.open")} onClick={() => openMenu()}
        /* Space is BOOST (engine): a focused gear must not ALSO re-open the menu on the same press (same guard as #103 BOOST/DUMP) */
        onKeyDown={(e) => { if (e.key === " ") e.preventDefault(); }} onKeyUp={(e) => { if (e.key === " ") e.preventDefault(); }}
        style={{ position: "fixed", top: "var(--ap-tr-top, 12px)", right: 60, zIndex: 35, width: 38, height: 38, display: "grid", placeItems: "center", borderRadius: "50%", cursor: "pointer",
          color: INK, background: "rgba(10,12,28,.82)", border: "1px solid rgba(255,231,163,.7)", boxShadow: "0 0 16px rgba(255,220,150,.35)", padding: 0 }}>
        <Icon name="gear" size={18} />
      </button>
      {open && (
        <div data-testid="settings-menu" role="dialog" aria-modal="true" aria-label={t("settings.title")}
          onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}
          style={{ position: "fixed", inset: 0, zIndex: 75, display: "grid", placeItems: "center", background: "rgba(4,5,14,.55)", backdropFilter: "blur(3px)" }}>
          <div ref={boxRef} tabIndex={-1} style={card} onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px 10px", borderBottom: "1px solid rgba(255,231,163,.18)" }}>
              <Icon name="gear" size={16} style={{ color: GOLD }} />
              <b style={{ color: GOLD, letterSpacing: ".14em", fontSize: 14 }}>{t("settings.title")}</b>
              <span style={{ ...label, marginLeft: 4 }}>{t("settings.paused")}</span>
              <button type="button" aria-label={t("settings.close")} title={t("settings.close")} data-testid="settings-close" onClick={close}
                style={{ all: "unset", cursor: "pointer", marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, color: DIM, fontSize: 10 }}>
                ESC <span style={{ width: 26, height: 26, display: "grid", placeItems: "center", borderRadius: "50%", border: "1px solid rgba(255,231,163,.5)", color: INK }}><Icon name="close" size={14} /></span>
              </button>
            </div>
            <div role="tablist" style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "10px 16px 0" }}>
              {TABS.map(([id, k]) => <button key={id} type="button" role="tab" aria-selected={tab === id} data-testid={`tab-${id}`} onClick={() => { setTab(id); setListen(null); }} style={pill(tab === id)}>{t(k).toUpperCase()}</button>)}
            </div>
            <div style={{ padding: "14px 16px 16px", overflow: "auto" }}>
              {tab === "share" && <div style={{ display: "grid", gap: 10 }}>
                {h("sec.share")}
                {shareable && <button type="button" data-testid="share-trade" style={btn}
                  onClick={() => { setShare({ coin, ticker: ticker || "ROCKET", wallet, username: localUsername() || null }); close(); }}>
                  <Icon name="share" size={14} /> {t("share.trade")}</button>}
                <ShareButton callSign={ticker || "AI"} icon={icon} label={t("share.card")} style={{ ...btn, color: "#e8ecff", borderColor: "rgba(255,255,255,.2)", background: "rgba(255,255,255,.04)" }} />
              </div>}

              {tab === "hotkeys" && <div onChange={() => { editing.current = true; }}>
                {h("sec.hotkeys")}
                <div style={{ ...label, marginBottom: 10, lineHeight: 1.5, letterSpacing: ".02em", fontSize: 11 }}>{t("hk.note")}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <div>
                    <div style={{ ...label, marginBottom: 6, color: "#9ff3c8" }}>{t("hk.buy").toUpperCase()} · $</div>
                    {MODES.map((m, i) => <div key={m.name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <span style={{ width: 84, fontSize: 10, opacity: 0.85 }}>{m.name}</span>
                      {keyBtn({ kind: "buy", i }, gs.keys.buy[i])}
                      <input aria-label={`${m.name} amount`} data-testid={`hk-buy-amt-${i}`} inputMode="decimal" value={buyDraft[i] ?? ""} style={{ ...field, color: buyAuto ? "rgba(255,255,255,.55)" : "#fff" }}
                        onChange={(e) => { setBuyAuto(false); const n = [...buyDraft]; n[i] = e.target.value.replace(/[^\d.]/g, ""); setBuyDraft(n); }} />
                    </div>)}
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, cursor: "pointer", marginTop: 4 }}>
                      <input type="checkbox" data-testid="hk-auto" checked={buyAuto} onChange={(e) => { setBuyAuto(e.target.checked); if (e.target.checked) setBuyDraft(DEFAULT_BUY.map(money)); }} /> {t("hk.auto")}
                    </label>
                  </div>
                  <div>
                    <div style={{ ...label, marginBottom: 6, color: "#ffb0c8" }}>{t("hk.sell").toUpperCase()} · %</div>
                    {[0, 1, 2, 3].map((i) => <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <span style={{ width: 52, fontSize: 10, opacity: 0.85 }}>SELL {i + 1}</span>
                      {keyBtn({ kind: "sell", i }, gs.keys.sell[i])}
                      <input aria-label={`sell size ${i + 1} percent`} data-testid={`hk-sell-amt-${i}`} inputMode="decimal" value={`${sellDraft[i] ?? DEFAULT_SELLS[i]}%`} readOnly aria-readonly title="fixed % of your bag (use the custom sell field for other sizes)" style={{ ...field, opacity: 0.7 }} />
                    </div>)}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <button type="button" data-testid="hk-save" onClick={saveAmounts} style={btn}><Icon name="check" size={14} /> {t("hk.save")}</button>
                  <button type="button" data-testid="hk-reset" onClick={() => setGameSettings((g) => ({ ...g, keys: { buy: DEFAULT_BUY_KEYS, sell: DEFAULT_SELL_KEYS } }))}
                    style={{ ...btn, color: "#e8ecff", borderColor: "rgba(255,255,255,.2)", background: "rgba(255,255,255,.04)" }}><Icon name="refresh" size={14} /> {t("hk.reset")}</button>
                  {note && <span role="status" style={{ color: "#ffb0c8", fontSize: 11 }}>{note}</span>}
                </div>
              </div>}

              {tab === "audio" && <div style={{ display: "grid", gap: 12 }}>
                {h("sec.audio")}
                {(["sfx", "music"] as const).map((ch) => <div key={ch} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ width: 130 }}>{t(ch === "sfx" ? "audio.sfx" : "audio.music")}</span>
                  {toggle(gs[ch].on, (v) => setGameSettings((g) => ({ ...g, [ch]: { ...g[ch], on: v } })), `audio-${ch}-toggle`)}
                  <input type="range" min={0} max={100} step={1} aria-label={`${ch} volume`} data-testid={`audio-${ch}-vol`} disabled={!gs[ch].on} value={Math.round(gs[ch].vol * 100)}
                    onChange={(e) => setGameSettings((g) => ({ ...g, [ch]: { ...g[ch], vol: +e.target.value / 100 } }))}
                    onPointerUp={(e) => { if (ch === "sfx") previewBlip(+(e.target as HTMLInputElement).value / 100); }}
                    style={{ flex: 1, accentColor: GOLD, opacity: gs[ch].on ? 1 : 0.4 }} />
                  <span style={{ width: 36, textAlign: "right", opacity: 0.8 }}>{Math.round(gs[ch].vol * 100)}%</span>
                </div>)}
                <div style={{ ...label, letterSpacing: ".02em", fontSize: 11 }}>{t("audio.note")}</div>
              </div>}

              {tab === "lang" && <div>
                {h("sec.lang")}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {LOCALES.map((l) => <button key={l.id} type="button" data-testid={`lang-${l.id}`} aria-pressed={gs.lang === l.id} lang={l.id}
                    onClick={() => setGameSettings((g) => ({ ...g, lang: l.id }))} style={{ ...pill(gs.lang === l.id), padding: "8px 14px", fontSize: 13 }}>{l.label}</button>)}
                </div>
                {REVIEW_STATUS[gs.lang] !== "source" && <div style={{ ...label, marginTop: 10, letterSpacing: ".02em", fontSize: 11 }}>{t("lang.review")}</div>}
              </div>}

              {tab === "display" && <div style={{ display: "grid", gap: 12 }}>
                {h("sec.display")}
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Icon name="grass" size={16} style={{ color: "#c8ffd8" }} />
                  <div style={{ flex: 1 }}><div>{t("disp.grass")}</div><div style={label}>{t("disp.grassHint")}</div></div>
                  {toggle(grass, (v) => { if (v !== grass) { dispatchEvent(new Event("disciple:grass-toggle")); if (v) close(); } }, "grass-toggle")}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Icon name="star" size={16} style={{ color: GOLD }} />
                  <div style={{ flex: 1 }}><div>{t("disp.orbs")}</div><div style={label}>{t("disp.orbsHint")}</div></div>
                  {toggle(orbs, (v) => { setOrbs(v); dispatchEvent(new CustomEvent("disciple:orbs", { detail: { on: v } })); }, "orbs-toggle")}
                </div>
              </div>}

              {tab === "controls" && <div>{h("sec.controls")}<ControlsReference c={ctl} simulator={simulator} /></div>}
            </div>
          </div>
        </div>
      )}
      {share && <ShareModal target={share} onClose={() => setShare(null)} />}
    </>
  );
}
