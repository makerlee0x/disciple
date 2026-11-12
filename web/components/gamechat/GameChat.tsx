"use client";

import type React from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { EMOTE_CODES, EMOTE_EMOJI, MAX_LEN, resolveChat, stressRate, synthMsg, type ChatApi, type ChatMsg, type ChatState } from "@/lib/gamechat/adapter";
import Icon, { BombTierIcons } from "@/components/ui/Icon";
import { appendRows, bombTier, fmtUsd, nameColor, parseEmotes, shortAddr, type Row } from "@/lib/gamechat/format";
import { holderLabelText, type HolderLabel } from "@/lib/flight/holders";
import { GRAD_BADGE } from "@/lib/flight/tiers";
import { useDomCard } from "@/lib/game/cardLayoutStore";
import { useHudMode } from "@/lib/game/hudMode";
import { HUD } from "@/lib/game/hudStyle";

/**
 * CREW FEED: the flight screen's one community card (right column). Trades, chat and holders in one place, with tabs
 * All | Trades | Chat | Holders (H cycles them when the card has focus, never while typing). All = trades + chat by time.
 * Trades are not chat: the chat store drops trade lines (lib/server/chat/store isTradeLine), so trade rows come from the
 * engine's own feed (public/flight/engine.js @crewfeed, disciple:feed) and are merged here, on screen only.
 * Pro adds a 5 minute boost vs dump momentum bar (lib/game/hudMode). DOM overlay only: the canvas never reads it.
 * Card placement in the right HUD column: from the KOTH slot
 * (the canvas KOTH steps aside while it is open) down to the Crew card above the MODE panel (--ap-crew-h),
 * so it never covers the HUD or the ammo bar at any width. ≤200 rows, batched flushes, column-reverse scroller
 * (newest at the bottom with no scroll math on append).
 */
const BADGE: Record<string, { i: React.ReactNode; t: string; c: string }> = {
  believer: { i: <Icon name="believer" size={12} />, t: "Believer", c: "#ffe7a3" }, trencher: { i: <Icon name="trencher" size={12} />, t: "Trencher", c: "#c9b6f2" }, bomber: { i: <Icon name="bomb" size={12} />, t: "Bomber", c: "#ff9fb8" },
  creator: { i: <Icon name="star" size={12} />, t: "Creator", c: "#8fd8ff" }, whale: { i: <Icon name="whale" size={12} />, t: "Whale", c: "#8ff0c0" }, mod: { i: <Icon name="shield" size={12} />, t: "Moderator", c: "#9ff3c8" },
};
const STATE: Record<ChatState | "init", { c: string; t: string }> = {
  init: { c: "#888", t: "…" }, connecting: { c: "#ffd24a", t: "connecting" }, live: { c: "#5df29a", t: "live" }, reconnecting: { c: "#ffa04a", t: "reconnecting" }, closed: { c: "#ff6b7d", t: "offline" },
};
const W_MIN = 260, W_DEF = 340, W_MAX = 560, FLUSH_MS = 200;
const typingTarget = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); };
type Tab = "all" | "trades" | "chat" | "holders";
const TABS: Tab[] = ["all", "trades", "chat", "holders"];
const TABS_TRADES: Tab[] = ["trades", "holders"];   // no coin chat (simulator, mock): trades + holders only
const TAB_LABEL: Record<Tab, string> = { all: "All", trades: "Trades", chat: "Chat", holders: "Holders" };
/** a trade row from the engine feed (disciple:feed): side/usd/who, or a notice (failed trade, wall cleared, reorg) */
export type FeedRow = { id: number; at: number; seen?: number; side?: "buy" | "sell"; usd?: number; amt?: string; who?: string; own?: boolean; ic?: string | null; note?: string; err?: boolean };
const FEED_CAP = 80, MOMENTUM_MS = 5 * 60_000;
/** merge newest-first engine rows into the kept list (oldest first): new ids appended, known ids updated (names resolve late) */
/** `seen` = when the row reached this card: replay / backfilled trades carry old chain times, chat carries now, so the
 *  merged list and the momentum bar order by arrival (a trade's own time within the last 10 minutes is kept). */
