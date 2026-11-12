/**
 * Dual-deck in-game radio on the shared music bus.
 *
 * AAC encoder padding makes a true gapless hand-off unreliable, so we crossfade
 * the last CROSSFADE_SEC of the current track into the next. Two <audio> elements
 * share one GainNode (the music bus) so volume tracks settings.audioLevel("music").
 *
 * Pause is session-local: it stops playback without flipping the Music setting off.
 * Shuffle randomizes order within the current station and still loops. Repeat "one"
 * holds the current track; the default is the station loop (every track, then back).
 */
import { getAudioContext } from "./audio";
import {
  DEFAULT_STATION_ID, stationOf, nextTrackIndex, stepTrack, shuffledOrder, identityOrder,
  type RadioStation, type RepeatMode,
} from "./stations";

export const CROSSFADE_SEC = 0.8;

export type RadioStatus = {
  running: boolean;
  /** Alias of running, kept so existing tests can read status().playing. */
  playing: boolean;
  paused: boolean;
  level: number;
  stationId: string;
  index: number;
  trackIndex: number;
  trackTitle: string;
  shuffle: boolean;
  repeat: RepeatMode;
};

type Deck = { el: HTMLAudioElement; gain: GainNode };

function makeAudio(): HTMLAudioElement {
  const el = new Audio();
  el.preload = "auto";
  el.crossOrigin = "anonymous";
  if (typeof el.setAttribute === "function") el.setAttribute("playsinline", "");
  return el;
}

function withBase(src: string): string {
  if (typeof window === "undefined" || typeof document === "undefined") return src;
  const base = document.querySelector("base")?.getAttribute("href") ?? "";
  if (!base || base === "/") return src;
  return base.replace(/\/$/, "") + src;
}

function sameSrc(el: HTMLAudioElement, src: string): boolean {
  if (el.getAttribute("src") === src) return true;
  try {
    return el.src === new URL(src, window.location.href).href;
  } catch {
    return el.src.endsWith(src);
  }
}

export class GameRadio {
  private station: RadioStation = stationOf(DEFAULT_STATION_ID);
  private index = 0;
  private order: number[] = identityOrder(this.station.tracks.length);
  private shuffle = false;
  private repeat: RepeatMode = "station";
  private sessionPaused = false;
  private level = 0;
  private decks: [Deck, Deck] | null = null;
  private master: GainNode | null = null;
  private cur: 0 | 1 = 0;
  private running = false;
  private fading = false;
  private hooked = false;
  private listeners = new Set<() => void>();
  private snap: RadioStatus = this.buildStatus();

  status(): RadioStatus { return this.snap; }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  private buildStatus(): RadioStatus {
    const track = this.station.tracks[this.index];
    return {
      running: this.running,
      playing: this.running,
      paused: this.sessionPaused,
      level: this.level,
      stationId: this.station.id,
      index: this.index,
      trackIndex: this.index,
      trackTitle: track?.title ?? "",
      shuffle: this.shuffle,
      repeat: this.repeat,
    };
  }

  private emit() {
    this.snap = this.buildStatus();
    for (const fn of this.listeners) fn();
  }

  setStation(id: string) {
    const next = stationOf(id);
    if (next.id === this.station.id) return;
    const was = this.running;
    this.stop();
    this.station = next;
    this.index = 0;
    this.rebuildOrder(true);
    this.applyLoopFlag();
    if (was && !this.sessionPaused) this.start();
    this.emit();
  }

  setShuffle(on: boolean) {
    if (this.shuffle === on) return;
    this.shuffle = on;
    this.rebuildOrder(true);
    this.preloadOther();
    this.emit();
  }

  setRepeat(mode: RepeatMode) {
    if (this.repeat === mode) return;
    this.repeat = mode;
    this.applyLoopFlag();
    this.preloadOther();
    this.emit();
  }

  /** Session-local stop. Does not change the Music setting or volume. */
  pause() {
    this.sessionPaused = true;
    this.stop();
    this.emit();
  }

  /** Clear a session pause so the next start() (or apply() hook) can play. */
  clearPause() {
    if (!this.sessionPaused) return;
    this.sessionPaused = false;
    this.emit();
  }

  isPaused(): boolean { return this.sessionPaused; }

  /** Test helper: how many <audio> decks this instance created. */
  audioElementCount(): number { return this.decks ? this.decks.length : 0; }

  /** Jump to the previous or next track in the current (possibly shuffled) order. Always skips, even in Repeat one. */
  skip(dir: 1 | -1) {
    if (this.station.tracks.length === 0) return;
    this.index = stepTrack(this.order, this.index, dir);
    this.fading = false;
    if (this.running) {
      this.playDeck(this.cur, this.index, 1, true);
      const other = this.decks?.[1 - this.cur];
      if (other) {
        try { other.el.pause(); } catch { /* */ }
        try { other.gain.gain.value = 0; } catch { /* */ }
      }
      this.applyLoopFlag();
      this.preloadOther();
    }
    this.emit();
  }

  setLevel(level: number) {
    const next = Math.max(0, Math.min(1, level));
    const changed = next !== this.level;
    this.level = next;
    if (changed) this.emit();
    if (!this.master) return;
    const ctx = getAudioContext();
    const g = this.master.gain;
    if (ctx) {
      try {
        g.cancelScheduledValues(ctx.currentTime);
        g.setTargetAtTime(this.level, ctx.currentTime, 0.03);
      } catch { g.value = this.level; }
    } else {
      g.value = this.level;
    }
  }

  start() {
    if (this.sessionPaused || this.level <= 0 || this.station.tracks.length === 0) return;
    if (!this.ensureGraph()) return;
    if (this.running) return;
    this.running = true;
    this.applyLoopFlag();
    this.playDeck(this.cur, this.index, 1);
    this.preloadOther();
    this.emit();
  }

