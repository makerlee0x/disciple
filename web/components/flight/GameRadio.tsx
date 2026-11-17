"use client";
/**
 * House radio on the flight canvas (coin + sim), plus a compact mini player.
 *
 * Drag, minimize, close, saved position, and edge bounds reuse the existing flight card
 * chrome (CardChrome, useDomCard, cardLayout, disciple.layout.v1:). Radio is a FLOAT_CARD:
 * same ⠿ / – / × behavior, but it stays out of the snap-to-grid slot flow so other cards
 * do not shift. On phones, layout chrome is off (same as PnL / trades / chat); the player
 * stays in the bottom-right corner and has its own Minimize / Show Radio control.
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
import { useHudMode } from "@/lib/game/hudMode";
import { HUD } from "@/lib/game/hudStyle";

/* desktop (approved mockup, Nov 12): a one-line card "♫ House radio · Night Drive  R"; click it for the full controls.
   Pilot (board C, 2026-11-14): a CINEMATIC / HOUSE pill in the top bar, left of the ☰ menu (PILOT / PRO too when lib/features PRO_HUD_ENABLED); click it for the full controls. Pro: bottom left. R plays / pauses (not while typing, not when bound to a trade). */
const DESK: React.CSSProperties = { width: 300, padding: 0, borderRadius: 12, background: HUD.glass, border: `1px solid ${HUD.border}`, color: HUD.text, fontFamily: HUD.ui };

