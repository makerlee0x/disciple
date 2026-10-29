"use client";

import type React from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { EMOTE_CODES, EMOTE_EMOJI, MAX_LEN, resolveChat, stressRate, synthMsg, type ChatApi, type ChatMsg, type ChatState } from "@/lib/gamechat/adapter";
import Icon, { BombTierIcons } from "@/components/ui/Icon";
import { appendRows, bombTier, fmtUsd, nameColor, parseEmotes, shortAddr, type Row } from "@/lib/gamechat/format";
import { holderLabelText, type HolderLabel } from "@/lib/flight/holders";

/**
 * In-game live chat overlay (Twitch-style column, right side). DOM overlay only: the canvas never reads it.
 * One tabbed panel CHAT | HOLDERS (H switches, not while typing) in the right HUD column: from the KOTH slot
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
const W_MIN = 240, W_DEF = 310, W_MAX = 560, FLUSH_MS = 200;
const typingTarget = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); };
const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";
type Tab = "chat" | "holders";
type HolderItem = { who: string; address: string; usd: number; pct: number; label: HolderLabel; mine: boolean };
/** rows: legacy [name, $] (session boosters on mock / sim / pool); items: REAL holders from on-chain balances (live coins:
 *  engine realHolders ← components/flight/HoldersBridge) — ranked rows first, labelled pool / curve / locker / burn rows after (friendly names: lib/flight/holders holderLabelText). */
type Holders = { title: string; rows: [string, number][]; you: number; items?: HolderItem[]; asOfBlock?: number | null };

/** Chat keys (H / Enter) apply only when the dock is open and focus is inside it — never from the game / trading surface. */
export function chatKeyApplies(o: { open: boolean; inDock: boolean; typing: boolean; mod: boolean }) { return o.open && o.inDock && !o.typing && !o.mod; }