export function mergeFeed(kept: FeedRow[], incoming: FeedRow[], cap = FEED_CAP, now = Date.now()): FeedRow[] {
  const byId = new Map(kept.map((r) => [r.id, r] as const)); let changed = false;
  for (const r of incoming.slice().reverse()) { const k = byId.get(r.id); if (!k) { byId.set(r.id, { ...r, seen: r.at > 0 && now - r.at < 600_000 ? Math.min(r.at, now) : now }); changed = true; } else if (k.who !== r.who || k.ic !== r.ic) { byId.set(r.id, { ...k, who: r.who, ic: r.ic }); changed = true; } }
  if (!changed) return kept;
  const out = Array.from(byId.values()).sort((a, b) => (a.seen ?? a.at) - (b.seen ?? b.at) || a.id - b.id);
  return out.length > cap ? out.slice(out.length - cap) : out;
}
/** boosts vs dumps (USD) over the last 5 minutes */
export function momentum(rows: FeedRow[], now = Date.now()) {
  let up = 0, down = 0; for (const r of rows) { if (!r.side || !(r.usd! > 0) || now - (r.seen ?? r.at) > MOMENTUM_MS) continue; if (r.side === "buy") up += r.usd!; else down += r.usd!; }
  return { up, down, share: up + down > 0 ? up / (up + down) : 0.5 };
}
type HolderItem = { who: string; address: string; usd: number; pct: number; label: HolderLabel; mine: boolean };
/** rows: legacy [name, $] (session boosters on mock / sim / pool); items: REAL holders from on-chain balances (live coins:
 *  engine realHolders ← components/flight/HoldersBridge) — ranked rows first, labelled pool / curve / locker / burn rows after (friendly names: lib/flight/holders holderLabelText). */
type Holders = { title: string; rows: [string, number][]; you: number; items?: HolderItem[]; asOfBlock?: number | null };

/** Chat keys (H / Enter) apply only when the dock is open and focus is inside it — never from the game / trading surface. */
export function chatKeyApplies(o: { open: boolean; inDock: boolean; typing: boolean; mod: boolean }) { return o.open && o.inDock && !o.typing && !o.mod; }

