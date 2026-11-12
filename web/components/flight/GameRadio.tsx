"use client";
/**
 * House radio on the flight canvas (coin + sim), plus a compact mini player.
 *
 * Drag, minimize, close, saved position, and edge bounds reuse the existing flight card
 * chrome (CardChrome, useDomCard, cardLayout, disciple.layout.v1:). Radio is a FLOAT_CARD:
 * same ⠿ / – / × behavior, but it stays out of the snap-to-grid slot flow so other cards
 * do not shift. On phones, layout chrome is off (same as PnL / trades / chat); the player
 * stays in the bottom-right corner and has its own Minimize / Show Music control.
 *
 * Volume and mute are the existing Music channel (audioLevel("music") / disciple:audio).
 * Pause is local to this flight session and does not turn Music off. Turning Music on in
 * settings (or unmuting from the player) clears a session pause so "Music on" always means
 * you hear music. Changing the volume slider does not unpause.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getAudioContext, resumeAudio } from "@/lib/game/audio";
import { restoreCard, setCard } from "@/lib/game/cardLayout";
import { isPhoneUI, updateLayout, useCardLayout, useDomCard } from "@/lib/game/cardLayoutStore";
import { getGameRadio } from "@/lib/game/radio";
import { audioLevel, DEFAULT_GAME_SETTINGS, setGameSettings, useGameSettings } from "@/lib/game/settings";
import { radioShouldPlay, stationList, type RepeatMode } from "@/lib/game/stations";

const GOLD = "#ffe7a3";
const INK = "#e8ecff";
const DIM = "rgba(220,228,255,.62)";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const PANEL: React.CSSProperties = {
  position: "fixed",
  right: 16,
  bottom: 16,
  zIndex: 32,
  width: 280,
  padding: "8px 10px 10px",
  borderRadius: 10,
  background: "rgba(8,10,28,.92)",
  border: "1px solid rgba(255,231,163,.35)",
  color: INK,
  fontFamily: MONO,
  boxSizing: "border-box",
  pointerEvents: "auto",
};
const BTN: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: GOLD,
  lineHeight: 0,
};
const PILL: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  position: "fixed",
  right: 16,
  bottom: 16,
  zIndex: 32,
  padding: "2px 8px",
  borderRadius: 8,
  background: "rgba(8,10,28,.86)",
  border: "1px solid rgba(255,231,163,.45)",
  color: GOLD,
  fontFamily: MONO,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: ".06em",
  pointerEvents: "auto",
};

function Ico({ d, size = 16, sw = 1.5, fill = false }: { d: string; size?: number; sw?: number; fill?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke="currentColor" strokeWidth={fill ? 0 : sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

const ICONS = {
  prev: "M6 6v12M18 6l-10 6 10 6V6z",
  next: "M18 6v12M6 6l10 6-10 6V6z",
  play: "M8 5l12 7-12 7V5z",
  pause: "M7 5h3v14H7zM14 5h3v14h-3z",
  shuffle: "M16 3h5v5M4 20l6.5-6.5M21 3l-7 7M16 21h5v-5M21 21l-5.5-5.5",
  repeat: "M17 1l4 4-4 4M3 11V9a4 4 0 014-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 01-4 4H3",
  speaker: "M11 5L6 9H2v6h4l5 4V5z",
  speakerOff: "M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6",
  chevron: "M6 9l6 6 6-6",
};

function useRadio() {
  const radio = getGameRadio();
  return useSyncExternalStore(radio.subscribe, () => radio.status(), () => radio.status());
}

export default function GameRadio() {
  const gs = useGameSettings();
  const st = useRadio();
  const layout = useCardLayout();
  const ref = useRef<HTMLDivElement>(null);
  const card = useDomCard("radio", ref);
  const [phone, setPhone] = useState(false);
  const [picker, setPicker] = useState(false);
  const lastLevel = useRef(audioLevel("music", gs));

  useEffect(() => {
    const f = () => setPhone(isPhoneUI());
    f();
    addEventListener("resize", f);
    return () => removeEventListener("resize", f);
  }, []);

  useEffect(() => {
    const radio = getGameRadio();
    radio.setStation(gs.radio.station);
    radio.setShuffle(gs.radio.shuffle);
    radio.setRepeat(gs.radio.repeat);
  }, [gs.radio.station, gs.radio.shuffle, gs.radio.repeat]);

  useEffect(() => {
    const radio = getGameRadio();
    let unlocked = !!(getAudioContext() && getAudioContext()!.state === "running");

    const apply = () => {
      const level = audioLevel("music");
      const was = lastLevel.current;
      lastLevel.current = level;
      if (was <= 0 && level > 0) radio.clearPause();
      radio.setLevel(level);
      if (level <= 0) radio.stop();
      else if (radioShouldPlay(level, unlocked) && !radio.isPaused()) radio.start();
    };

    const unlock = () => {
      void resumeAudio().then(() => {
        const ctx = getAudioContext();
        if (ctx && ctx.state === "running") unlocked = true;
        apply();
      });
    };

    apply();
    window.addEventListener("disciple:audio", apply);
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    window.addEventListener("touchstart", unlock, true);
    return () => {
      window.removeEventListener("disciple:audio", apply);
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      window.removeEventListener("touchstart", unlock, true);
      radio.stop();
    };
  }, []);

  const musicOn = gs.music.on;
  const playing = st.running && !st.paused && musicOn && gs.music.vol > 0;
  const stations = stationList();
  const station = stations.find((s) => s.id === st.stationId) ?? stations[0];
  const min = card.min || (phone && !!layout.radio?.min);
  const closed = card.closed || (phone && !!layout.radio?.closed);
  const hidePanel = min || closed;
  const phoneBottom: React.CSSProperties = phone
    ? { right: 10, bottom: "calc(var(--ap-safe-bottom, 0px) + 88px)" }
    : {};

  const play = () => {
    const radio = getGameRadio();
    radio.clearPause();
    void resumeAudio();
    if (audioLevel("music") <= 0) {
      setGameSettings((g) => ({
        ...g,
        music: { on: true, vol: g.music.vol > 0 ? g.music.vol : DEFAULT_GAME_SETTINGS.music.vol },
      }));
    } else {
      radio.setLevel(audioLevel("music"));
      radio.start();
    }
  };
  const pause = () => getGameRadio().pause();
  const skip = (dir: 1 | -1) => getGameRadio().skip(dir);
  const toggleShuffle = () => setGameSettings((g) => ({ ...g, radio: { ...g.radio, shuffle: !g.radio.shuffle } }));
  const toggleRepeat = () => setGameSettings((g) => ({
    ...g,
    radio: { ...g.radio, repeat: (g.radio.repeat === "one" ? "station" : "one") as RepeatMode },
  }));
  const setVol = (v: number) => setGameSettings((g) => ({ ...g, music: { ...g.music, vol: v } }));
  const toggleMute = () => setGameSettings((g) => ({ ...g, music: { ...g.music, on: !g.music.on } }));
  const pickStation = (id: string) => {
    setGameSettings((g) => ({ ...g, radio: { ...g.radio, station: id } }));
    setPicker(false);
  };

  return (
    <>
      <div
        ref={ref}
        data-card="radio"
        data-testid="radio-mini"
        style={{
          ...PANEL,
          ...phoneBottom,
          transform: card.transform,
          display: hidePanel ? "none" : undefined,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, minHeight: 22 }}>
          <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
            <button
              type="button"
              data-testid="radio-station"
              aria-haspopup="listbox"
              aria-expanded={picker}
              aria-label="Station"
              title="Station"
              onClick={() => setPicker((p) => !p)}
              style={{
                ...BTN,
                gap: 6,
                color: GOLD,
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                lineHeight: "18px",
              }}
            >
              {station?.label ?? "House"}
              <Ico d={ICONS.chevron} size={12} />
            </button>
            {picker && (
              <div
                data-testid="radio-station-list"
                role="listbox"
                aria-label="Station"
                style={{
                  position: "absolute",
                  left: 0,
                  top: "100%",
                  zIndex: 2,
                  minWidth: 140,
                  marginTop: 4,
                  padding: 4,
                  borderRadius: 8,
                  background: "rgba(10,12,30,.96)",
                  border: "1px solid rgba(255,231,163,.35)",
                  boxShadow: "0 8px 24px rgba(0,0,0,.5)",
                }}
              >
                {stations.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="option"
                    aria-selected={s.id === st.stationId}
                    data-testid={`radio-station-${s.id}`}
                    onClick={() => pickStation(s.id)}
                    style={{
                      ...BTN,
                      display: "flex",
                      width: "100%",
                      justifyContent: "flex-start",
                      boxSizing: "border-box",
                      padding: "6px 8px",
                      borderRadius: 6,
                      color: s.id === st.stationId ? "#151830" : INK,
                      background: s.id === st.stationId ? GOLD : "transparent",
                      fontSize: 12,
                      fontWeight: 700,
                      letterSpacing: ".04em",
                      lineHeight: "16px",
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {phone && (
            <button type="button" data-testid="radio-min" title="Minimize" aria-label="Minimize" onClick={() => updateLayout((l) => setCard(l, "radio", { min: true }))} style={{ ...BTN, fontSize: 14, padding: "0 4px", lineHeight: "16px" }}>–</button>
          )}
        </div>
        <div style={{ color: DIM, fontSize: 10, letterSpacing: ".02em", margin: "-2px 0 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} data-testid="radio-track" title={st.trackTitle}>
          {st.trackTitle}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4, marginBottom: 8 }}>
          <button
            type="button"
            data-testid="radio-repeat"
            aria-pressed={st.repeat === "one"}
            aria-label={st.repeat === "one" ? "This track will play again." : "This station keeps playing all its tracks."}
            title={st.repeat === "one" ? "This track will play again." : "This station keeps playing all its tracks."}
            onClick={toggleRepeat}
            style={{ ...BTN, opacity: st.repeat === "one" ? 1 : 0.55, position: "relative" }}
          >
            <Ico d={ICONS.repeat} size={16} />
            {st.repeat === "one" && <span style={{ position: "absolute", right: -4, bottom: -4, fontSize: 8, fontWeight: 800, color: GOLD }}>1</span>}
          </button>
          <button type="button" data-testid="radio-prev" aria-label="Previous track" title="Previous track" onClick={() => skip(-1)} style={BTN}>
            <Ico d={ICONS.prev} size={18} fill />
          </button>
          <button
            type="button"
            data-testid="radio-play"
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause" : "Play"}
            onClick={playing ? pause : play}
            style={{ ...BTN, width: 36, height: 36, borderRadius: 18, border: `1px solid ${GOLD}`, background: playing ? "rgba(255,231,163,.14)" : "rgba(255,231,163,.08)" }}
          >
            <Ico d={playing ? ICONS.pause : ICONS.play} size={18} fill />
          </button>
          <button type="button" data-testid="radio-next" aria-label="Next track" title="Next track" onClick={() => skip(1)} style={BTN}>
            <Ico d={ICONS.next} size={18} fill />
          </button>
          <button
            type="button"
            data-testid="radio-shuffle"
            aria-pressed={st.shuffle}
            aria-label={st.shuffle ? "Shuffle is on" : "Shuffle"}
            title={st.shuffle ? "Shuffle is on. Tracks in this station play in a random order, then start over." : "Shuffle. Play this station's tracks in a random order."}
            onClick={toggleShuffle}
            style={{ ...BTN, opacity: st.shuffle ? 1 : 0.55 }}
          >
            <Ico d={ICONS.shuffle} size={16} />
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button type="button" data-testid="radio-mute" aria-label={musicOn ? "Mute Music" : "Turn Music on"} title={musicOn ? "Mute Music" : "Turn Music on"} onClick={toggleMute} style={{ ...BTN, opacity: musicOn ? 1 : 0.5 }}>
            <Ico d={musicOn ? ICONS.speaker : ICONS.speakerOff} size={16} fill />
          </button>
          <input
            type="range"
            min={0}
            max={100}
            data-testid="radio-volume"
            aria-label="Music volume"
            title="Music volume"
            value={Math.round(gs.music.vol * 100)}
            onChange={(e) => setVol(+e.target.value / 100)}
            style={{ flex: 1, accentColor: GOLD, opacity: musicOn ? 1 : 0.4, minWidth: 0 }}
          />
        </div>
      </div>
      {phone && hidePanel && (
        <button
          type="button"
          data-testid="radio-pill"
          title="Show Music"
          aria-label="Show Music"
          onClick={() => updateLayout((l) => restoreCard(l, "radio"))}
          style={{ ...PILL, ...phoneBottom }}
        >
          ▸ MUSIC
        </button>
      )}
    </>
  );
}