export default function GameChat({ coin }: { coin: string }) {
  const [api, setApi] = useState<{ api: ChatApi; svg: boolean; source: string } | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [conn, setConn] = useState<ChatState | "init">("init");
  const [open, setOpen] = useState(false);   // closed by default: opens only from the chat toggle (stored choice is kept)
  const [width, setWidth] = useState(W_DEF);
  const [unread, setUnread] = useState(0);
  const [text, setText] = useState("");
  const [err, setErr] = useState<{ kind: string; msg: string; until?: number } | null>(null);
  const [picker, setPicker] = useState(false);
  const [sending, setSending] = useState(false);
  const [, tick] = useState(0);
  const [tab, setTabS] = useState<Tab>("chat");
  const [tabUnread, setTabUnread] = useState(0);   // chat messages that arrived while HOLDERS was showing
  const [holders, setHolders] = useState<Holders | null>(null);
  const tabRef = useRef<Tab>("chat");
  const setTab = useCallback((t: Tab) => { tabRef.current = t; setTabS(t); if (t === "chat") setTabUnread(0); try { localStorage.setItem("disciple.gamechat.tab", t); } catch { /* */ } }, []);
  const buf = useRef<ChatMsg[]>([]);
  const seen = useRef(new Set<string>());   // send() returns the msg AND the stream delivers it: dedupe by id
  const pinned = useRef(true);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const c = coin.toLowerCase();

  useEffect(() => { try { setOpen(localStorage.getItem("disciple.gamechat.open") === "1"); const w = +(localStorage.getItem("disciple.gamechat.w") || 0); if (w) setWidth(Math.max(W_MIN, Math.min(W_MAX, w))); const t = localStorage.getItem("disciple.gamechat.tab"); if (t === "holders") { tabRef.current = "holders"; setTabS("holders"); } } catch { /* */ } }, []);
  useEffect(() => { let alive = true; resolveChat().then((r) => { if (alive && r) setApi({ api: r.api, svg: r.svgEmotes, source: r.source }); }); return () => { alive = false; }; }, []);
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
      if (tabRef.current === "holders") setTabUnread((u) => u + inc.filter((m) => m.kind !== "event").length);
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
    const iv = window.setInterval(() => { if (api && open && Date.now() - lastHolders.current > 3000) dispatchEvent(new CustomEvent("disciple:chatdock", { detail: { open, holders: true } })); }, 3000);
    return () => { removeEventListener("disciple:holders", h); clearInterval(iv); };
  }, [api, open]);
  useEffect(() => { if (!api) return; dispatchEvent(new CustomEvent("disciple:chatdock", { detail: { open, holders: true } })); try { localStorage.setItem("disciple.gamechat.open", open ? "1" : "0"); } catch { /* */ } }, [open, api]);
  useEffect(() => () => { dispatchEvent(new CustomEvent("disciple:chatdock", { detail: { open: false } })); }, []);
  // Chat never opens itself and never takes keys while you trade. Keys act ONLY when the dock is already open AND has focus
  // (you clicked into it): H = CHAT ↔ HOLDERS, Enter = focus the message box. Anywhere else H / Enter are left alone.
  useEffect(() => {
    if (!api || !open) return;
    const k = (e: KeyboardEvent) => { const d = dockRef.current, el = e.target as Node | null;
      if (!chatKeyApplies({ open, inDock: !!d && !!el && d.contains(el), typing: typingTarget(e.target), mod: e.ctrlKey || e.metaKey || e.altKey })) return;
      if (e.code === "KeyH" && !e.repeat) { setTab(tabRef.current === "chat" ? "holders" : "chat"); return; }
      if ((e.code === "Enter" || e.code === "NumpadEnter") && !(el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement)) { e.preventDefault(); setTab("chat"); requestAnimationFrame(() => inputRef.current?.focus()); } };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, [api, open, setTab]);
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

  if (!api) return null;
  const st = STATE[conn];
  if (!open) return (
    <button data-testid="chat-open" onClick={() => setOpen(true)} title="Open chat"
      style={{ position: "fixed", right: 344, bottom: 20, zIndex: 33, height: 30, padding: "0 12px", borderRadius: 15, cursor: "pointer", font: `bold 12px ${mono}`,
        color: "#e8ecff", background: "rgba(10,12,28,.72)", border: "1px solid rgba(255,231,163,.45)" }}>
      <span style={{ color: st.c }}>●</span> CHAT{unread > 0 ? ` · ${unread > 99 ? "99+" : unread}` : ""}
    </button>
  );
  const known = (code: string) => code in api.api.EMOTES || EMOTE_CODES.includes(code);
  const rl = err?.until ? Math.max(0, Math.ceil((err.until - Date.now()) / 1000)) : 0;
  return (
    <aside ref={dockRef} tabIndex={-1} data-testid="chat-dock" aria-label="Live chat"
      style={{ position: "fixed", right: 20, top: "calc(var(--ap-hud-rt, 58px) + 100px + var(--ap-crew-h, 0px))", bottom: 20, width, zIndex: 32, display: "flex", flexDirection: "column",
        background: "linear-gradient(90deg, rgba(8,10,24,.38), rgba(8,10,24,.62))", border: "1px solid rgba(255,231,163,.22)", borderRadius: 12,
        font: `12.5px/1.38 ${mono}`, color: "#e8ecff", contain: "layout paint" }}>
      <div onPointerDown={drag} title="drag to resize" style={{ position: "absolute", left: -4, top: 0, bottom: 0, width: 8, cursor: "ew-resize", zIndex: 2 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid rgba(255,255,255,.08)", fontSize: 11 }}>
        <div role="tablist" aria-label="Chat or holders" style={{ display: "flex", gap: 2 }}>
          {(["chat", "holders"] as Tab[]).map((t) => <button key={t} role="tab" aria-selected={tab === t} data-testid={`chat-tab-${t}`} onClick={() => setTab(t)} title={`${t === "chat" ? "Live chat" : "Top holders"} (H)`}
            style={{ all: "unset", cursor: "pointer", padding: "3px 8px", borderRadius: 6, fontWeight: 800, letterSpacing: 1, position: "relative",
              color: tab === t ? "#151830" : "#ffe7a3", background: tab === t ? "#ffe7a3" : "rgba(255,231,163,.08)", border: "1px solid rgba(255,231,163,.35)" }}>
            {t === "chat" ? "CHAT" : "HOLDERS"}
            {t === "chat" && tab !== "chat" && tabUnread > 0 && <span data-testid="chat-tab-unread" style={{ marginLeft: 5, padding: "0 5px", borderRadius: 8, background: "#ff5c7a", color: "#fff", fontSize: 10 }}>{tabUnread > 99 ? "99+" : tabUnread}</span>}
          </button>)}
        </div>
        <span data-testid="chat-state" style={{ color: st.c }} title={`chat ${st.t}`}>●{tab === "chat" ? " " + st.t : ""}</span>
        {api.source === "fallback-mock" && <span style={{ opacity: 0.55 }}>mock</span>}
        <button data-testid="chat-collapse" onClick={() => setOpen(false)} title="Collapse" style={{ marginLeft: "auto", all: "unset", cursor: "pointer", padding: "0 4px", opacity: 0.8, marginInlineStart: "auto" }}>▸</button>
      </div>
      {tab === "holders" && <HoldersView h={holders} />}
      <div style={{ display: tab === "chat" ? "contents" : "none" }}>
      <div ref={listRef} onScroll={onScroll} data-testid="chat-list"
        style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column-reverse", padding: "4px 8px", overscrollBehavior: "contain", scrollbarWidth: "thin" }}>
        <div>{rows.map((r) => <ChatRow key={r.key} row={r} svg={api.svg} known={known} emotes={api.api.EMOTES} />)}</div>
      </div>
      {unread > 0 && <button data-testid="chat-new" onClick={jump} style={{ position: "absolute", left: "50%", bottom: 78, transform: "translateX(-50%)", cursor: "pointer", font: `bold 11px ${mono}`,
        padding: "4px 12px", borderRadius: 12, border: "none", background: "#ffe7a3", color: "#151830", boxShadow: "0 4px 14px rgba(0,0,0,.4)" }}>↓ {unread > 99 ? "99+" : unread} new messages</button>}
      {err && <div data-testid="chat-error" style={{ margin: "0 8px 4px", padding: "5px 8px", borderRadius: 8, fontSize: 11, background: "rgba(255,107,125,.15)", border: "1px solid rgba(255,107,125,.45)", color: "#ffc0cb", display: "flex", gap: 8, alignItems: "center" }}>
        <span><Icon name={err.kind === "rate" ? "pending" : err.kind === "filtered" ? "blocked" : err.kind === "identity" ? "key" : "warning"} size={12} /> {err.kind === "rate" ? `${err.msg} · retry in ${rl}s` : err.msg}</span>
        {err.kind === "identity" && <button data-testid="chat-login" onClick={doLogin} style={{ marginLeft: "auto", cursor: "pointer", font: `bold 11px ${mono}`, borderRadius: 6, border: "1px solid #ffe7a3", background: "transparent", color: "#ffe7a3", padding: "2px 8px" }}>Sign in</button>}
        {err.kind !== "rate" && err.kind !== "identity" && <button onClick={() => setErr(null)} style={{ marginLeft: "auto", all: "unset", cursor: "pointer", marginInlineStart: "auto" }}>×</button>}
      </div>}
      {picker && <div data-testid="chat-picker" style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 4, margin: "0 8px 4px", padding: 6, borderRadius: 8, background: "rgba(8,10,24,.9)", border: "1px solid rgba(255,255,255,.12)" }}>
        {EMOTE_CODES.map((code) => <button key={code} title={`:${code}:`} onClick={() => { setText((t) => (t + (t && !t.endsWith(" ") ? " " : "") + `:${code}: `)); inputRef.current?.focus(); }}
          style={{ all: "unset", cursor: "pointer", textAlign: "center", fontSize: 18 }}><Emote code={code} svg={api.svg} src={api.api.EMOTES[code]} /></button>)}
      </div>}
      <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "6px 8px 8px" }}>
        <button data-testid="chat-emote-btn" onClick={() => setPicker((p) => !p)} title="Emotes" style={{ all: "unset", cursor: "pointer", fontSize: 16, padding: "0 2px" }}>😇</button>
        <input ref={inputRef} data-testid="chat-input" value={text} placeholder={conn === "live" ? "Send a message (Enter)" : "chat " + st.t + "…"} maxLength={MAX_LEN * 2}
          onChange={(e) => { setText(e.target.value); if (err && err.kind !== "rate") setErr(null); }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); send(); } else if (e.key === "Escape") { setPicker(false); e.currentTarget.blur(); } }}
          onKeyUp={(e) => e.stopPropagation()}
          style={{ flex: 1, minWidth: 0, font: `12px ${mono}`, color: "#e8ecff", background: "rgba(0,0,0,.35)", border: `1px solid ${len > MAX_LEN ? "#ff6b7d" : "rgba(255,255,255,.18)"}`, borderRadius: 8, padding: "6px 8px", outline: "none" }} />
        <span data-testid="chat-count" style={{ fontSize: 10, minWidth: 44, textAlign: "right", color: len > MAX_LEN ? "#ff6b7d" : len > MAX_LEN * 0.85 ? "#ffd24a" : "rgba(220,228,255,.5)" }}>{len}/{MAX_LEN}</span>
      </div>
      </div>
    </aside>
  );
}