  stop() {
    const was = this.running;
    this.running = false;
    this.fading = false;
    if (this.decks) {
      for (const d of this.decks) {
        try { d.el.pause(); } catch { /* */ }
        try { d.gain.gain.value = 0; } catch { /* */ }
      }
    }
    if (was) this.emit();
  }

  private rebuildOrder(keepCurrent: boolean) {
    const n = this.station.tracks.length;
    this.order = this.shuffle
      ? shuffledOrder(n, Math.random, keepCurrent ? this.index : undefined)
      : identityOrder(n);
  }

  private peekNext(): number {
    if (this.repeat === "one") return this.index;
    return stepTrack(this.order, this.index, 1);
  }

  private applyLoopFlag() {
    if (!this.decks) return;
    const loop = this.repeat === "one";
    for (const d of this.decks) d.el.loop = loop;
  }

  private ensureGraph(): boolean {
    if (this.decks) return true;
    if (typeof window === "undefined" || typeof Audio === "undefined") return false;
    const ctx = getAudioContext();
    if (!ctx) return false;
    const master = ctx.createGain();
    master.gain.value = this.level;
    master.connect(ctx.destination);
    const a = makeAudio(), b = makeAudio();
    const ga = ctx.createGain(), gb = ctx.createGain();
    ga.gain.value = 1; gb.gain.value = 0;
    ctx.createMediaElementSource(a).connect(ga).connect(master);
    ctx.createMediaElementSource(b).connect(gb).connect(master);
    this.master = master;
    this.decks = [{ el: a, gain: ga }, { el: b, gain: gb }];
    this.hook(a, 0);
    this.hook(b, 1);
    this.hooked = true;
    this.applyLoopFlag();
    return true;
  }

  private hook(el: HTMLAudioElement, deck: 0 | 1) {
    if (this.hooked && this.decks) { /* elements already have listeners from first wire */ }
    el.addEventListener("timeupdate", () => this.onTime(deck));
    el.addEventListener("ended", () => this.onEnded(deck));
  }

  private srcAt(index: number): string {
    const track = this.station.tracks[index];
    return track ? withBase(track.src) : "";
  }

  private playDeck(deck: 0 | 1, index: number, gain: number, restart = false) {
    const d = this.decks![deck];
    const src = this.srcAt(index);
    if (!sameSrc(d.el, src)) d.el.src = src;
    else if (restart) {
      try { d.el.currentTime = 0; } catch { /* */ }
    }
    try { d.gain.gain.value = gain; } catch { /* */ }
    const p = d.el.play();
    if (p && typeof p.catch === "function") p.catch(() => { /* autoplay blocked — wait for a gesture */ });
  }

  private preloadOther() {
    if (!this.decks || this.station.tracks.length < 2 || this.repeat === "one") return;
    const other = this.decks[1 - this.cur]!;
    const src = this.srcAt(this.peekNext());
    if (!src) return;
    try {
      if (!sameSrc(other.el, src)) {
        other.el.src = src;
        other.el.load();
      }
    } catch { /* */ }
  }

  private onTime(deck: 0 | 1) {
    if (!this.running || this.fading || deck !== this.cur || !this.decks) return;
    if (this.repeat === "one") return;
    const el = this.decks[deck].el;
    const dur = el.duration, t = el.currentTime;
    if (!Number.isFinite(dur) || dur <= 0) return;
    if (dur - t <= CROSSFADE_SEC) this.crossfade();
  }

  private onEnded(deck: 0 | 1) {
    if (!this.running || deck !== this.cur) return;
    if (this.fading) return;
    if (this.repeat === "one") {
      this.playDeck(this.cur, this.index, 1, true);
      return;
    }
    const from = this.cur;
    this.index = this.peekNext();
    this.cur = (1 - this.cur) as 0 | 1;
    this.playDeck(this.cur, this.index, 1);
    if (this.decks) {
      try { this.decks[from].gain.gain.value = 0; } catch { /* */ }
      try { this.decks[from].el.pause(); } catch { /* */ }
    }
    this.preloadOther();
    this.emit();
  }

  private crossfade() {
    if (!this.decks || this.fading || this.station.tracks.length === 0) return;
    if (this.repeat === "one") return;
    const ctx = getAudioContext();
    if (!ctx) { this.onEnded(this.cur); return; }
    this.fading = true;
    const from = this.cur;
    const to = (1 - from) as 0 | 1;
    const next = this.peekNext();
    this.playDeck(to, next, 0);
    const now = ctx.currentTime;
    const fade = CROSSFADE_SEC;
    const outG = this.decks[from].gain.gain;
    const inG = this.decks[to].gain.gain;
    try {
      outG.cancelScheduledValues(now);
      inG.cancelScheduledValues(now);
      outG.setValueAtTime(outG.value || 1, now);
      inG.setValueAtTime(inG.value || 0, now);
      outG.linearRampToValueAtTime(0, now + fade);
      inG.linearRampToValueAtTime(1, now + fade);
    } catch {
      outG.value = 0; inG.value = 1;
    }
    window.setTimeout(() => {
      try { this.decks?.[from].el.pause(); } catch { /* */ }
      this.index = next;
      this.cur = to;
      this.fading = false;
      this.preloadOther();
      this.emit();
    }, fade * 1000 + 40);
  }
}

let singleton: GameRadio | null = null;

/** One player per page. */
export function getGameRadio(): GameRadio {
  if (!singleton) singleton = new GameRadio();
  return singleton;
}

/** Test-only: drop the singleton so the next getGameRadio() builds a fresh player. */
export function resetGameRadioForTests() {
  if (singleton) singleton.stop();
  singleton = null;
}
