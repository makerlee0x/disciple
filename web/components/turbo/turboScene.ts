/**
 * TURBO scene renderer (GAME, client only). A self-contained canvas-2D renderer for the Turbo lab that reuses the
 * flight engine's look (public/flight/engine.js): tier sky plates, rocket.png lit with a rim + warm underlight, additive
 * flame cone + core bloom, contrail, speed streaks, fireball / ring / god-ray bomb vocabulary. It does NOT modify
 * engine.js. Camera never shakes: every "shake" here offsets only the rocket sprite.
 *
 *   Vertical axis = price, mapped so the wipeout line sits a fixed distance from the entry line. Long: nose up, the
 *   wipeout line is below. Short ("Dive run"): nose down, diving; the jetstream trails upward; the wipeout line is a
 *   ceiling above. Jetstream intensity j = log10(leverage)/3 drives flame length, particle rate, contrail width,
 *   speed-line count/length/speed and a baseline airspeed, so 1000× screams even on a flat price.
 *   SUPERNOVA (wipeout): white-hot hull → implosion → white-out → two shockwaves leaving the screen → star-collapse
 *   mushroom + ember/debris rain (~6.5 s) → scorched sky. Bigger than ATOM on every axis (life 4.6 → 6.5 s,
 *   shock radius 1150 → 2600 px, flash .95 → 1.0 + implosion + second ring).
 */
import { jetOf } from "@/lib/turbo/gameFx";
import { T } from "@/lib/turbo/copy";

export interface SceneInput {
  price: number;
  /** open or pending position on this market (null = idle) */
  pos: null | { side: "long" | "short"; entry: number; liq: number; lev: number; tp?: number; sl?: number; pending: boolean };
  /** idle preview (selected leverage + last side) */
  lev: number;
  heat: number;          // 0..1 (1 = at the wipeout)
  roiPct: number;        // PnL after fees as % of the bet (sky plates)
  xFrac: number;         // rocket x as a fraction of the canvas width
  topPad: number;        // px reserved at the top (HUD)
  bottomPad: number;     // px reserved at the bottom (buttons)
  fmtPrice: (v: number) => string;
}
type P = { x: number; y: number; vx: number; vy: number; life: number; max: number; r: number; k: number; c: string; g?: number };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (k: number, dt: number) => 1 - Math.exp(-k * dt);
const SN_LIFE = 6.5, SN_FLASH = 0.75;

export class TurboScene {
  private cv: HTMLCanvasElement; private ctx: CanvasRenderingContext2D;
  private W = 0; private H = 0; private dpr = 1; private raf = 0; private last = 0; private t = 0;
  private inp: SceneInput | null = null;
  private img: Record<string, HTMLImageElement> = {};
  private camY = 0; private ry = 0; private rx = 0; private scale = 0; private ref = 0;
  private parts: P[] = []; private fx: P[] = []; private bits: P[] = []; private stars: { x: number; y: number; z: number }[] = [];
  private trail: { x: number; y: number }[] = []; private scroll = 0; private plate = 4; private plateFrom = 4; private plateT = 1;
  private sn: null | { t: number; x: number; y: number; puffs: { a: number; r: number; s: number }[]; done: boolean; side: "long" | "short" } = null;
  private scorch = 0; private ign = 0; private wasPending = false;
  /** called ~3.2 s into a SUPERNOVA (share card time) */
  onSupernovaCard: (() => void) | null = null;
  /** for screenshots/tests: freeze time (no rAF) and step manually */
  frozen = false;

  constructor(cv: HTMLCanvasElement) {
    this.cv = cv; this.ctx = cv.getContext("2d")!;
    const base = (window as unknown as { __DISCIPLE_BASE_PATH__?: string }).__DISCIPLE_BASE_PATH__ || "";
    for (const n of ["rocket", ...Array.from({ length: 18 }, (_, i) => `tier${i}`)]) {
      const im = new Image(); im.src = base + (n === "rocket" ? "/assets/rocket.png" : `/assets/${n}.webp`); this.img[n] = im;
    }
    for (let i = 0; i < 140; i++) this.stars.push({ x: Math.random(), y: Math.random(), z: 0.2 + Math.random() * 0.8 });
    this.resize();
    const loop = (ts: number) => { this.raf = requestAnimationFrame(loop); if (this.frozen) return; const dt = Math.min(0.05, this.last ? (ts - this.last) / 1000 : 0.016); this.last = ts; this.frame(dt); };
    this.raf = requestAnimationFrame(loop);
  }
  destroy() { cancelAnimationFrame(this.raf); }
  set(inp: SceneInput) { this.inp = inp; }
  resize() {
    const r = this.cv.getBoundingClientRect(); this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = Math.max(1, r.width); this.H = Math.max(1, r.height);
    this.cv.width = Math.round(this.W * this.dpr); this.cv.height = Math.round(this.H * this.dpr);
  }
  ignite() { this.ign = 1; }
  supernova() {
    const side = this.inp?.pos?.side || "long";
    this.sn = { t: 0, x: this.rx, y: this.ry, done: false, side, puffs: Array.from({ length: 34 }, () => ({ a: Math.random() * 6.283, r: Math.random(), s: 0.6 + Math.random() * 0.7 })) };
  }
  get supernovaActive() { return !!this.sn; }
  /** advance n frames of dt (screenshots) */
  step(n: number, dt = 1 / 60) { for (let i = 0; i < n; i++) this.frame(dt); }