/** tradesOnly: a flight with no coin chat (the simulator, a mock market): the same card with Trades + Holders only */
export default function GameChat({ coin, tradesOnly = false }: { coin: string; tradesOnly?: boolean }) {
  const tabs = tradesOnly ? TABS_TRADES : TABS;
  const [api, setApi] = useState<{ api: ChatApi; svg: boolean; source: string } | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [conn, setConn] = useState<ChatState | "init">("init");
  const [width, setWidth] = useState(W_DEF);
  const [unread, setUnread] = useState(0);
  const [text, setText] = useState("");
  const [err, setErr] = useState<{ kind: string; msg: string; until?: number } | null>(null);
  const [picker, setPicker] = useState(false);
  const [sending, setSending] = useState(false);
  const [, tick] = useState(0);
  const [tab, setTabS] = useState<Tab>(tradesOnly ? "trades" : "all");
  const [tabUnread, setTabUnread] = useState(0);   // chat messages that arrived while Trades / Holders was showing
  const [holders, setHolders] = useState<Holders | null>(null);
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const hud = useHudMode();
  const tabRef = useRef<Tab>(tradesOnly ? "trades" : "all");
  const setTab = useCallback((t: Tab) => { tabRef.current = t; setTabS(t); if (t === "chat" || t === "all") setTabUnread(0); try { localStorage.setItem("disciple.gamechat.tab", t); } catch { /* */ } }, []);
  const buf = useRef<ChatMsg[]>([]);
  const seen = useRef(new Set<string>());   // send() returns the msg AND the stream delivers it: dedupe by id
  const pinned = useRef(true);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  // One visible Holders / Chat card. Layout chrome can restore it as Holders; no standalone Chat pill.
  const card = useDomCard("chat", dockRef);
  const open = !card.hidden;
  const c = coin.toLowerCase();

  useEffect(() => { try { const w = +(localStorage.getItem("disciple.gamechat.w") || 0); if (w) setWidth(Math.max(W_MIN, Math.min(W_MAX, w))); const t = localStorage.getItem("disciple.gamechat.tab") as Tab | null; if (t && tabs.includes(t)) { tabRef.current = t; setTabS(t); } } catch { /* */ } }, [tabs]);
  // trade rows from the engine (public/flight/engine.js @crewfeed)
  useEffect(() => { const h = (e: Event) => { const d = (e as CustomEvent<{ rows?: FeedRow[] }>).detail; if (d && Array.isArray(d.rows)) setFeed((k) => mergeFeed(k, d.rows!)); };
    addEventListener("disciple:feed", h); return () => removeEventListener("disciple:feed", h); }, []);
  useEffect(() => { if (tradesOnly) return; let alive = true; resolveChat().then((r) => { if (alive && r) setApi({ api: r.api, svg: r.svgEmotes, source: r.source }); }); return () => { alive = false; }; }, [tradesOnly]);
  // history + subscribe; incoming messages are buffered and flushed ≤ every 150 ms (one React commit per batch)
  useEffect(() => {
    if (!api) return;
    let stop = () => {}, alive = true;
    api.api.history(c, { limit: 60 }).then((h) => { if (alive) buf.current.unshift(...h); }).catch(() => {});
    stop = api.api.subscribe(c, (m) => { buf.current.push(m); }, { onState: (s) => alive && setConn(s) });
    const fl = window.setInterval(() => {
      if (!buf.current.length) return;
      const inc = buf.current.splice(0).filter((m) => { if (seen.current.has(m.id)) return false; seen.current.add(m.id); return true; });
      if (seen.current.size > 2000) { const keep = Array.from(seen.current).slice(-1000); seen.current = new Set(keep); }
      if (!inc.length) return; if (inc.length > 400) inc.splice(0, inc.length - 400);
      setRows((r) => appendRows(r, inc));
      if (!pinned.current) setUnread((u) => u + inc.length);
      if (tabRef.current === "holders" || tabRef.current === "trades") setTabUnread((u) => u + inc.filter((m) => m.kind !== "event").length);
    }, FLUSH_MS);
    const rate = stressRate(); let sv = 0;
    if (rate > 0) { let acc = 0; sv = window.setInterval(() => { acc += rate * 0.05; while (acc >= 1) { acc -= 1; buf.current.push(synthMsg(c)); } }, 50); }
    return () => { alive = false; stop(); clearInterval(fl); if (sv) clearInterval(sv); };
  }, [api, c]);
  // tell the engine the dock (with its HOLDERS tab) is in use → the canvas KOTH panel steps aside and streams holders here.
  // Re-announced every 3 s while no holders arrived (engine may boot after us); the engine only pushes on change.
  const lastHolders = useRef(0);
  useEffect(() => {
    const h = (e: Event) => { lastHolders.current = Date.now(); setHolders((e as CustomEvent<Holders>).detail); };
    addEventListener("disciple:holders", h);
    // until the first holders push: re-announce every 400 ms (was 3 s ⇒ the stacked-lists window); then every 3 s
    const iv = window.setInterval(() => { const quiet = Date.now() - lastHolders.current; if (open && (lastHolders.current === 0 || quiet > 3000)) dispatchEvent(new CustomEvent("disciple:chatdock", { detail: { open, holders: true } })); }, 400);
    return () => { removeEventListener("disciple:holders", h); clearInterval(iv); };
  }, [open]);
  // pass 3 #5: also a window flag the engine reads every frame (worker-mirrored) ⇒ its canvas TOP HOLDERS box never draws
  // under the open dock, even before the engine has heard disciple:chatdock
  useEffect(() => { const w = window as unknown as { __chatDockOpen?: boolean }; w.__chatDockOpen = open; return () => { w.__chatDockOpen = false; }; }, [open]);
  useEffect(() => { dispatchEvent(new CustomEvent("disciple:chatdock", { detail: { open, holders: true } })); }, [open]);
  useEffect(() => () => { dispatchEvent(new CustomEvent("disciple:chatdock", { detail: { open: false } })); }, []);
  // The card is visible by default but never takes keys while you trade. Keys act ONLY when it has focus
  // (you clicked into it): H = CHAT ↔ HOLDERS, Enter = focus the message box. Anywhere else H / Enter are left alone.
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { const d = dockRef.current, el = e.target as Node | null;
      if (!chatKeyApplies({ open, inDock: !!d && el instanceof Node && d.contains(el), typing: typingTarget(e.target), mod: e.ctrlKey || e.metaKey || e.altKey })) return;
      if (e.code === "KeyH" && !e.repeat) { setTab(tabs[(tabs.indexOf(tabRef.current) + 1) % tabs.length]); return; }
      if (!tradesOnly && (e.code === "Enter" || e.code === "NumpadEnter") && !(el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement)) { e.preventDefault(); setTab("chat"); requestAnimationFrame(() => inputRef.current?.focus()); } };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, [open, setTab, tabs, tradesOnly]);
  // rate-limit countdown
  useEffect(() => { if (!err?.until) return; const iv = window.setInterval(() => { if (Date.now() >= err.until!) setErr(null); else tick((x) => x + 1); }, 250); return () => clearInterval(iv); }, [err]);

  const onScroll = useCallback(() => { const el = listRef.current; if (!el) return; const p = el.scrollTop > -24; if (p !== pinned.current) { pinned.current = p; if (p) setUnread(0); } }, []);
  const jump = () => { const el = listRef.current; if (el) el.scrollTop = 0; pinned.current = true; setUnread(0); };
  const len = Array.from(text).length;
  const send = async () => {
    if (!api || !text.trim() || len > MAX_LEN || sending || (err?.until && Date.now() < err.until)) return;
    setSending(true);
    try {
      const r = await api.api.send(c, text.trim());
      if (r.ok) { setText(""); setErr(null); buf.current.push(r.msg); jump(); }
      else if (r.error === "rate_limited") setErr({ kind: "rate", msg: "slow down", until: Date.now() + (r.retryAfterMs || 2000) });
      else if (r.error === "filtered") setErr({ kind: "filtered", msg: "message blocked by the filter" });
      else if (r.error === "too_long") setErr({ kind: "long", msg: `max ${MAX_LEN} characters` });
      else setErr({ kind: "identity", msg: "sign in to chat" });
    } catch { setErr({ kind: "net", msg: "send failed, try again" }); }
    setSending(false);
  };
  const doLogin = async () => { if (!api) return; const t = await api.api.login().catch(() => null); setErr(t ? null : { kind: "identity", msg: "no wallet connected or signature declined" }); if (t) inputRef.current?.focus(); };
  // left-edge drag → width (pointer capture; state set at most once per frame)
  const drag = (e: React.PointerEvent) => {
    e.preventDefault(); const x0 = e.clientX, w0 = width; let raf = 0, w = w0;
    const max = Math.min(W_MAX, Math.round(window.innerWidth * 0.4));
    const mv = (ev: PointerEvent) => { w = Math.max(W_MIN, Math.min(max, w0 + (x0 - ev.clientX))); if (!raf) raf = requestAnimationFrame(() => { raf = 0; setWidth(w); }); };
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); try { localStorage.setItem("disciple.gamechat.w", String(w)); } catch { /* */ } };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  };

  if (!open) return null;
  const st = STATE[conn];
  const known = (code: string) => code in (api?.api.EMOTES ?? {}) || EMOTE_CODES.includes(code);
  const rl = err?.until ? Math.max(0, Math.ceil((err.until - Date.now()) / 1000)) : 0;
  const isTrade = (r: Row) => r.msg.kind === "event" && /^(buy|sell|nuke)$/.test(String(r.msg.meta?.event || ""));   // trades come from the engine feed
  type Item = { t: number; k: string; chat?: Row; trade?: FeedRow };
  const items: Item[] = [];
  if (tab !== "trades") for (const r of rows) if (!isTrade(r)) items.push({ t: r.msg.ts, k: "c" + r.key, chat: r });
  if (tab === "trades") for (const r of rows) if (r.msg.kind === "event" && r.msg.meta?.event === "graduate") items.push({ t: r.msg.ts, k: "c" + r.key, chat: r });
  if (tab !== "chat") for (const r of feed) items.push({ t: r.seen ?? r.at, k: "f" + r.id, trade: r });
  items.sort((a, b) => a.t - b.t);
  const mo = hud === "pro" ? momentum(feed) : null;
  const typing = !tradesOnly && (tab === "all" || tab === "chat");
  return (
    <aside ref={dockRef} tabIndex={-1} data-testid="chat-dock" data-card="chat" aria-label="Holders and chat"
      style={{ transform: card.transform, position: "fixed", right: 20, top: "calc(var(--ap-hud-rt, 58px) + var(--ap-status-h, 100px) + var(--ap-crew-h, 0px))", height: "min(420px, calc(100dvh - var(--ap-hud-rt, 58px) - var(--ap-status-h, 100px) - var(--ap-crew-h, 0px) - 36px))", minHeight: 160, width, zIndex: 32, display: "flex", flexDirection: "column",
        background: HUD.glass, border: `1px solid ${HUD.border}`, borderRadius: HUD.radius,
        font: `13px/1.4 ${HUD.ui}`, color: HUD.text, contain: "layout paint" }}>
      <div onPointerDown={drag} title="drag to resize" style={{ position: "absolute", left: -4, top: 0, bottom: 0, width: 8, cursor: "ew-resize", zIndex: 2 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 6px" }}>
        {!tradesOnly && <span data-testid="chat-state" style={{ width: 7, height: 7, borderRadius: "50%", background: st.c, flex: "none" }} title={`chat ${st.t}`} />}
        <span style={{ font: `700 15px/1 ${HUD.game}`, letterSpacing: ".1em", color: HUD.champagne, whiteSpace: "nowrap" }}>CREW FEED</span>
        {api?.source === "fallback-mock" && <span style={{ opacity: 0.55, fontSize: 11 }}>mock</span>}
        <div role="tablist" aria-label="Crew feed: all, trades, chat or holders" style={{ display: "flex", gap: 2, marginLeft: "auto" }}>
          {tabs.map((t) => <button key={t} role="tab" id={`community-tab-${t}`} aria-controls={`community-panel-${t === "holders" ? "holders" : "chat"}`} aria-selected={tab === t} data-testid={`chat-tab-${t}`} onClick={() => setTab(t)} title={`${TAB_LABEL[t]} (H)`}
            style={{ all: "unset", cursor: "pointer", padding: "3px 7px", borderRadius: 6, font: `700 13px/1 ${HUD.game}`, letterSpacing: ".04em", position: "relative",
              color: tab === t ? HUD.ink : HUD.dim, background: tab === t ? "#F2F3F7" : "transparent" }}>
            {TAB_LABEL[t].toUpperCase()}
            {t === "chat" && tab !== "chat" && tab !== "all" && tabUnread > 0 && <span data-testid="chat-tab-unread" style={{ marginLeft: 4, padding: "0 5px", borderRadius: 8, background: HUD.down, color: "#fff", fontSize: 10 }}>{tabUnread > 99 ? "99+" : tabUnread}</span>}
          </button>)}
        </div>
      </div>
      {mo && <div data-testid="crew-momentum" title="Boosts vs dumps, last 5 minutes" style={{ padding: "0 12px 6px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 3 }}><span style={{ color: HUD.up }}>Boosts {fmtUsd(mo.up)}</span><span style={{ color: HUD.dim }}>last 5 min</span><span style={{ color: "#FF7FB3" }}>Dumps {fmtUsd(mo.down)}</span></div>
        <div style={{ display: "flex", height: 5, borderRadius: 999, overflow: "hidden", background: "rgba(255,255,255,.1)" }}><div style={{ width: `${Math.round(mo.share * 100)}%`, background: HUD.up }} /><div style={{ flex: 1, background: HUD.down }} /></div>
      </div>}
      {tab === "holders" && <div role="tabpanel" id="community-panel-holders" aria-labelledby="community-tab-holders" style={{ display: "contents" }}><HoldersView h={holders} /></div>}
      <div role="tabpanel" id="community-panel-chat" aria-labelledby={`community-tab-${tab === "holders" ? "chat" : tab}`} style={{ display: tab !== "holders" ? "contents" : "none" }}>
      <div ref={listRef} onScroll={onScroll} data-testid="chat-list"
        style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column-reverse", padding: "2px 6px", overscrollBehavior: "contain", scrollbarWidth: "thin" }}>
        <div>{!api && tab !== "trades" && <p role="status" style={{ opacity: 0.6, margin: "4px 6px" }}>Chat is connecting…</p>}
          {!items.length && (api || tradesOnly) && <p style={{ opacity: 0.6, margin: "4px 6px" }}>{tab === "trades" ? "No trades yet. Be the first boost." : "Quiet up here. Say hi to the crew."}</p>}
          {items.map((it) => it.chat ? <ChatRow key={it.k} row={it.chat} svg={api?.svg ?? false} known={known} emotes={api?.api.EMOTES ?? {}} /> : <TradeRow key={it.k} r={it.trade!} />)}</div>
      </div>
      {unread > 0 && <button data-testid="chat-new" onClick={jump} style={{ position: "absolute", left: "50%", bottom: 64, transform: "translateX(-50%)", cursor: "pointer", font: `700 13px ${HUD.game}`,
        padding: "4px 12px", borderRadius: 12, border: "none", background: HUD.champagne, color: HUD.ink, boxShadow: "0 4px 14px rgba(0,0,0,.4)" }}>↓ {unread > 99 ? "99+" : unread} new messages</button>}
      {err && <div data-testid="chat-error" style={{ margin: "0 8px 4px", padding: "5px 8px", borderRadius: 8, fontSize: 12, background: "rgba(240,48,127,.14)", border: "1px solid rgba(240,48,127,.45)", color: "#FFC2DA", display: "flex", gap: 8, alignItems: "center" }}>
        <span><Icon name={err.kind === "rate" ? "pending" : err.kind === "filtered" ? "blocked" : err.kind === "identity" ? "key" : "warning"} size={12} /> {err.kind === "rate" ? `${err.msg} · retry in ${rl}s` : err.msg}</span>
        {err.kind === "identity" && <button data-testid="chat-login" onClick={doLogin} style={{ marginLeft: "auto", cursor: "pointer", font: `700 13px ${HUD.game}`, borderRadius: 6, border: `1px solid ${HUD.champagne}`, background: "transparent", color: HUD.champagne, padding: "2px 8px" }}>Sign in</button>}
        {err.kind !== "rate" && err.kind !== "identity" && <button onClick={() => setErr(null)} style={{ marginLeft: "auto", all: "unset", cursor: "pointer", marginInlineStart: "auto" }}>×</button>}
      </div>}
      {picker && <div data-testid="chat-picker" style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 4, margin: "0 8px 4px", padding: 6, borderRadius: 10, background: "rgba(18,19,39,.95)", border: `1px solid ${HUD.border}` }}>
        {EMOTE_CODES.map((code) => <button key={code} title={`:${code}:`} onClick={() => { setText((t) => (t + (t && !t.endsWith(" ") ? " " : "") + `:${code}: `)); inputRef.current?.focus(); }}
          style={{ all: "unset", cursor: "pointer", textAlign: "center", fontSize: 18 }}><Emote code={code} svg={api?.svg ?? false} src={api?.api.EMOTES[code]} /></button>)}
      </div>}
      {typing && <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "4px 8px 8px", padding: "0 6px 0 10px", minHeight: 38, borderRadius: HUD.control, background: "rgba(11,12,14,.55)", border: `1px solid ${len > MAX_LEN ? HUD.down : HUD.border}` }}>
        <input ref={inputRef} data-testid="chat-input" value={text} aria-label="Chat with the crew" placeholder={conn === "live" ? "Say something to the crew" : "chat " + st.t + "…"} maxLength={MAX_LEN * 2}
          onChange={(e) => { setText(e.target.value); if (err && err.kind !== "rate") setErr(null); }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); send(); } else if (e.key === "Escape") { setPicker(false); e.currentTarget.blur(); } }}
          onKeyUp={(e) => e.stopPropagation()}
          style={{ flex: 1, minWidth: 0, font: `13px ${HUD.ui}`, color: HUD.text, background: "transparent", border: 0, padding: "8px 0", outline: "none" }} />
        {len > MAX_LEN * 0.85 && <span data-testid="chat-count" style={{ fontSize: 10, color: len > MAX_LEN ? HUD.down : "#ffd24a" }}>{len}/{MAX_LEN}</span>}
        <button data-testid="chat-emote-btn" onClick={() => setPicker((p) => !p)} title="Emotes" aria-label="Emotes" style={{ all: "unset", cursor: "pointer", fontSize: 16, padding: "0 2px" }}>😇</button>
        <span aria-hidden="true" style={{ padding: "2px 7px", borderRadius: 6, background: "rgba(255,255,255,.1)", font: `700 12px ${HUD.game}`, color: HUD.dim }}>ENTER</span>
      </div>}
      </div>
    </aside>
  );
}

