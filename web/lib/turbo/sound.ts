/**
 * TURBO sounds (GAME): all synthesized with WebAudio at run time. No audio files, no copyrighted assets.
 *   beep(level)  danger beeps at 20% / 10% / 5% to wipeout (higher + faster as it gets closer)
 *   supernova()  the wipeout boom: sub drop + filtered noise blast + a long rumble tail (loud by default)
 *   ignite()     a short whoosh when an order is sent
 * Every call is a no-op when muted, on the server, or when the browser blocks audio.
 */
let ac: AudioContext | null = null;
let muted = false;
export function setTurboMuted(m: boolean) { muted = m; }
function ctx(): AudioContext | null {
  if (typeof window === "undefined" || muted) return null;
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null; ac = ac || new AC(); if (ac.state === "suspended") void ac.resume(); return ac;
  } catch { return null; }
}
function noise(a: AudioContext, sec: number) {
  const b = a.createBuffer(1, Math.max(1, Math.floor(a.sampleRate * sec)), a.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = a.createBufferSource(); s.buffer = b; return s;
}
export function beep(level: number) {
  const a = ctx(); if (!a || level < 1) return;
  const t = a.currentTime, f = [0, 660, 880, 1175][Math.min(3, level)], n = level;
  for (let i = 0; i < n; i++) {
    const t0 = t + i * 0.11, o = a.createOscillator(), g = a.createGain();
    o.type = "square"; o.frequency.setValueAtTime(f, t0);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.08);
    o.connect(g).connect(a.destination); o.start(t0); o.stop(t0 + 0.09);
  }
}
export function ignite() {
  const a = ctx(); if (!a) return;
  const t = a.currentTime, s = noise(a, 0.5), f = a.createBiquadFilter(), g = a.createGain();
  f.type = "bandpass"; f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(2400, t + 0.4); f.Q.value = 0.8;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.06); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.48);
  s.connect(f).connect(g).connect(a.destination); s.start(t); s.stop(t + 0.5);
}
export function supernova() {
  const a = ctx(); if (!a) return;
  const t = a.currentTime, out = a.createDynamicsCompressor(); out.threshold.value = -10; out.ratio.value = 6; out.connect(a.destination);
  // 0.0–0.3 s: rising hull whine (white-hot)
  { const o = a.createOscillator(), g = a.createGain(); o.type = "sawtooth"; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(1800, t + 0.32);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.25); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.36); o.connect(g).connect(out); o.start(t); o.stop(t + 0.4); }
  const b = t + 0.45;   // implosion → white-out
  // sub drop
  { const o = a.createOscillator(), g = a.createGain(); o.type = "sine"; o.frequency.setValueAtTime(120, b); o.frequency.exponentialRampToValueAtTime(28, b + 1.6);
    g.gain.setValueAtTime(0.0001, b); g.gain.exponentialRampToValueAtTime(0.9, b + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, b + 2.2); o.connect(g).connect(out); o.start(b); o.stop(b + 2.3); }
  // blast
  { const s = noise(a, 1.2), f = a.createBiquadFilter(), g = a.createGain(); f.type = "lowpass"; f.frequency.setValueAtTime(6000, b); f.frequency.exponentialRampToValueAtTime(300, b + 1.1);
    g.gain.setValueAtTime(0.0001, b); g.gain.exponentialRampToValueAtTime(0.8, b + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, b + 1.15); s.connect(f).connect(g).connect(out); s.start(b); s.stop(b + 1.2); }
  // second shockwave crack + rumble tail
  { const c = b + 0.7, s = noise(a, 4.5), f = a.createBiquadFilter(), g = a.createGain(); f.type = "lowpass"; f.frequency.value = 180;
    g.gain.setValueAtTime(0.0001, c); g.gain.exponentialRampToValueAtTime(0.55, c + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, c + 4.4); s.connect(f).connect(g).connect(out); s.start(c); s.stop(c + 4.5); }
}