  /* ---------------- frame ---------------- */
  private frame(dt: number) {
    const inp = this.inp; if (!inp) return;
    const { W, H } = this, ctx = this.ctx;
    this.t += dt;
    const sn = this.sn; let sdt = dt;
    if (sn) { sn.t += dt; if (sn.t < SN_FLASH) sdt = dt * 0.25; if (!sn.done && sn.t > 3.2) { sn.done = true; this.onSupernovaCard?.(); } if (sn.t > SN_LIFE + 1.5) this.sn = null; }
    const pos = inp.pos, side = pos?.side || "long", dive = side === "short" && !!pos;
    const lev = pos ? pos.lev : inp.lev, j = jetOf(lev) * (pos ? 1 : 0.35), heat = pos && !pos.pending ? inp.heat : 0;
    // price → screen mapping: the wipeout line sits 30% of the playfield from entry
    const top = inp.topPad, bot = H - inp.bottomPad, field = Math.max(120, bot - top);
    if (pos && pos.entry > 0 && pos.liq > 0) { this.ref = pos.entry; this.scale = (field * 0.30) / Math.abs(pos.entry - pos.liq); }
    else { this.ref = inp.price; this.scale = (field * 0.3) / (inp.price * 0.001); }
    const wy = (p: number) => -(p - this.ref) * this.scale;   // world y (up = negative)
    const rocketW = wy(inp.price);
    // camera: entry at 45% of the field (long) / 55% (dive); follow when the rocket leaves the comfort band
    const anchor = top + field * (dive ? 0.42 : 0.55);
    let target = this.camY; const sy = rocketW - this.camY + anchor, lo = top + field * 0.22, hi = top + field * 0.78;
    if (!pos) target = rocketW; else if (sy < lo) target = rocketW + anchor - lo; else if (sy > hi) target = rocketW + anchor - hi;
    if (!pos) target = rocketW;
    if (pos && Math.abs(this.camY - target) > field * 3) this.camY = target;
    this.camY = lerp(this.camY, target, ease(pos ? 3 : 8, dt));
    const toY = (w: number) => w - this.camY + anchor;
    const prevY = this.ry;
    this.ry = lerp(this.ry || toY(rocketW), toY(rocketW), ease(14, dt)); this.rx = W * inp.xFrac;
    const vy = (this.ry - prevY) / Math.max(1e-3, dt);
    // airspeed: baseline from leverage (Turbo) + vertical motion; dive scrolls the other way
    const air = (pos && !pos.pending ? 120 + 2600 * j * j : pos ? 220 : 40) * (sn ? Math.max(0, 1 - sn.t / 0.6) : 1);
    this.scroll += air * sdt;
    this.ign = Math.max(0, this.ign - dt * 0.9);
    if (pos?.pending && !this.wasPending) this.ign = 1; this.wasPending = !!pos?.pending;
    // sky plate from PnL milestones (+0 → OUTER SPACE, every +50% of the bet one tier up; losses sink)
    const plate = clamp(4 + Math.floor((inp.roiPct || 0) / 50), 1, 17);
    if (plate !== this.plate) { this.plateFrom = this.plate; this.plate = plate; this.plateT = 0; }
    this.plateT = Math.min(1, this.plateT + dt / 0.8);
    this.scorch = sn && sn.t > SN_FLASH ? 1 : Math.max(0, this.scorch - dt / 9);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawSky(j, dive, heat);
    this.drawSpeed(j, dive, air, sdt, vy);
    // lines
    if (pos && pos.entry > 0) {
      this.line(toY(wy(pos.entry)), "rgba(214,222,245,.38)", `${T.entryLine} ${inp.fmtPrice(pos.entry)}`, false, [8, 8]);
      if (pos.tp) this.line(toY(wy(pos.tp)), "rgba(95,240,160,.55)", `TP ${inp.fmtPrice(pos.tp)}`, false, [3, 7]);
      if (pos.sl) this.line(toY(wy(pos.sl)), "rgba(255,214,120,.6)", `SL ${inp.fmtPrice(pos.sl)}`, false, [3, 7]);
      if (pos.liq > 0 && !sn) this.wipeLine(toY(wy(pos.liq)), `${T.wipeoutLine} ${inp.fmtPrice(pos.liq)}`, heat, top, bot);
    }
    const hideRocket = !!sn && sn.t > SN_FLASH;
    if (!hideRocket) {
      this.trailStep(dt, air, dive);
      this.drawTrail(j, dive);
      this.drawRocket(dt, sdt, j, dive, heat, !!pos?.pending, !!pos);
    } else this.trail.length = 0;
    this.drawFx(sdt);
    if (sn) this.drawSupernova(sn);
    this.drawHeatOverlay(heat);
  }

