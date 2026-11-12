/**
 * In-game radio player. Two HTMLAudioElements through a shared Web Audio music bus, with a short
 * crossfade between tracks so a lossy playlist (AAC) doesn't click or gap. Volume comes from the
 * existing music channel (audioLevel("music")). One singleton — remounting the flight canvas must
 * not start a second station.
 *
 * Pattern: common web / in-game radio (playlist + Web Audio gains + crossfade, respect mute, start
 * only after a user gesture). Gapless AudioBuffer scheduling is a poor fit here: tracks are long,
 * and AAC encoder padding makes true gapless unreliable.
 */
import { withBase } from "@/lib/base-path";
import { getAudioContext } from "./audio";
import { DEFAULT_STATION_ID, nextTrackIndex, stationOf, type RadioStation } from "./stations";

/** Seconds of overlap between the outgoing and incoming track. */
export const CROSSFADE_SEC = 0.8;

export type RadioStatus = {
  playing: boolean;
  index: number;
  stationId: string;
  level: number;
  audioElements: number;
};

type Deck = { el: HTMLAudioElement; gain: GainNode };

function makeAudio(): HTMLAudioElement {
  const el = new Audio();
  el.preload = "auto";
  el.crossOrigin = "anonymous";
  el.loop = false;
  return el;
}

export class GameRadio {
  private station: RadioStation;
  private decks: [Deck, Deck] | null = null;
  private master: GainNode | null = null;
  private cur: 0 | 1 = 0;
  private index = 0;
  private fading = false;
  private running = false;
  private level = 0;
  private hooked = false;

  constructor(stationId: string = DEFAULT_STATION_ID) {
    this.station = stationOf(stationId);
  }

  /** Exactly two media elements once wired; 0 before the first start in a browser. */
  audioElementCount(): number { return this.decks ? 2 : 0; }

  status(): RadioStatus {
    return {
      playing: this.running && this.level > 0,
      index: this.index,
      stationId: this.station.id,
      level: this.level,
      audioElements: this.audioElementCount(),
    };
  }

  setStation(id: string) {
    const next = stationOf(id);
    if (next.id === this.station.id) return;
    const was = this.running;
    this.stop();
    this.station = next;
    this.index = 0;
    if (was && this.level > 0) this.start();
  }

  setLevel(level: number) {
    this.level = level > 0 ? level : 0;
    const ctx = getAudioContext();
    if (this.master && ctx) {
      const g = this.master.gain;
      try {
        g.cancelScheduledValues(ctx.currentTime);
        g.setTargetAtTime(this.level, ctx.currentTime, 0.03);
      } catch { g.value = this.level; }
    }
  }

  start() {
    if (this.level <= 0 || this.station.tracks.length === 0) return;
    if (!this.ensureGraph()) return;
    if (this.running) return;
    this.running = true;
    this.playDeck(this.cur, this.index, 1);
    this.preloadOther();
  }

  stop() {
    this.running = false;
    this.fading = false;
    if (!this.decks) return;
    for (const d of this.decks) {
      try { d.el.pause(); } catch { /* */ }
      try { d.gain.gain.value = 0; } catch { /* */ }
    }
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

  private playDeck(deck: 0 | 1, index: number, gain: number) {
    const d = this.decks![deck];
    const src = this.srcAt(index);
    if (d.el.src !== new URL(src, window.location.href).href && d.el.getAttribute("src") !== src) {
      d.el.src = src;
    }
    try { d.gain.gain.value = gain; } catch { /* */ }
    const p = d.el.play();
    if (p && typeof p.catch === "function") p.catch(() => { /* autoplay blocked — wait for a gesture */ });
  }

  private preloadOther() {
    if (!this.decks || this.station.tracks.length < 2) return;
    const other = this.decks[1 - this.cur]!;
    const src = this.srcAt(nextTrackIndex(this.index, this.station.tracks.length));
    if (!src) return;
    try {
      if (other.el.getAttribute("src") !== src && !other.el.src.endsWith(src) && other.el.src !== new URL(src, typeof window !== "undefined" ? window.location.href : "http://local.test").href) {
        other.el.src = src;
        other.el.load();
      }
    } catch { /* */ }
  }

  private onTime(deck: 0 | 1) {
    if (!this.running || this.fading || deck !== this.cur || !this.decks) return;
    const el = this.decks[deck].el;
    const dur = el.duration, t = el.currentTime;
    if (!Number.isFinite(dur) || dur <= 0) return;
    if (dur - t <= CROSSFADE_SEC) this.crossfade();
  }

  private onEnded(deck: 0 | 1) {
    if (!this.running || deck !== this.cur) return;
    if (this.fading) return;
    // Fallback if we missed the fade window (very short file, or a seek past the end).
    const from = this.cur;
    this.index = nextTrackIndex(this.index, this.station.tracks.length);
    this.cur = (1 - this.cur) as 0 | 1;
    this.playDeck(this.cur, this.index, 1);
    if (this.decks) {
      try { this.decks[from].gain.gain.value = 0; } catch { /* */ }
      try { this.decks[from].el.pause(); } catch { /* */ }
    }
    this.preloadOther();
  }

  private crossfade() {
    if (!this.decks || this.fading || this.station.tracks.length === 0) return;
    const ctx = getAudioContext();
    if (!ctx) { this.onEnded(this.cur); return; }
    this.fading = true;
    const from = this.cur;
    const to = (1 - from) as 0 | 1;
    const next = nextTrackIndex(this.index, this.station.tracks.length);
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
