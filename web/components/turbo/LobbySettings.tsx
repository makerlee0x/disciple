"use client";
/**
 * The gear on every Turbo mode lobby (Trading Duel, Climb, Turbo Royale; maker 2026-11-18). Same modal, rows and controls
 * as Settings (components/profile/SettingsModal, app/profile-r5.css .p5-settings), cut down to what a pilot tweaks between
 * matches:
 *  - Sound: Music | Sound effects (shared SoundRow) and the radio station. All of it is lib/game/settings, so the flight
 *    radio pill, Settings and the engines (disciple:audio) stay in step.
 *  - Play: start trade size (Duel, Climb), rival chat (Duel; the engine's own MUTE CHAT key), Vibration | Reduce motion.
 * The engines read the same localStorage key (disciple.game.settings.v1) and the disciple:audio event, so a change lands
 * before the next match without a reload.
 */
import { useEffect, useState } from "react";
import Icon from "@/components/icons/Icon";
import SoundRow from "@/components/profile/SoundRow";
import { SETTINGS_COPY } from "@/components/profile/SettingsModal";
import { TURBO_SIZES, setGameSettings, useGameSettings, type TurboSize } from "@/lib/game/settings";
import { stationList } from "@/lib/game/stations";

export type LobbyMode = "duel" | "climb" | "royale";

export const LOBBY_SETTINGS_COPY = {
  play: "Play",
  station: "Station",
  size: "Start size",
  sizeChoice: (s: TurboSize) => (s === 0 ? "ALL" : `${s}%`),
  chat: "Rival chat",
  reduceFx: "Reduce motion",
} as const;

/** the Duel engine's own chat mute (public/turbo/duel/engine.js setChatMute); the engine listens for disciple:duelchat */
const CHAT_KEY = "duel.chatMute";
const readChatOn = () => { try { return localStorage.getItem(CHAT_KEY) !== "1"; } catch { return true; } };

export default function LobbySettings({ mode, open, onClose }: { mode: LobbyMode; open: boolean; onClose: () => void }) {
  const gs = useGameSettings();
  const [chatOn, setChatOn] = useState(true);
  useEffect(() => { if (open) setChatOn(readChatOn()); }, [open]);
  useEffect(() => {
    if (!open) return;
    // capture: the engines bind keys on window (Space boost, Enter, Escape), so the sheet takes them first
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    addEventListener("keydown", k, true);
    return () => removeEventListener("keydown", k, true);
  }, [open, onClose]);
  if (!open) return null;

  const stations = stationList();
  const toggleChat = () => {
    const on = !chatOn; setChatOn(on);
    try { localStorage.setItem(CHAT_KEY, on ? "0" : "1"); } catch { /* private mode */ }
    dispatchEvent(new CustomEvent("disciple:duelchat", { detail: { mute: !on } }));
  };
  const sw = (on: boolean, label: string, id: string, flip: () => void) => (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`p5-switch sm${on ? " on" : ""}`} data-testid={id} onClick={flip}><span /></button>
  );

  return (
    <div className="ds-modal-backdrop p5-settings-backdrop" style={{ zIndex: 120 }} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="p5-modal p5-settings p5-lobby" role="dialog" aria-modal="true" aria-label={SETTINGS_COPY.title} data-testid="lobby-settings">
        <header className="p5-mhead">
          <button type="button" className="p5-icon p5-phone" aria-label="Back" onClick={onClose}><Icon name="chevron-left" size={20} /></button>
          <h2>{SETTINGS_COPY.title}</h2>
          <button type="button" className="p5-icon p5-desk" aria-label="Close settings" onClick={onClose} data-testid="lobby-settings-close"><Icon name="close" size={18} /></button>
        </header>
        <section className="p5-sgrp" aria-label={SETTINGS_COPY.sound}>
          <span className="gh">{SETTINGS_COPY.sound}</span>
          <div className="p5-sbox">
            <SoundRow music={SETTINGS_COPY.music} sfx={SETTINGS_COPY.sfx} />
            <div className="p5-srow" data-testid="lobby-station">
              <div className="tx"><b>{LOBBY_SETTINGS_COPY.station}</b></div>
              <div className="p5-seg" role="radiogroup" aria-label={LOBBY_SETTINGS_COPY.station}>
                {stations.map((s) => (
                  <button key={s.id} type="button" role="radio" aria-checked={gs.radio.station === s.id} className={gs.radio.station === s.id ? "on" : ""}
                    onClick={() => setGameSettings((g) => ({ ...g, radio: { ...g.radio, station: s.id } }))} data-testid={`lobby-station-${s.id}`}>
                    {s.label.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>
        <section className="p5-sgrp" aria-label={LOBBY_SETTINGS_COPY.play}>
          <span className="gh">{LOBBY_SETTINGS_COPY.play}</span>
          <div className="p5-sbox">
            {mode !== "royale" && (
              <div className="p5-srow" data-testid="lobby-size">
                <div className="tx"><b>{LOBBY_SETTINGS_COPY.size}</b></div>
                <div className="p5-seg" role="radiogroup" aria-label={LOBBY_SETTINGS_COPY.size}>
                  {TURBO_SIZES.map((s) => (
                    <button key={s} type="button" role="radio" aria-checked={gs.turboSize === s} className={gs.turboSize === s ? "on" : ""}
                      onClick={() => setGameSettings((g) => ({ ...g, turboSize: s }))} data-testid={`lobby-size-${s}`}>
                      {LOBBY_SETTINGS_COPY.sizeChoice(s)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {mode === "duel" && (
              <div className="p5-srow" data-testid="lobby-chat">
                <div className="tx"><b>{LOBBY_SETTINGS_COPY.chat}</b></div>
                {sw(chatOn, LOBBY_SETTINGS_COPY.chat, "lobby-chat-switch", toggleChat)}
              </div>
            )}
            <div className="p5-srow p5-split">
              <div className="p5-cell">
                <b>{SETTINGS_COPY.haptics}</b>
                {sw(gs.haptics, SETTINGS_COPY.haptics, "lobby-haptics", () => setGameSettings((g) => ({ ...g, haptics: !g.haptics })))}
              </div>
              <div className="p5-cell">
                <b>{LOBBY_SETTINGS_COPY.reduceFx}</b>
                {sw(gs.reduceFx, LOBBY_SETTINGS_COPY.reduceFx, "lobby-reducefx", () => setGameSettings((g) => ({ ...g, reduceFx: !g.reduceFx })))}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
