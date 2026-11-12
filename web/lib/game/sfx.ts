/**
 * Flight sound effects on the Sound effects channel (settings `sfx`, audioLevel("sfx"), the `disciple:audio` event).
 *
 * Procedural Web Audio, no audio files: every sound is built from oscillators and one shared white-noise buffer,
 * the way jsfxr / sfxr-style game sounds are (a noise or tone source, a filter sweep, a short gain envelope).
 * All of it runs through one bus GainNode set to the saved SFX level, so the existing slider and mute apply.
 *
 * The flight engine (public/flight/engine.js, main thread or render worker) only dispatches
 *   `disciple:sfx` {k: "fly" | "boost" | "explode" | "tier" | "hit" | "ascend" | "drop", ...}
 * and this module turns those into sound. Nothing plays until the shared AudioContext is running, which needs a user
 * gesture (same unlock as the house radio in components/flight/GameRadio.tsx and lib/game/audio.ts).
 */
import { getAudioContext } from "./audio";

export type SfxKind = "fly" | "boost" | "explode" | "tier" | "hit" | "ascend" | "drop";
export type SfxDetail = {
  k: SfxKind;
  /** fly: engine loudness 0..1; boost / hit: strength 0..1 */
  v?: number;
  /** explode: bomb tier 0..5 (puff, grenade, bunker buster, cruise missile, nuke, atom bomb) */
  tier?: number;
  /** hit: what the blast hit */
  on?: "rocket" | "cloud";
};

/** Explosion sizes, indexed by the engine's BOMB_TIERS (puff … atom). Bigger = longer, louder, lower. */
export const EXPLODE = [
  { dur: 0.2, peak: 0.12, lp0: 1800, lp1: 600, thump: 0, f0: 0, f1: 0 },
  { dur: 0.45, peak: 0.3, lp0: 3200, lp1: 500, thump: 0.18, f0: 120, f1: 55 },
  { dur: 0.9, peak: 0.42, lp0: 2600, lp1: 320, thump: 0.32, f0: 95, f1: 42 },
  { dur: 1.3, peak: 0.52, lp0: 2200, lp1: 240, thump: 0.42, f0: 85, f1: 36 },
  { dur: 2.0, peak: 0.64, lp0: 1700, lp1: 160, thump: 0.55, f0: 72, f1: 30 },
  { dur: 3.2, peak: 0.78, lp0: 1400, lp1: 110, thump: 0.7, f0: 62, f1: 24 },
] as const;

/** Minimum gap per kind (s), so a burst of trades can't stack dozens of identical voices. */
export const SFX_GAP: Record<SfxKind, number> = { fly: 0, boost: 0.06, explode: 0.08, tier: 0.15, hit: 0.07, ascend: 1.5, drop: 0.3 };
export const MAX_VOICES = 24;
/** Engine loudness: the hum while hovering, rising with airspeed and boosts. */
export const flyGain = (v: number) => 0.035 + 0.2 * Math.max(0, Math.min(1, v));
export const flyCutoff = (v: number) => 220 + 1500 * Math.max(0, Math.min(1, v));
/** Tier chime pitch: climbs a whole step per tier, folded into one octave so it never gets shrill. */
export const tierFreq = (tier: number) => { const i = Math.max(0, Math.floor(tier)); return 523.25 * Math.pow(2, ((i * 2) % 12) / 12); };

type Fly = { src: AudioBufferSourceNode; osc: OscillatorNode; lp: BiquadFilterNode; g: GainNode; last: number };

export class FlightSfx {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private level = 0;
  private voices = 0;
  private lastAt: Partial<Record<SfxKind, number>> = {};
  private fly: Fly | null = null;
  played = 0;

  /** Effective SFX level 0..1 (0 = muted). Mute stops the engine hum right away. */
  setLevel(level: number) {
    this.level = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
    if (this.bus && this.ctx) this.bus.gain.setTargetAtTime(this.level, this.ctx.currentTime, 0.03);
    if (this.level <= 0) this.stopFly();
  }
  getLevel() { return this.level; }

  /** True only when there is something to hear and the browser has allowed sound (after a user gesture). */
  canPlay(): boolean {
    if (!(this.level > 0)) return false;
    const ctx = getAudioContext();
    return !!ctx && ctx.state === "running";
  }