  /* ---------------- layers ---------------- */
  private drawSky(j: number, dive: boolean, heat: number) {
    const { ctx, W, H } = this;
    const cover = (im: HTMLImageElement, a: number, par: number) => {
      if (!im?.complete || !im.naturalWidth || a <= 0) return;
      const s = Math.max(W / im.naturalWidth, (H * 1.15) / im.naturalHeight), w = im.naturalWidth * s, h = im.naturalHeight * s;
      ctx.globalAlpha = a; ctx.drawImage(im, (W - w) / 2, (H - h) / 2 + par, w, h); ctx.globalAlpha = 1;
    };
    ctx.fillStyle = "#070814"; ctx.fillRect(0, 0, W, H);
    const par = Math.sin(this.scroll * 0.00035) * H * 0.05;
    cover(this.img[`tier${this.plateFrom}`], 1 - this.plateT, par); cover(this.img[`tier${this.plate}`], this.plateT, par);
    // grade down (liminal haze) so the HUD reads; dive runs cooler/darker
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `rgba(6,7,20,${dive ? 0.62 : 0.5})`); g.addColorStop(1, `rgba(6,7,20,${dive ? 0.45 : 0.3})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // stars streak with airspeed
    ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
    for (const s of this.stars) {
      const yy = (((s.y * H + (dive ? -1 : 1) * this.scroll * 0.06 * s.z) % H) + H) % H, len = 1 + j * j * 60 * s.z;
      ctx.strokeStyle = `rgba(230,236,255,${0.25 + 0.4 * s.z})`; ctx.lineWidth = 0.6 + s.z;
      ctx.beginPath(); ctx.moveTo(s.x * W, yy); ctx.lineTo(s.x * W, yy - (dive ? -len : len)); ctx.stroke();
    }
    ctx.restore();
    if (this.scorch > 0) { ctx.fillStyle = `rgba(60,14,6,${0.55 * this.scorch})`; ctx.fillRect(0, 0, W, H);
      const rg = ctx.createRadialGradient(W / 2, H * 0.6, 0, W / 2, H * 0.6, H); rg.addColorStop(0, `rgba(255,120,40,${0.18 * this.scorch})`); rg.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H); }
    if (heat > 0.5) { ctx.fillStyle = `rgba(255,70,30,${(heat - 0.5) * 0.18})`; ctx.fillRect(0, 0, W, H); }
  }
  private drawSpeed(j: number, dive: boolean, air: number, dt: number, vy: number) {
    const { ctx, W, H } = this, cap = Math.round(6 + 90 * j * j);
    const rate = (4 + 160 * j * j) * dt;
    for (let n = Math.floor(rate + Math.random()); n > 0 && this.bits.length < cap; n--)
      this.bits.push({ x: Math.random() * W, y: dive ? H + 20 : -20 + Math.random() * H * 0.2, vx: 0, vy: 0, life: 1, max: 1, r: 0.8 + Math.random() * 1.6, k: 0.6 + Math.random() * 0.8, c: "" });
    const v = (air * 1.4 + Math.abs(vy) * 0.6) * (dive ? -1 : 1), L = 20 + 420 * j * j;
    ctx.save(); ctx.lineCap = "round"; ctx.globalCompositeOperation = "lighter";
    for (const b of this.bits) {
      b.y += v * dt * b.k; b.life -= dt * 0.7;
      ctx.globalAlpha = clamp(b.life, 0, 1) * (0.25 + 0.45 * j); ctx.strokeStyle = dive ? "rgba(255,200,225,.9)" : "rgba(225,235,255,.9)"; ctx.lineWidth = b.r;
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x, b.y - Math.sign(v) * L * b.k); ctx.stroke();
    }
    ctx.restore(); ctx.globalAlpha = 1;
    this.bits = this.bits.filter((b) => b.life > 0 && b.y > -L - 40 && b.y < H + L + 40);
    // 1000×: radial "FOV pull" streaks from the vanishing point
    if (j > 0.85) { const a = (j - 0.85) / 0.15; ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.strokeStyle = `rgba(220,230,255,${0.16 * a})`; ctx.lineWidth = 1.2;
      const cx = this.rx, cy = dive ? H * 1.1 : -H * 0.1;
      for (let i = 0; i < 26; i++) { const ang = (i / 26) * Math.PI * 2 + this.t * 0.4, r0 = 0.35 * Math.max(W, H) + ((this.t * 900 + i * 97) % (0.5 * H)), r1 = r0 + 60 + 120 * a;
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0); ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1); ctx.stroke(); }
      ctx.restore(); }
  }
  private line(y: number, c: string, label: string, bold: boolean, dash: number[]) {
    const { ctx, W } = this; if (y < -20 || y > this.H + 20) return;
    ctx.save(); ctx.strokeStyle = c; ctx.setLineDash(dash); ctx.lineWidth = bold ? 2 : 1.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = c; ctx.font = "bold 11px ui-monospace,Menlo,monospace"; ctx.fillText(label, 12, y - 6); ctx.restore();
  }
  private wipeLine(y: number, label: string, heat: number, top: number, bot: number) {
    const { ctx, W } = this, pulse = 0.65 + 0.35 * Math.sin(this.t * (6 + heat * 14));
    const on = y >= top - 4 && y <= bot + 4, yy = clamp(y, top + 18, bot - 6);
    ctx.save();
    if (on) {
      const g = ctx.createLinearGradient(0, y - 26, 0, y + 26); g.addColorStop(0, "rgba(255,40,80,0)"); g.addColorStop(0.5, `rgba(255,40,80,${0.25 + 0.35 * heat})`); g.addColorStop(1, "rgba(255,40,80,0)");
      ctx.fillStyle = g; ctx.fillRect(0, y - 26, W, 52);
      ctx.globalCompositeOperation = "lighter"; ctx.strokeStyle = `rgba(255,60,90,${0.55 + 0.45 * pulse})`; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.strokeStyle = `rgba(255,160,180,${0.4 * pulse})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.font = "800 12px ui-monospace,Menlo,monospace"; const tw = ctx.measureText(label).width + (on ? 0 : 14);
    const fieldR = Math.min(W, 2 * W * (this.inp?.xFrac ?? 0.5)), x = fieldR - tw - 26, ly = on ? y - 10 : yy;
    ctx.fillStyle = "rgba(40,4,14,.82)"; ctx.beginPath(); ctx.roundRect(x - 8, ly - 13, tw + 16, 20, 8); ctx.fill();
    ctx.strokeStyle = "rgba(255,61,127,.7)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = "#FF8FB0"; ctx.fillText((on ? "" : y < top ? "▲ " : "▼ ") + label, x, ly + 1);
    ctx.restore();
  }
  private trailStep(dt: number, air: number, dive: boolean) {
    const s = air * dt * (dive ? -1 : 1);
    for (const p of this.trail) p.y += s;   // the world rushes past
    this.trail.push({ x: this.rx, y: this.ry });
    if (this.trail.length > 90) this.trail.shift();
  }
  private drawTrail(j: number, dive: boolean) {
    const { ctx } = this, n = this.trail.length; if (n < 2) return;
    ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
    const wMul = 0.7 + 1.6 * j;
    for (let i = 1; i < n; i++) { const u = i / (n - 1); ctx.strokeStyle = `rgba(236,238,255,${Math.pow(u, 0.9) * (0.18 + 0.3 * j)})`; ctx.lineWidth = (5 + 22 * Math.pow(1 - u, 0.8)) * wMul;
      ctx.beginPath(); ctx.moveTo(this.trail[i - 1].x, this.trail[i - 1].y); ctx.lineTo(this.trail[i].x, this.trail[i].y); ctx.stroke(); }
    ctx.globalCompositeOperation = "lighter"; const hot = Math.max(2, Math.round(n * (0.12 + 0.3 * j)));
    for (let i = Math.max(1, n - hot); i < n; i++) { const u = (i - (n - hot)) / hot;
      ctx.strokeStyle = dive ? `rgba(255,${Math.round(120 + 60 * u)},${Math.round(170 + 50 * u)},${(0.15 + 0.55 * u) * (0.5 + 0.5 * j)})` : `rgba(255,${Math.round(200 + 40 * u)},${Math.round(150 + 80 * u)},${(0.15 + 0.55 * u) * (0.5 + 0.5 * j)})`;
      ctx.lineWidth = (2 + 9 * u) * (0.8 + j); ctx.beginPath(); ctx.moveTo(this.trail[i - 1].x, this.trail[i - 1].y); ctx.lineTo(this.trail[i].x, this.trail[i].y); ctx.stroke(); }
    ctx.restore();
    void dive;
  }
  private glow(x: number, y: number, r: number, inner: string, outer = "rgba(0,0,0,0)") {
    const { ctx } = this; if (r <= 0.5) return; const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, inner); g.addColorStop(1, outer); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
  }
  private drawRocket(dt: number, sdt: number, j: number, dive: boolean, heat: number, pending: boolean, active: boolean) {
    const { ctx } = this, im = this.img.rocket, h = this.H < 700 ? 118 : 150, w = im.naturalWidth ? (h * im.naturalWidth) / im.naturalHeight : 55;
    // rocket-only shake (camera never moves): shudder > 80% heat, violent > 95%
    const sh = heat > 0.8 ? ((heat - 0.8) / 0.2) * (heat > 0.95 ? 7 : 4) : 0;
    const jx = sh * (Math.random() * 2 - 1), jy = sh * (Math.random() * 2 - 1), jr = sh * 0.006 * (Math.random() * 2 - 1);
    const x = this.rx + jx, y = this.ry + jy, ang = (dive ? Math.PI : 0) + jr + Math.sin(this.t * 1.7) * 0.02;
    // flame: length from leverage; spool while pending; sputter at > 95% heat
    const flick = 0.74 + 0.26 * Math.abs(Math.sin(this.t * 37)) * Math.abs(Math.sin(this.t * 17.3 + 1.7));
    const sput = heat > 0.95 ? (Math.sin(this.t * 29) * Math.sin(this.t * 13.7 + 0.6) > 0.1 ? 0.25 : 1) : 1;
    const spool = pending ? 0.55 + 0.45 * Math.abs(Math.sin(this.t * 9)) : 1;
    const flame = (active ? 0.35 + 1.05 * j : 0.22) * flick * sput * spool + 0.6 * this.ign;
    // exhaust particles (sim-step rate)
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const rate = (8 + 150 * j * j) * (active ? 1 : 0.4) * sput * sdt * 6;
    for (let n = Math.floor(rate + Math.random()); n > 0; n--) {
      const sp = 140 + Math.random() * (280 + 900 * j) * flame, jj = (Math.random() - 0.5) * 50;
      this.parts.push({ x: x + (Math.random() - 0.5) * 8, y, vx: -sa * -sp + ca * jj, vy: ca * sp + sa * jj, life: 0.5 + Math.random() * 0.4, max: 0.9, r: (5 + Math.random() * 12 * flame), k: Math.random() < 0.5 ? 1 : 0, c: "" });
    }
    if (this.parts.length > 600) this.parts.splice(0, this.parts.length - 600);
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    for (const p of this.parts) { p.life -= sdt * 1.8; p.x += p.vx * sdt; p.y += p.vy * sdt; if (p.life <= 0) continue;
      const a = clamp(p.life, 0, 1) * 0.3, s = p.r * (1.3 - p.life * 0.3);
      this.glow(p.x, p.y, s, p.k ? `rgba(255,190,110,${a})` : `rgba(160,190,255,${a * 0.8})`); }
    this.parts = this.parts.filter((p) => p.life > 0);
    // flame cone along the engine axis (opposite the nose)
    ctx.translate(x, y); ctx.rotate(ang);
    const L = (34 + 120 * flame + 260 * j * j * (active ? 1 : 0)) * (0.85 + 0.3 * flick), Wf = 20 + 12 * flame + 10 * j;
    const fg = ctx.createLinearGradient(0, 0, 0, L); fg.addColorStop(0, `rgba(255,240,200,${clamp(0.6 + 0.35 * flame, 0, 0.95)})`); fg.addColorStop(0.35, dive ? "rgba(255,90,150,.55)" : "rgba(255,150,60,.55)"); fg.addColorStop(1, "rgba(255,80,40,0)");
    ctx.fillStyle = fg; ctx.beginPath(); ctx.moveTo(-Wf / 2, 0); ctx.quadraticCurveTo(-Wf * 0.35, L * 0.5, 0, L); ctx.quadraticCurveTo(Wf * 0.35, L * 0.5, Wf / 2, 0); ctx.fill();
    const cg = ctx.createLinearGradient(0, 0, 0, L * 0.55); cg.addColorStop(0, "rgba(255,255,255,.95)"); cg.addColorStop(1, "rgba(200,230,255,0)");
    ctx.fillStyle = cg; ctx.beginPath(); ctx.moveTo(-Wf * 0.22, 0); ctx.quadraticCurveTo(0, L * 0.3, 0, L * 0.55); ctx.quadraticCurveTo(0, L * 0.3, Wf * 0.22, 0); ctx.fill();
    if (flame > 0.75) for (let k = 1; k <= 3; k++) this.glow(0, L * 0.16 * k, Wf * 0.3 * (1 - k * 0.18), `rgba(255,250,235,${clamp((flame - 0.75) * 1.2, 0, 0.6)})`);
    ctx.rotate(-ang); ctx.translate(-x, -y);
    this.glow(x, y, Math.min(110, 40 + 50 * flame), `rgba(255,220,170,${clamp(0.5 * flame * flick, 0, 0.9)})`);
    // heat-shimmer streaks at 1000×
    if (j > 0.9 && active) { ctx.strokeStyle = "rgba(255,230,200,.14)"; ctx.lineWidth = 2;
      for (let k = 0; k < 6; k++) { const yy = y + ca * (40 + k * 34), wv = Math.sin(this.t * 22 + k) * 6; ctx.beginPath(); ctx.moveTo(x - 22 + wv, yy); ctx.quadraticCurveTo(x, yy + 8 * ca, x + 22 - wv, yy); ctx.stroke(); } }
    ctx.restore();
    // motion-blur ghosts at high leverage
    if (im.complete && im.naturalWidth) {
      if (j > 0.6 && active) for (let k = 2; k >= 1; k--) { ctx.save(); ctx.globalAlpha = 0.12 * ((j - 0.6) / 0.4) / k; ctx.translate(x, y + (dive ? -1 : 1) * 10 * k * j); ctx.rotate(ang); ctx.drawImage(im, -w / 2, -h * 0.96, w, h); ctx.restore(); }
      const oc = this.rocketCanvas(Math.ceil(w), Math.ceil(h), heat, this.sn ? clamp(this.sn.t / 0.35, 0, 1) : 0);
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      ctx.shadowColor = heat > 0.5 ? `rgba(255,${Math.round(160 - 120 * heat)},80,.9)` : "rgba(200,220,255,.7)"; ctx.shadowBlur = 18 + 30 * heat;
      ctx.drawImage(oc, -w / 2, -h * 0.96, w, h); ctx.restore();
    }
    void dt;
  }
  private rocketCanvas(ow: number, oh: number, heat: number, white: number) {
    const c = (this as unknown as { _rc?: HTMLCanvasElement })._rc || ((this as unknown as { _rc?: HTMLCanvasElement })._rc = document.createElement("canvas"));
    if (c.width !== ow || c.height !== oh) { c.width = ow; c.height = oh; }
    const o = c.getContext("2d")!; o.globalCompositeOperation = "copy"; o.drawImage(this.img.rocket, 0, 0, ow, oh); o.globalCompositeOperation = "source-atop";
    const gx = ow / 2 + Math.sin(this.t * 0.8) * ow * 0.28, gg = o.createLinearGradient(gx - 14, oh * 0.08, gx + 14, oh * 0.9);
    gg.addColorStop(0, "rgba(255,255,255,0)"); gg.addColorStop(0.45, "rgba(255,252,240,.14)"); gg.addColorStop(1, "rgba(255,255,255,0)"); o.fillStyle = gg; o.fillRect(0, 0, ow, oh);
    const wg = o.createLinearGradient(0, oh, 0, oh * 0.5); wg.addColorStop(0, "rgba(255,170,90,.4)"); wg.addColorStop(1, "rgba(255,170,90,0)"); o.fillStyle = wg; o.fillRect(0, 0, ow, oh);
    if (heat > 0.5) { const a = (heat - 0.5) / 0.5, hg = o.createLinearGradient(0, oh, 0, 0); hg.addColorStop(0, `rgba(255,${Math.round(110 - 70 * a)},40,${0.35 + 0.4 * a})`); hg.addColorStop(1, `rgba(255,140,60,${0.12 + 0.35 * a})`);
      o.fillStyle = hg; o.fillRect(0, 0, ow, oh * (0.55 + 0.45 * a) + Math.sin(this.t * 20) * 2 + 0 * oh); }
    if (white > 0) { o.fillStyle = `rgba(255,255,245,${0.9 * white})`; o.fillRect(0, 0, ow, oh); }
    return c;
  }
  private drawFx(dt: number) {
    const { ctx } = this; if (!this.fx.length) return;
    ctx.save();
    for (const p of this.fx) { p.life -= dt; const d = Math.exp(-dt * (p.k || 0)); p.vx *= d; p.vy *= d; p.vy += (p.g || 0) * dt; p.x += p.vx * dt; p.y += p.vy * dt; if (p.life <= 0) continue;
      const a = clamp(p.life / p.max, 0, 1);
      if (p.c.startsWith("s:")) { ctx.globalCompositeOperation = "source-over"; this.glow(p.x, p.y, p.r * (1.6 - a * 0.6), `rgba(${p.c.slice(2)},${0.5 * a})`); }
      else if (p.c.startsWith("d:")) { ctx.globalCompositeOperation = "source-over"; ctx.fillStyle = `rgba(${p.c.slice(2)},${a})`; ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2); }
      else { ctx.globalCompositeOperation = "lighter"; ctx.strokeStyle = `rgba(${p.c},${a})`; ctx.lineWidth = p.r; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04); ctx.stroke(); } }
    ctx.restore(); this.fx = this.fx.filter((p) => p.life > 0);
  }
  private burst(x: number, y: number, n: number, spd: number, f: (a: number, v: number) => Partial<P>) {
    for (let i = 0; i < n; i++) { const a = Math.random() * 6.2832, v = spd * (0.3 + Math.random() * 0.7), o = f(a, v);
      this.fx.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, max: 1, r: 2, k: 1.5, c: "255,220,150", ...o } as P); }
  }
  private ring(x: number, y: number, r: number, a: number, w: number, c: string) {
    const { ctx } = this; if (a <= 0) return; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832);
    ctx.strokeStyle = `rgba(${c},${a * 0.28})`; ctx.lineWidth = w * 3.2; ctx.stroke(); ctx.strokeStyle = `rgba(${c},${a})`; ctx.lineWidth = w; ctx.stroke();
  }
  private drawSupernova(sn: NonNullable<TurboScene["sn"]>) {
    const { ctx, W, H } = this, t = sn.t, x = sn.x, y = clamp(sn.y, 60, H - 60);
    ctx.save();
    if (t < SN_FLASH) {
      // white-hot hull glow (0–.35) then implosion: the light is sucked in, the sky darkens toward the point
      const u = t / SN_FLASH;
      if (t > 0.35) { const v = (t - 0.35) / (SN_FLASH - 0.35);
        const dg = ctx.createRadialGradient(x, y, 0, x, y, Math.max(W, H)); dg.addColorStop(0, `rgba(0,0,0,0)`); dg.addColorStop(clamp(0.6 - 0.5 * v, 0.05, 1), `rgba(0,0,8,${0.75 * v})`); dg.addColorStop(1, `rgba(0,0,8,${0.9 * v})`);
        ctx.fillStyle = dg; ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = "lighter";
        for (let i = 0; i < 40; i++) { const a = i * 2.4 + 1.3, r = (1 - v) * (260 + (i % 7) * 60) + 6; ctx.strokeStyle = `rgba(255,250,240,${0.5 * v})`; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); ctx.lineTo(x + Math.cos(a) * (r + 40 * (1 - v)), y + Math.sin(a) * (r + 40 * (1 - v))); ctx.stroke(); }
      }
      ctx.globalCompositeOperation = "lighter"; this.glow(x, y, 30 + 140 * u, `rgba(255,255,250,${0.5 + 0.5 * u})`);
      ctx.restore(); return;
    }
    const s = t - SN_FLASH;
    if (!(sn as unknown as { boomed?: boolean }).boomed) { (sn as unknown as { boomed?: boolean }).boomed = true;
      this.burst(x, y, 160, 1300, () => ({ r: 3, life: 2.6, max: 2.6, k: 1.0, g: 70, c: "255,225,150" }));
      this.burst(x, y, 60, 700, (a) => ({ r: 2.5 + Math.random() * 3, life: 3.5, max: 3.5, k: 0.9, g: 420, vy: -Math.abs(Math.sin(a)) * 600 - 80, c: "d:" + (Math.random() < 0.5 ? "90,70,60" : "255,190,110") }));
      this.burst(x, y, 30, 260, () => ({ r: 34, life: 4.5, max: 4.5, k: 1.2, g: -30, c: "s:70,40,40" })); }
    // embers rain for ~6 s
    if (s < 5.5 && Math.random() < 0.9) this.fx.push({ x: Math.random() * W, y: -10, vx: (Math.random() - 0.5) * 40, vy: 140 + Math.random() * 200, life: 3, max: 3, r: 1.6 + Math.random() * 1.8, k: 0, c: "255,170,90" });
    ctx.globalCompositeOperation = "lighter";
    // two shockwaves that leave the screen (ATOM: 1700 px, one ring)
    this.ring(x, y, 60 + 2600 * (1 - Math.exp(-s * 1.25)), Math.max(0, 1 - s / 2.4), 16, "255,255,240");
    if (s > 0.5) this.ring(x, y, 40 + 2000 * (1 - Math.exp(-(s - 0.5) * 1.1)), Math.max(0, 1 - (s - 0.5) / 2.6) * 0.8, 9, "255,150,190");
    this.ring(x, y + 4, 40 + 520 * (1 - Math.exp(-s * 1.8)), Math.max(0, 1 - s / 2.8) * 0.7, 6, "255,215,140");
    // star-collapse: a white core that collapses to a point, then a hot mushroom
    const core = s < 0.6 ? 220 * (1 - s / 0.6) + 40 : 40 * Math.max(0, 1 - (s - 0.6) / 2);
    this.glow(x, y, core * 2.2, "rgba(255,255,255,.95)", "rgba(255,200,240,0)");
    this.glow(x, y, 120 + 300 * (1 - Math.exp(-s * 3.5)), `rgba(255,190,110,${Math.max(0, 0.8 - s / 2.2)})`);
    // god rays
    const R = 900, g = ctx.createRadialGradient(x, y, 0, x, y, R); g.addColorStop(0, `rgba(255,248,215,${Math.max(0, 0.45 - s / 4)})`); g.addColorStop(1, "rgba(255,230,160,0)"); ctx.fillStyle = g;
    ctx.beginPath(); for (let i = 0; i < 22; i++) { const a = i * 2.39996 + 0.3, w = 0.035 + 0.04 * ((i * 7) % 5) / 5; ctx.moveTo(x, y); ctx.arc(x, y, R, a - w, a + w); ctx.closePath(); } ctx.fill();
    // mushroom (bigger than ATOM's 300 px stem / 180 px cap)
    const grow = 1 - Math.exp(-s * 1.2), fade = clamp((SN_LIFE - s) / 1.8, 0, 1), up = sn.side === "short" ? 1 : -1, H0 = 380 * grow, capR = 80 + 190 * grow, cy = y + up * H0;
    ctx.globalCompositeOperation = "source-over";
    const sg = ctx.createLinearGradient(0, cy, 0, y); sg.addColorStop(0, `rgba(255,200,110,${0.85 * fade})`); sg.addColorStop(0.5, `rgba(180,80,70,${0.75 * fade})`); sg.addColorStop(1, `rgba(90,50,60,${0.6 * fade})`);
    const sw = 22 + 34 * grow; ctx.fillStyle = sg; ctx.beginPath(); ctx.moveTo(x - sw * 1.8, y); ctx.quadraticCurveTo(x - sw * 0.6, (y + cy) / 2, x - sw, cy); ctx.lineTo(x + sw, cy); ctx.quadraticCurveTo(x + sw * 0.6, (y + cy) / 2, x + sw * 1.8, y); ctx.fill();
    for (const p of sn.puffs) { const a = p.a + s * 0.35 * p.s, rx = Math.cos(a) * capR * (0.35 + 0.7 * p.r), ry = Math.sin(a) * capR * 0.42 * (0.4 + 0.6 * p.r) - capR * 0.12 * -up;
      const hot = clamp(1 - p.r * 0.8 - s * 0.16, 0, 1), rr = capR * 0.42 * p.s;
      this.glow(x + rx, cy + ry, rr, `rgba(${Math.round(lerp(120, 255, hot))},${Math.round(lerp(60, 200, hot))},${Math.round(lerp(70, 140, hot))},${0.95 * fade})`, `rgba(60,40,50,0)`); }
    ctx.globalCompositeOperation = "lighter"; this.glow(x, cy, capR * 0.5, `rgba(255,230,200,${0.4 * fade * clamp(1.4 - s * 0.35, 0, 1)})`);
    ctx.restore();
    // white-out (full screen) then fade
    const fl = clamp(1 - s / 1.1, 0, 1); if (fl > 0) { ctx.fillStyle = `rgba(255,255,250,${Math.pow(fl, 1.4)})`; ctx.fillRect(0, 0, W, H); }
    // label pop
    if (s > 0.3 && s < 4.5) { const a = clamp((4.5 - s) / 0.6, 0, 1) * clamp((s - 0.3) / 0.2, 0, 1), pop = s < 0.5 ? 0.6 + 2 * (s - 0.3) : 1;
      ctx.save(); ctx.globalAlpha = a; ctx.translate(W / 2, clamp(y - 170 * -up * 0 - 160, 120, H - 160)); ctx.scale(pop, pop); ctx.textAlign = "center";
      ctx.font = `900 ${W < 500 ? 46 : 88}px system-ui, "Helvetica Neue", Arial, sans-serif`; ctx.lineWidth = 6; ctx.strokeStyle = "rgba(60,0,20,.85)"; ctx.strokeText(T.supernova, 0, 0);
      ctx.shadowColor = "rgba(255,120,170,.9)"; ctx.shadowBlur = 24; ctx.fillStyle = "#FFF6F0"; ctx.fillText(T.supernova, 0, 0); ctx.restore(); }
  }
  private drawHeatOverlay(heat: number) {
    if (heat <= 0.8) return; const { ctx, W, H } = this, a = (heat - 0.8) / 0.2, pulse = 0.6 + 0.4 * Math.sin(this.t * (8 + 10 * a));
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, "rgba(255,0,40,0)"); g.addColorStop(1, `rgba(255,20,60,${(0.25 + 0.35 * a) * pulse})`); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
}