const PANEL: React.CSSProperties = {
  position: "fixed",
  right: 16,
  bottom: 16,
  zIndex: 36,
  width: 232,
  padding: "10px 12px 12px",
  borderRadius: 16,
  background: HUD.glass,
  backdropFilter: "blur(6px)",
  border: `1px solid ${HUD.border}`,
  color: HUD.text,
  fontFamily: HUD.ui,
  boxSizing: "border-box",
  pointerEvents: "auto",
};
const BTN: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: HUD.champagne,
  lineHeight: 0,
  width: 34,
  height: 34,
  borderRadius: 10,
  boxSizing: "border-box",
};
const PILL: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  position: "fixed",
  right: 16,
  bottom: 16,
  zIndex: 36,
  padding: "0 12px",
  minHeight: 36,   // phones: the RADIO pill is a thumb target (mobile plan)
  display: "inline-flex",
  alignItems: "center",
  boxSizing: "border-box",
  borderRadius: 999,
  background: HUD.glass,
  border: `1px solid ${HUD.border}`,
  color: HUD.champagne,
  fontFamily: HUD.game,
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: ".08em",
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
  note: "M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zM21 16a3 3 0 11-6 0 3 3 0 016 0z",
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
  const [expanded, setExpanded] = useState(false);
  /* phones (mobile plan, one overlay at a time): the player starts folded into the ▸ RADIO pill; the sky stays clear */
  const [phoneOpen, setPhoneOpen] = useState(false);
  const hud = useHudMode();
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

  const playRef = useRef<() => void>(() => {});
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.code !== "KeyR" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null; if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (gs.keys.buy.includes("KeyR") || gs.keys.sell.includes("KeyR")) return;   // bound to a trade: the trade wins
      playRef.current();
    };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, [gs.keys.buy, gs.keys.sell]);
  const musicOn = gs.music.on;
  const playing = st.running && !st.paused && musicOn && gs.music.vol > 0;
  const stations = stationList();
  const station = stations.find((s) => s.id === st.stationId) ?? stations[0];
  /* desktop Pilot (maker 2026-11-17): a fixed pill flush left of the ☰ menu, ♫ HOUSE + a sound on / off circle that mutes music AND
     effects. Click ♫ / the station to grow it sideways into a one-row bar (station, repeat, prev, play, next, shuffle, volume). Not a
     layout card here: no drag, no minimize, no old ▸ RADIO pill (CardChrome skips it). */
  const desk = !phone && hud !== "pro";
  const min = !desk && (card.min || (phone && (!!layout.radio?.min || !phoneOpen)));
  const closed = !desk && (card.closed || (phone && !!layout.radio?.closed));
  const hidePanel = min || closed;
  const phoneBottom: React.CSSProperties = phone
    ? { right: 12, top: "var(--ph-radio-top, 314px)", bottom: "auto" }   /* phone v2 board: folded under the chat button */
    : hud === "pro" ? { ...DESK, right: "auto", left: "calc(var(--ap-rail-w, 64px) + 20px)", bottom: 20, width: 326 }
    : { ...DESK, right: "calc(20px + var(--ap-topbar-w, 96px) + 8px)", top: 18, bottom: "auto", width: "auto", height: 44, borderRadius: 999, zIndex: 61, display: "flex", alignItems: "center" };

  useEffect(() => {
    if (!desk || !expanded) return;
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setExpanded(false); setPicker(false); } };
    const key = (e: KeyboardEvent) => { if (e.code === "Escape") { setExpanded(false); setPicker(false); } };
    addEventListener("pointerdown", down, true); addEventListener("keydown", key);
    return () => { removeEventListener("pointerdown", down, true); removeEventListener("keydown", key); };
  }, [desk, expanded]);

  const soundOn = gs.music.on || gs.sfx.on;
  const toggleSound = () => {
    void resumeAudio();
    setGameSettings((g) => soundOn
      ? { ...g, music: { ...g.music, on: false }, sfx: { ...g.sfx, on: false } }
      : { ...g, music: { on: true, vol: g.music.vol > 0 ? g.music.vol : DEFAULT_GAME_SETTINGS.music.vol }, sfx: { on: true, vol: g.sfx.vol > 0 ? g.sfx.vol : DEFAULT_GAME_SETTINGS.sfx.vol } });
  };

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
  playRef.current = () => (playing ? pause() : play());
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
      <style>{`
        [data-testid="radio-volume"] { -webkit-appearance: none; appearance: none; background: transparent; }
        [data-testid="radio-volume"]::-webkit-slider-runnable-track { height: 6px; border-radius: 3px; background: linear-gradient(to right, #F3DFA8 0%, #F3DFA8 var(--radio-vol, 0%), rgba(255,255,255,.14) var(--radio-vol, 0%), rgba(255,255,255,.14) 100%); }
        [data-testid="radio-volume"]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; margin-top: -5px; border-radius: 50%; background: #F3DFA8; border: 0; }
        [data-testid="radio-volume"]::-moz-range-track { height: 6px; border-radius: 3px; background: linear-gradient(to right, #F3DFA8 0%, #F3DFA8 var(--radio-vol, 0%), rgba(255,255,255,.14) var(--radio-vol, 0%), rgba(255,255,255,.14) 100%); }
        [data-testid="radio-volume"]::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: #F3DFA8; border: 0; }
      `}</style>

      {desk ? (
        <div ref={ref} data-card="radio" data-testid="radio-mini" data-expanded={expanded ? "1" : "0"} style={{ ...PANEL, ...phoneBottom, padding: "0 7px 0 4px", gap: 2 }}>
          <button type="button" data-testid="radio-line" aria-expanded={expanded} aria-label="Radio controls" title="Radio controls (R plays / pauses)"
            onClick={() => { setPicker(false); setExpanded((x) => !x); }} style={{ ...BTN, width: 36, height: 36, borderRadius: 18, opacity: playing ? 1 : 0.7 }}>
            <Ico d={ICONS.note} size={15} />
          </button>
          <div style={{ position: "relative", flex: "0 0 auto" }}>
            <button type="button" data-testid="radio-station" aria-haspopup="listbox" aria-expanded={picker} aria-label="Station"
              onClick={() => (expanded ? setPicker((p) => !p) : setExpanded(true))}
              style={{ ...BTN, width: "auto", height: 36, gap: 6, padding: "0 8px 0 2px", font: `700 15px/1 ${HUD.game}`, letterSpacing: ".08em", textTransform: "uppercase", opacity: playing ? 1 : 0.7 }}>
              {station?.label ?? "House"}
              <span style={{ display: "inline-flex", width: expanded ? 11 : 0, overflow: "hidden", transition: "width .2s ease" }}><Ico d={ICONS.chevron} size={11} /></span>
            </button>
            {picker && expanded && (
              <div data-testid="radio-station-list" role="listbox" aria-label="Station"
                style={{ position: "absolute", left: 0, top: "100%", zIndex: 2, minWidth: 150, marginTop: 10, padding: 4, borderRadius: 12, background: "#151726", border: `1px solid ${HUD.border}`, boxShadow: "0 8px 24px rgba(0,0,0,.5)" }}>
                {stations.map((s) => (
                  <button key={s.id} type="button" role="option" aria-selected={s.id === st.stationId} data-testid={`radio-station-${s.id}`} onClick={() => pickStation(s.id)}
                    style={{ ...BTN, display: "flex", width: "100%", justifyContent: "flex-start", height: 36, padding: "0 10px", borderRadius: 8,
                      color: s.id === st.stationId ? "#121327" : HUD.text, background: s.id === st.stationId ? HUD.champagne : "transparent",
                      font: `700 15px/1 ${HUD.game}`, letterSpacing: ".06em", textTransform: "uppercase" }}>
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div data-testid="radio-controls" aria-hidden={!expanded}
            style={{ display: "flex", alignItems: "center", gap: 2, overflow: "hidden", maxWidth: expanded ? 340 : 0, opacity: expanded ? 1 : 0,
              visibility: expanded ? "visible" : "hidden", transition: "max-width .22s ease, opacity .18s ease, visibility .22s" }}>
            <button type="button" data-testid="radio-repeat" aria-pressed={st.repeat === "one"} aria-label={st.repeat === "one" ? "Repeat this track" : "Repeat station"}
              title={st.repeat === "one" ? "Repeat this track" : "Repeat station"} onClick={toggleRepeat} style={{ ...BTN, opacity: st.repeat === "one" ? 1 : 0.55, position: "relative", flex: "0 0 auto" }}>
              <Ico d={ICONS.repeat} size={16} />
              {st.repeat === "one" && <span style={{ position: "absolute", right: 4, bottom: 4, fontSize: 9, fontWeight: 800, color: HUD.champagne }}>1</span>}
            </button>
            <button type="button" data-testid="radio-prev" aria-label="Previous track" title="Previous track" onClick={() => skip(-1)} style={{ ...BTN, flex: "0 0 auto" }}><Ico d={ICONS.prev} size={15} fill /></button>
            <button type="button" data-testid="radio-play" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (R)" : "Play (R)"} onClick={playing ? pause : play}
              style={{ ...BTN, flex: "0 0 auto", width: 32, height: 32, borderRadius: 16, color: "#121327", background: HUD.champagne }}>
              <Ico d={playing ? ICONS.pause : ICONS.play} size={14} fill />
            </button>
            <button type="button" data-testid="radio-next" aria-label="Next track" title="Next track" onClick={() => skip(1)} style={{ ...BTN, flex: "0 0 auto" }}><Ico d={ICONS.next} size={15} fill /></button>
            <button type="button" data-testid="radio-shuffle" aria-pressed={st.shuffle} aria-label={st.shuffle ? "Shuffle on" : "Shuffle"} title={st.shuffle ? "Shuffle on" : "Shuffle"}
              onClick={toggleShuffle} style={{ ...BTN, flex: "0 0 auto", opacity: st.shuffle ? 1 : 0.55 }}><Ico d={ICONS.shuffle} size={16} /></button>
            <input type="range" min={0} max={100} data-testid="radio-volume" aria-label="Music volume" title="Music volume"
              value={Math.round(gs.music.vol * 100)} onChange={(e) => setVol(+e.target.value / 100)}
              style={{ flex: "0 0 96px", width: 96, margin: "0 8px 0 6px", height: 20, opacity: musicOn ? 1 : 0.4, ["--radio-vol" as string]: `${Math.round(gs.music.vol * 100)}%` }} />
          </div>
          <button type="button" data-testid="radio-sound" aria-pressed={!soundOn} aria-label={soundOn ? "Mute all sound" : "Unmute"} title={soundOn ? "Mute music + effects" : "Unmute"}
            onClick={toggleSound}
            style={{ ...BTN, flex: "0 0 auto", width: 30, height: 30, borderRadius: 15, border: `1.5px solid ${HUD.champagne}`, opacity: soundOn ? 1 : 0.6 }}>
            <Ico d={soundOn ? ICONS.speaker : ICONS.speakerOff} size={14} fill={soundOn} sw={1.8} />
          </button>
        </div>
      ) : (
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
        {!phone && <button type="button" data-testid="radio-line" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)} title="Radio controls (R plays / pauses)"
          style={{ all: "unset", cursor: "pointer", boxSizing: "border-box", width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", fontSize: 14, color: HUD.text }}>
          <Ico d={ICONS.note} size={15} />
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: playing ? 1 : 0.7 }}>{station?.label ?? "House"} radio{playing ? "" : " · paused"}</span>
          <span aria-hidden="true" style={{ font: `700 12px ${HUD.game}`, color: HUD.dim }}>R</span>
        </button>}
        <div style={{ display: phone || expanded ? "block" : "none", padding: phone ? 0 : "0 12px 10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 8, minHeight: 34 }}>
          <div style={{ position: "relative", flex: "0 0 auto" }}>
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
                width: "auto",
                gap: 6,
                padding: "0 10px",
                background: "rgba(255,255,255,.06)",
                border: `1px solid ${HUD.border}`,
                color: HUD.champagne,
                font: `700 14px/1 ${HUD.game}`,
                letterSpacing: ".08em",
                textTransform: "uppercase",
              }}
            >
              {station?.label ?? "House"}
              <Ico d={ICONS.chevron} size={11} />
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
                  minWidth: 150,
                  marginTop: 6,
                  padding: 4,
                  borderRadius: 12,
                  background: "#151726",
                  border: `1px solid ${HUD.border}`,
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
                      height: 36,
                      padding: "0 10px",
                      borderRadius: 8,
                      color: s.id === st.stationId ? "#121327" : HUD.text,
                      background: s.id === st.stationId ? HUD.champagne : "transparent",
                      font: `700 15px/1 ${HUD.game}`,
                      letterSpacing: ".06em",
                      textTransform: "uppercase",
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            data-testid="radio-repeat"
            aria-pressed={st.repeat === "one"}
            aria-label={st.repeat === "one" ? "This track will play again." : "This station keeps playing all its tracks."}
            title={st.repeat === "one" ? "Repeat track" : "Repeat station"}
            onClick={toggleRepeat}
            style={{ ...BTN, opacity: st.repeat === "one" ? 1 : 0.55, position: "relative", marginLeft: "auto" }}
          >
            <Ico d={ICONS.repeat} size={16} />
            {st.repeat === "one" && <span style={{ position: "absolute", right: 4, bottom: 4, fontSize: 9, fontWeight: 800, color: HUD.champagne }}>1</span>}
          </button>
          <button type="button" data-testid="radio-prev" aria-label="Previous track" title="Previous track" onClick={() => skip(-1)} style={BTN}>
            <Ico d={ICONS.prev} size={16} fill />
          </button>
          <button
            type="button"
            data-testid="radio-play"
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause" : "Play"}
            onClick={playing ? pause : play}
            style={{ ...BTN, width: 42, height: 42, borderRadius: 21, color: "#121327", background: HUD.champagne }}
          >
            <Ico d={playing ? ICONS.pause : ICONS.play} size={16} fill />
          </button>
          <button type="button" data-testid="radio-next" aria-label="Next track" title="Next track" onClick={() => skip(1)} style={BTN}>
            <Ico d={ICONS.next} size={16} fill />
          </button>
          <button
            type="button"
            data-testid="radio-shuffle"
            aria-pressed={st.shuffle}
            aria-label={st.shuffle ? "Shuffle is on" : "Shuffle"}
            title={st.shuffle ? "Shuffle on" : "Shuffle"}
            onClick={toggleShuffle}
            style={{ ...BTN, opacity: st.shuffle ? 1 : 0.55 }}
          >
            <Ico d={ICONS.shuffle} size={16} />
          </button>
          {phone && (
            <button type="button" data-testid="radio-min" title="Minimize" aria-label="Minimize" onClick={() => { setPhoneOpen(false); updateLayout((l) => setCard(l, "radio", { min: true })); }} style={{ ...BTN, width: 28, font: `700 18px/1 ${HUD.ui}`, flex: "0 0 auto" }}>–</button>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
            style={{ flex: 1, accentColor: HUD.champagne, opacity: musicOn ? 1 : 0.4, minWidth: 0, height: 20, margin: 0, ["--radio-vol" as string]: `${Math.round(gs.music.vol * 100)}%` }}
          />
        </div>
        </div>
      </div>
      )}
      {phone && hidePanel && (
        <button
          type="button"
          data-testid="radio-pill"
          title="Show Radio"
          aria-label="Show Radio"
          onClick={() => { setPhoneOpen(true); updateLayout((l) => restoreCard(l, "radio")); }}
          style={{ ...PILL, ...phoneBottom }}
        >
          ♫ RADIO
        </button>
      )}
    </>
  );
}