  private ensure(): AudioContext | null {
    const ctx = getAudioContext();
    if (!ctx) return null;
    if (this.ctx !== ctx) { this.ctx = ctx; this.bus = null; this.noise = null; this.fly = null; }
    if (!this.bus) {
      const comp = ctx.createDynamicsCompressor();   // keeps a nuke plus a tier chime from clipping
      this.bus = ctx.createGain();
      this.bus.gain.value = this.level;
      this.bus.connect(comp).connect(ctx.destination);
    }
    if (!this.noise) {
      const n = Math.floor(ctx.sampleRate * 2), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this.noise = b;
    }
    return ctx;
  }

  /** Play one engine event. Returns true when a sound was scheduled. */
  play(d: SfxDetail | null | undefined): boolean {
    if (!d || typeof d.k !== "string") return false;
    if (d.k === "fly") return this.setFly(d.v ?? 0);
    if (!this.canPlay()) return false;
    const ctx = this.ensure();
    if (!ctx || !this.bus) return false;
    const now = ctx.currentTime, gap = SFX_GAP[d.k];
    if (gap === undefined) return false;
    const prev = this.lastAt[d.k];
    if (prev !== undefined && now - prev < gap) return false;
    if (this.voices >= MAX_VOICES) return false;
    this.lastAt[d.k] = now;
    const v = Math.max(0.15, Math.min(1, d.v ?? 1));
    switch (d.k) {
      case "boost": this.boost(ctx, now, v); break;
      case "explode": this.explode(ctx, now, Math.max(0, Math.min(5, Math.round(d.tier ?? 0)))); break;
      case "tier": this.tier(ctx, now, d.tier ?? 0); break;
      case "hit": this.hit(ctx, now, d.on === "cloud" ? "cloud" : "rocket", v); break;
      case "ascend": this.ascend(ctx, now); break;
      case "drop": this.drop(ctx, now, v); break;
      default: return false;
    }
    this.played++;
    return true;
  }

  // ---- building blocks
  private voice(end: number) { this.voices++; const ms = Math.max(0, end - (this.ctx?.currentTime ?? 0)) * 1000 + 50; setTimeout(() => { this.voices = Math.max(0, this.voices - 1); }, ms); }
  private env(ctx: AudioContext, t: number, peak: number, attack: number, dur: number): GainNode {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    return g;
  }
  private noiseSrc(ctx: AudioContext): AudioBufferSourceNode {
    const s = ctx.createBufferSource(); s.buffer = this.noise; return s;
  }
  private filt(ctx: AudioContext, type: BiquadFilterType, f0: number, f1: number, t: number, dur: number, q = 0.8): BiquadFilterNode {
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    return f;
  }
  private noiseHit(ctx: AudioContext, t: number, type: BiquadFilterType, f0: number, f1: number, peak: number, attack: number, dur: number, q = 0.8) {
    const s = this.noiseSrc(ctx), f = this.filt(ctx, type, f0, f1, t, dur, q), g = this.env(ctx, t, peak, attack, dur);
    s.connect(f).connect(g).connect(this.bus!);
    s.start(t, Math.random() * 1.2); s.stop(t + dur + 0.05); this.voice(t + dur);
  }
  private tone(ctx: AudioContext, t: number, type: OscillatorType, f0: number, f1: number, peak: number, attack: number, dur: number) {
    const o = ctx.createOscillator(), g = this.env(ctx, t, peak, attack, dur);
    o.type = type; o.frequency.setValueAtTime(f0, t); if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    o.connect(g).connect(this.bus!); o.start(t); o.stop(t + dur + 0.05); this.voice(t + dur);
  }