function Emote({ code, svg, src }: { code: string; svg: boolean; src?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- tiny static svg emotes, inline in text
  if (svg && src) return <img src={src} alt={`:${code}:`} title={`:${code}:`} width={20} height={20} style={{ verticalAlign: "-5px", display: "inline-block" }} />;
  return <span title={`:${code}:`} style={{ fontSize: 15 }}>{EMOTE_EMOJI[code] || `:${code}:`}</span>;
}

const ChatRow = memo(function ChatRow({ row, svg, known, emotes }: { row: Row; svg: boolean; known: (c: string) => boolean; emotes: Record<string, string> }) {
  const m = row.msg, rowStyle: React.CSSProperties = { padding: "2px 2px", wordBreak: "break-word", contentVisibility: "auto", containIntrinsicSize: "auto 20px", textShadow: "0 1px 2px rgba(0,0,0,.8)" };
  const body = (t: string) => parseEmotes(t, known).map((p, i) => p.t === "text" ? <span key={i}>{p.v}</span> : <Emote key={i} code={p.code} svg={svg} src={emotes[p.code]} />);
  if (m.kind === "system") return <div style={{ ...rowStyle, color: "rgba(220,228,255,.55)", fontStyle: "italic" }}>{body(m.text)}</div>;
  if (m.kind === "event") {
    const ev = m.meta?.event, g = row.group, bps = m.meta?.impactBps || 0, tier = ev === "sell" ? bombTier(m.meta) : null;   // impact-based, same tier as the in-game blast (lib/flight/bombTier)
    const who = m.from ? (m.from.name || shortAddr(m.from.addr)) : "";
    if (ev === "graduate") return <div data-kind="graduate" style={{ ...rowStyle, margin: "3px 0", padding: "4px 6px", borderRadius: 6, background: "rgba(255,231,163,.14)", color: "#ffe7a3", fontWeight: 800 }}><Icon name="graduation" size={14} /> GRADUATED · Outer Space {m.meta?.usd ? fmtUsd(m.meta.usd) : ""}</div>;
    const buy = ev === "buy", col = buy ? "#8ff0c0" : "#ffb0c8";
    if (g) return <div data-kind="group" style={{ ...rowStyle, fontSize: 11, color: col, opacity: 0.85, borderLeft: `2px solid ${col}55`, paddingLeft: 6 }}><Icon name={buy ? "rocket" : "dump"} size={12} /> {g.n} {buy ? "buys" : "sells"} · {fmtUsd(g.usd)}</div>;
    if (tier) return <div data-kind="bomb" style={{ ...rowStyle, margin: "2px 0", padding: "3px 6px", borderRadius: 6, background: `${tier.color}22`, borderLeft: `3px solid ${tier.color}`, fontSize: 11.5 }}>
      <b style={{ color: tier.color, letterSpacing: 1 }}><BombTierIcons tier={tier.idx} size={13} /> {tier.name}</b>{" "}
      <span style={{ color: "#ffd0dc" }}>−{(Math.abs(bps) / 100).toFixed(1)}% · {fmtUsd(m.meta?.usd || 0)}</span> <span style={{ opacity: 0.7 }}>{who}</span></div>;
    return <div data-kind={ev} style={{ ...rowStyle, fontSize: 11, color: col, borderLeft: `2px solid ${col}55`, paddingLeft: 6 }}><Icon name={buy ? "rocket" : "dump"} size={12} /> {who} {buy ? "bought" : "sold"} {fmtUsd(m.meta?.usd || 0)}{bps ? <span style={{ opacity: 0.7 }}> ({buy ? "+" : "−"}{(Math.abs(bps) / 100).toFixed(1)}%)</span> : null}</div>;
  }
  const f = m.from, b = f?.badge ? BADGE[f.badge] : null;
  return <div style={rowStyle}>
    {b && <span title={b.t} style={{ color: b.c, marginRight: 4, fontSize: 12 }}>{b.i}</span>}
    {f?.prestige ? <span title={`Prestige ${f.prestige}`} style={{ color: "#ffd24a", fontSize: 10, marginRight: 3, fontWeight: 800 }}>✦{f.prestige}</span> : null}
    <b style={{ color: f ? nameColor(f.addr) : "#ccc" }}>{f ? f.name || shortAddr(f.addr) : "?"}</b><span style={{ opacity: 0.6 }}>: </span>
    <span>{body(m.text)}</span></div>;
});

function HoldersView({ h }: { h: Holders | null }) {
  return <div data-testid="holders-list" style={{ flex: 1, overflowY: "auto", padding: "8px 12px", scrollbarWidth: "thin" }}>
    <div style={{ color: "#ffe7a3", fontWeight: 800, fontSize: 11.5, marginBottom: 6 }}>{h?.title || "KING OF THE HILL · top boosters"}</div>
    {h?.items ? <RealHolders items={h.items} you={h.you} /> : !h || !h.rows.length ? <div style={{ opacity: 0.6 }}>no boosters yet</div> : h.rows.map(([w, v], i) =>
      <div key={w} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", color: w === "you" ? "#9ff3c8" : "rgba(220,228,255,.9)", fontWeight: i === 0 ? 800 : 400 }}>
        <span>{i === 0 ? <Icon name="crown" size={12} style={{ width: "2ch" }} /> : String(i + 1).padStart(2, " ")} {w}</span><span>{fmtUsd(v)}</span></div>)}
    {h && !h.items && h.you > 0 && <div style={{ marginTop: 8, color: "#9ff3c8" }}>your BOOST: {fmtUsd(h.you)}</div>}
  </div>;
}
function RealHolders({ items, you }: { items: HolderItem[]; you: number }) {
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
    {you > 0 && <div style={{ marginTop: 8, color: "#9ff3c8" }}>your bag: {fmtUsd(you)}</div>}
  </>;
}