/** one trade from the engine feed, kill-feed style: side, who, amount, bomb icon for big dumps */
const TradeRow = memo(function TradeRow({ r }: { r: FeedRow }) {
  if (!r.side) return <div data-kind="note" style={{ padding: "4px 6px", fontSize: 12, color: r.err ? "#FFC2DA" : HUD.dim, fontStyle: "italic" }}>{r.ic && <Icon name={r.ic} size={12} />} {r.note}</div>;
  const buy = r.side === "buy", col = buy ? HUD.up : "#FF7FB3";
  return <div data-kind={r.side} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 6px", borderRadius: 8, background: r.own ? "rgba(242,193,78,.1)" : undefined }}>
    <span style={{ font: `700 14px/1 ${HUD.game}`, color: col, minWidth: 62, letterSpacing: ".02em" }}>{buy ? "▲ BOOST" : "▼ DUMP"}</span>
    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, color: r.own ? HUD.gold : HUD.text, fontWeight: r.own ? 600 : 400 }}>{r.own ? "You" : r.who}</span>
    {r.ic && <Icon name={r.ic} size={14} style={{ color: HUD.down }} />}
    <span style={{ font: `700 15px/1 ${HUD.game}`, color: HUD.text }}>{r.amt}</span>
  </div>;
});

function Emote({ code, svg, src }: { code: string; svg: boolean; src?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- tiny static svg emotes, inline in text
  if (svg && src) return <img src={src} alt={`:${code}:`} title={`:${code}:`} width={20} height={20} style={{ verticalAlign: "-5px", display: "inline-block" }} />;
  return <span title={`:${code}:`} style={{ fontSize: 15 }}>{EMOTE_EMOJI[code] || `:${code}:`}</span>;
}

const ChatRow = memo(function ChatRow({ row, svg, known, emotes }: { row: Row; svg: boolean; known: (c: string) => boolean; emotes: Record<string, string> }) {
  const m = row.msg, rowStyle: React.CSSProperties = { padding: "4px 6px", wordBreak: "break-word", contentVisibility: "auto", containIntrinsicSize: "auto 22px", textShadow: "0 1px 2px rgba(0,0,0,.6)", font: `13px/1.4 ${HUD.ui}` };
  const body = (t: string) => parseEmotes(t, known).map((p, i) => p.t === "text" ? <span key={i}>{p.v}</span> : <Emote key={i} code={p.code} svg={svg} src={emotes[p.code]} />);
  if (m.kind === "system") return <div style={{ ...rowStyle, color: "rgba(220,228,255,.55)", fontStyle: "italic" }}>{body(m.text)}</div>;
  if (m.kind === "event") {
    const ev = m.meta?.event, g = row.group, bps = m.meta?.impactBps || 0, tier = ev === "sell" ? bombTier(m.meta) : null;   // impact-based, same tier as the in-game blast (lib/flight/bombTier)
    const who = m.from ? (m.from.name || shortAddr(m.from.addr)) : "";
    if (ev === "graduate") return <div data-kind="graduate" style={{ ...rowStyle, margin: "3px 0", padding: "6px 8px", borderRadius: 8, background: "rgba(243,223,168,.14)", color: HUD.champagne, font: `800 16px/1.2 ${HUD.game}`, letterSpacing: ".06em" }}><Icon name="graduation" size={14} /> {GRAD_BADGE}</div>;   // same words as the HUD badge: no tier name or mcap here (the HUD carries the live tier)
    const buy = ev === "buy", col = buy ? "#8ff0c0" : "#ffb0c8";
    if (g) return <div data-kind="group" style={{ ...rowStyle, fontSize: 11, color: col, opacity: 0.85, borderLeft: `2px solid ${col}55`, paddingLeft: 6 }}><Icon name={buy ? "rocket" : "dump"} size={12} /> {g.n} {buy ? "buys" : "sells"} · {fmtUsd(g.usd)}</div>;
    if (tier) return <div data-kind="bomb" style={{ ...rowStyle, margin: "2px 0", padding: "3px 6px", borderRadius: 6, background: `${tier.color}22`, borderLeft: `3px solid ${tier.color}`, fontSize: 11.5 }}>
      <b style={{ color: tier.color, letterSpacing: 1 }}><BombTierIcons tier={tier.idx} size={13} /> {tier.name}</b>{" "}
      <span style={{ color: "#ffd0dc" }}>−{(Math.abs(bps) / 100).toFixed(1)}% · {fmtUsd(m.meta?.usd || 0)}</span> <span style={{ opacity: 0.7 }}>{who}</span></div>;
    return <div data-kind={ev} style={{ ...rowStyle, fontSize: 11, color: col, borderLeft: `2px solid ${col}55`, paddingLeft: 6 }}><Icon name={buy ? "rocket" : "dump"} size={12} /> {who} {buy ? "bought" : "sold"} {fmtUsd(m.meta?.usd || 0)}{bps ? <span style={{ opacity: 0.7 }}> ({buy ? "+" : "−"}{(Math.abs(bps) / 100).toFixed(1)}%)</span> : null}</div>;
  }
  const f = m.from, b = f?.badge ? BADGE[f.badge] : null;
  return <div style={rowStyle}>
    {b && <span title={b.t} style={{ display: "inline-flex", alignItems: "center", gap: 3, marginRight: 5, padding: "0 5px", borderRadius: 5, border: `1px solid ${b.c}`, color: b.c, font: `700 11px/16px ${HUD.game}`, letterSpacing: ".04em", verticalAlign: "1px" }}>{b.i}{b.t.toUpperCase()}</span>}
    {f?.prestige ? <span title={`Prestige ${f.prestige}`} style={{ color: "#ffd24a", fontSize: 10, marginRight: 3, fontWeight: 800 }}>✦{f.prestige}</span> : null}
    <b style={{ color: f ? nameColor(f.addr) : "#ccc", fontWeight: 600 }}>{f ? f.name || shortAddr(f.addr) : "?"}</b>{" "}
    <span>{body(m.text)}</span></div>;
});

function HoldersView({ h }: { h: Holders | null }) {
  return <div data-testid="holders-list" style={{ flex: 1, overflowY: "auto", padding: "4px 12px 10px", scrollbarWidth: "thin", font: `13px/1.45 ${HUD.ui}` }}>
    <div style={{ color: HUD.champagne, font: `700 13px/1.2 ${HUD.game}`, letterSpacing: ".08em", marginBottom: 6 }}>{h?.title || "TOP HOLDERS · loading…"}</div>
    {!h ? null : h.items ? <RealHolders items={h.items} /> : !h.rows.length ? <div style={{ opacity: 0.6 }}>no boosters yet</div> : h.rows.map(([w, v], i) =>
      <div key={w} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", color: w === "you" ? "#9ff3c8" : "rgba(220,228,255,.9)", fontWeight: i === 0 ? 800 : 400 }}>
        <span>{i === 0 ? <Icon name="crown" size={12} style={{ width: "2ch" }} /> : String(i + 1).padStart(2, " ")} {w}</span><span>{fmtUsd(v)}</span></div>)}
    {h && !h.items && h.you > 0 && <div style={{ marginTop: 8, color: "#9ff3c8" }}>your BOOST: {fmtUsd(h.you)}</div>}
  </div>;
}
function RealHolders({ items }: { items: HolderItem[] }) {
  const ranked = items.filter((r) => !r.label), sys = items.filter((r) => r.label);
  const row = (r: HolderItem, i: number | null) => <div key={r.address} data-testid={r.mine ? "holder-mine" : undefined} title={r.address}
    style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "2px 0", color: r.mine ? "#9ff3c8" : r.label ? "rgba(220,228,255,.55)" : "rgba(220,228,255,.9)", fontWeight: i === 0 ? 800 : r.mine ? 700 : 400 }}
    data-kind={r.label || undefined}>
    <span>{i === null ? "  ·" : i === 0 ? <Icon name="crown" size={12} style={{ width: "2ch" }} /> : String(i + 1).padStart(2, " ")} {r.label ? holderLabelText(r.label) : r.mine ? "you" : r.who}</span>
    <span>{r.pct >= 0.01 ? r.pct.toFixed(2) + "% · " : ""}{fmtUsd(r.usd)}</span></div>;
  // lee 9:19 PM CT: pool / locker / burn / curve rows on TOP, labelled, greyed a little, no rank; real holders ranked from #1 below
  return <>
    {sys.length > 0 && <div data-testid="holders-tagged" style={{ marginBottom: 6, opacity: 0.8 }}>{sys.map((r) => row(r, null))}</div>}
    {!ranked.length ? <div style={{ opacity: 0.6 }}>no holders yet</div> : ranked.map((r, i) => row(r, i))}
  </>;
}