  // ---- sounds
  /** BOOST: a rising jet whoosh (band-passed noise sweeping up) over a short saw lift. */
  private boost(ctx: AudioContext, t: number, v: number) {
    this.noiseHit(ctx, t, "bandpass", 320, 2600, 0.32 * v, 0.03, 0.5, 1.1);
    this.tone(ctx, t, "sawtooth", 110, 330, 0.06 * v, 0.02, 0.35);
  }
  /** Explosion of a given size: low-passed noise with a closing filter plus a falling sub thump for the bigger ones. */
  private explode(ctx: AudioContext, t: number, tier: number) {
    const p = EXPLODE[tier];
    this.noiseHit(ctx, t, "lowpass", p.lp0, p.lp1, p.peak, 0.006, p.dur, 0.7);
    if (p.thump > 0) this.tone(ctx, t, "sine", p.f0, p.f1, p.thump, 0.008, p.dur * 0.7);
  }
  /** New tier: a two-note chime (root, then a fifth above). */
  private tier(ctx: AudioContext, t: number, tier: number) {
    const f = tierFreq(tier);
    this.tone(ctx, t, "triangle", f, f, 0.16, 0.01, 0.35);
    this.tone(ctx, t + 0.11, "triangle", f * 1.5, f * 1.5, 0.15, 0.01, 0.5);
    this.tone(ctx, t + 0.11, "sine", f * 3, f * 3, 0.04, 0.01, 0.6);
  }
  /** Blast front hitting the rocket (a short metallic clank) or a cloud (a soft puff). */
  private hit(ctx: AudioContext, t: number, on: "rocket" | "cloud", v: number) {
    if (on === "rocket") {
      this.noiseHit(ctx, t, "highpass", 2600, 1800, 0.18 * v, 0.002, 0.09, 0.9);
      this.tone(ctx, t, "square", 940, 700, 0.05 * v, 0.002, 0.22);
    } else this.noiseHit(ctx, t, "lowpass", 900, 260, 0.14 * v, 0.01, 0.24, 0.7);
  }
  /** Ascension: a long rising sweep (the jump to hyperspeed), then a deep boom as it punches through. */
  private ascend(ctx: AudioContext, t: number) {
    this.tone(ctx, t, "sawtooth", 160, 1500, 0.09, 0.2, 1.15);
    this.noiseHit(ctx, t, "bandpass", 400, 6000, 0.22, 0.6, 1.2, 1.4);
    this.noiseHit(ctx, t + 1.05, "lowpass", 2400, 200, 0.45, 0.006, 1.4, 0.7);
    this.tone(ctx, t + 1.05, "sine", 90, 34, 0.45, 0.01, 1.0);
  }
  /** Big sell: a falling whistle and a downward whoosh as the rocket drops. */
  private drop(ctx: AudioContext, t: number, v: number) {
    this.tone(ctx, t, "sine", 560, 80, 0.12 * v, 0.02, 0.7);
    this.noiseHit(ctx, t, "lowpass", 2200, 180, 0.2 * v, 0.03, 0.7, 0.9);
  }

  /** Engine hum: looped noise through a low-pass plus a low saw, both following the engine's loudness. */
  private setFly(v: number): boolean {
    if (!this.canPlay()) { this.stopFly(); return false; }
    const ctx = this.ensure();
    if (!ctx || !this.bus) return false;
    const t = ctx.currentTime, x = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    if (!this.fly) {
      const src = this.noiseSrc(ctx); src.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 0.6; lp.frequency.value = flyCutoff(x);
      const osc = ctx.createOscillator(); osc.type = "sawtooth"; osc.frequency.value = 42 + 30 * x;
      const og = ctx.createGain(); og.gain.value = 0.18;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(flyGain(x), t + 0.4);
      src.connect(lp); osc.connect(og).connect(lp); lp.connect(g).connect(this.bus);
      src.start(t); osc.start(t);
      this.fly = { src, osc, lp, g, last: t };
    } else {
      this.fly.g.gain.setTargetAtTime(flyGain(x), t, 0.12);
      this.fly.lp.frequency.setTargetAtTime(flyCutoff(x), t, 0.12);
      this.fly.osc.frequency.setTargetAtTime(42 + 30 * x, t, 0.2);
    }
    this.fly.last = t;
    return true;
  }
  /** Fades the hum out (mute, page leaving, engine paused). */
  stopFly() {
    const f = this.fly, ctx = this.ctx;
    this.fly = null;
    if (!f || !ctx) return;
    const t = ctx.currentTime;
    try { f.g.gain.cancelScheduledValues(t); f.g.gain.setTargetAtTime(0.0001, t, 0.08); f.src.stop(t + 0.4); f.osc.stop(t + 0.4); } catch { /* already stopped */ }
  }
  /** The engine sends the hum level several times a second; if it stops (tab hidden, engine gone), fade out. */
  watchdog(maxSilence = 1.5) {
    const f = this.fly, ctx = this.ctx;
    if (f && ctx && ctx.currentTime - f.last > maxSilence) this.stopFly();
  }
  flyOn() { return !!this.fly; }
  activeVoices() { return this.voices; }
}

let inst: FlightSfx | null = null;
export function getFlightSfx(): FlightSfx { return inst ?? (inst = new FlightSfx()); }
export function resetFlightSfxForTests() { inst?.stopFly(); inst = null; }
