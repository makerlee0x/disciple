/**
 * LAUNCH PAD as a real 3D world (lee, Nov 12: "rebuild the world … just do one at a time, the launchpad").
 *
 * Existing solution followed: the standard game / three.js way to build an outdoor night level — a distant sky
 * (an infinitely far dome that follows the camera, with the moon on it) plus real mid- and near-field meshes that the
 * camera actually moves through: ground, an instanced city with lit windows, street lights in perspective rows, layered
 * ground-fog decks and exponential distance fog (three's FogExp2), lit by real lights. It is the same layering as a
 * racing game's 3D course (skybox + track-side geometry + fog) and as the official three.js examples it is assembled
 * from: webgl_instancing_performance / webgl_buildings-style InstancedMesh cities, webgl_fog / FogExp2, the
 * webgl_shaders_sky "sky dome follows the camera" set-up, and webgl_postprocessing composites (a scene rendered to a
 * render target and combined in a ShaderPass). Brand's approved Launch Pad painting
 * (disciple-brand/sky/v2/final/sky_t01_launch-pad_16x9_final.jpg) is the colour and mood source — mauve night, a big
 * soft moon high and central, a sea of warm sodium lights in fog to the horizon, and the rooftop pad with its tower in
 * the foreground — not the geometry: every piece here is 3D, so it has parallax, occlusion and light.
 *
 * How it sits in the flight:
 *  - Its own Scene and camera (a copy of the play / review camera every frame, with a far plane for the sky), rendered
 *    into a render target BEHIND the ship layer and composited under it after the ship's post stack (post.ts). The ship
 *    keeps every look decision Brand signed off (env plate on the chrome, ACES, ship-only punch, tight bloom): none of
 *    the world passes through the ship's punch, bloom or tone mapping, and the world is authored in display range
 *    (toneMapped: false), so the painting's colours are not regraded.
 *  - Altitude is the price, as in the 2D plates: the snapshot's band (S.bgU, the tip's altitude) lifts the camera
 *    above the city (the world group moves down). Near things drop away fast, the horizon and the moon stay — real
 *    parallax. Near the top of Launch Pad (band 0.82 → 1.02) the world fades out and the engine's 2D plate stack shows
 *    again (Ozone and up keep the current plate world).
 *  - Built only from built-in three materials (Basic / Lambert, instancing, FogExp2) so the same code runs on
 *    WebGPURenderer and WebGLRenderer. No new dependency. Built incrementally (a few ms per frame) and its shaders are
 *    compiled with compileAsync before it shows, so starting it never blocks a frame (or a Boost).
 *  - Only WATCHES the snapshot. Nothing here feeds the engine, a price or a trade.
 *  - No brand gold in the scene (city lights are sodium / warm white as in the painting; #F2C14E is not used).
 */
import {
  Scene, Group, Mesh, InstancedMesh, PlaneGeometry, BoxGeometry, SphereGeometry, MeshBasicMaterial, MeshLambertMaterial,
  FogExp2, HemisphereLight, DirectionalLight, PointLight, Color, Object3D, CanvasTexture, SRGBColorSpace, RepeatWrapping,
  BackSide, PerspectiveCamera, Vector3, InstancedBufferAttribute, type Texture, type Material,
} from "three";
import { lightBlend } from "./particles";
import { noise2 } from "./textures";

/** layout in flight-plane px at H = 800 (the whole world group is scaled by H / 800, like the camera distance) */
export const LP3D = {
  /** camera eye above the city ground at the launch price (band 0) */
  H0: 1500,
  /** extra height at the top of Launch Pad (band 1): lift = LIFT · band² (slow off the pad, then away) */
  LIFT: 3800,
  /** the launch roof under the ship: top surface height (eye = 0), depth span (behind the flight plane), half width */
  ROOF_Y: -135, ROOF_Z0: -170, ROOF_Z1: -560, ROOF_HX: 270,
  /** the launch gantry on the roof, behind the ship's lane */
  TOWER_Z: -470, TOWER_H: 62,
  /** haze: colour of the painting's horizon band (between its bright centre #8b7da1 and darker sides #45415c) */
  FOG: 0x6a5f84, FOG_D: 5.0e-5,
  /** the moon: same place in the frame as the painting (centre, ~23% from the top at the play camera's 55° fov) */
  MOON_EL: 16.5, MOON_R: 5.2, SKY_R: 100000,
  /** world → plate hand-over near the top of the tier */
  FADE: [0.82, 1.02] as [number, number],
  /** lateral parallax with the ship's lane (the 2D plate moves 3%) */
  LANE_K: 0.12,
};

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** how much of the 3D Launch Pad world shows at this altitude band (1 = all of it, 0 = the 2D plate) */
export const lp3dAmount = (band: number) => (Number.isFinite(band) ? 1 - smooth(LP3D.FADE[0], LP3D.FADE[1], band) : 0);
/** camera lift above the launch height, in world px (H = 800) */
export const lp3dLift = (band: number) => { const b = clamp(Number.isFinite(band) ? band : 0, 0, 1.15); return LP3D.LIFT * b * b; };

function rng(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const cnv = (w: number, h: number) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const ctex = (c: HTMLCanvasElement) => { const t = new CanvasTexture(c); t.colorSpace = SRGBColorSpace; t.needsUpdate = true; return t; };
const hex = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mix3 = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** sky by elevation (deg), sampled from the approved painting's columns (sides → centre) */
const SKY_STOPS: [number, string][] = [[-90, "#5f5579"], [0, "#6a5f84"], [2.5, "#776a92"], [7, "#5d5683"], [16, "#45456c"], [30, "#34375d"], [55, "#272a4b"], [90, "#1c1f3b"]];
function skyAt(e: number) { let i = 0; while (i < SKY_STOPS.length - 2 && e > SKY_STOPS[i + 1][0]) i++; const [e0, c0] = SKY_STOPS[i], [e1, c1] = SKY_STOPS[i + 1]; return mix3(hex(c0), hex(c1), clamp((e - e0) / (e1 - e0), 0, 1)); }

function windowTex(seed: number) {
  const W = 64, H = 128, c = cnv(W, H), g = c.getContext("2d")!, r = rng(seed);
  g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
  for (let y = 6; y < H - 6; y += 8) for (let x = 4; x < W - 4; x += 7) {
    const on = r(); if (on > 0.34) continue;
    const warm = r(), b = 0.45 + r() * 0.55;
    const col = warm < 0.78 ? [255, 176 + r() * 40, 96 + r() * 50] : [235, 225, 210];
    g.fillStyle = `rgb(${(col[0] * b) | 0},${(col[1] * b) | 0},${(col[2] * b) | 0})`; g.fillRect(x, y, 4, 4);
  }
  g.fillStyle = "#000"; g.fillRect(0, H - 4, 4, 4);   // a dark texel the box tops are pointed at (no windows on roofs)
  return ctex(c);
}
function dotTex(size = 64) {
  const c = cnv(size, size), g = c.getContext("2d")!, r = size / 2, gr = g.createRadialGradient(r, r, 0, r, r, r);
  gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.18, "rgba(255,255,255,0.75)"); gr.addColorStop(0.45, "rgba(255,255,255,0.16)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, size, size); return ctex(c);
}
function glowTex(size = 128) {
  const c = cnv(size, size), g = c.getContext("2d")!, r = size / 2, gr = g.createRadialGradient(r, r, 0, r, r, r);
  gr.addColorStop(0, "rgba(255,255,255,0.9)"); gr.addColorStop(0.35, "rgba(255,255,255,0.3)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, size, size); return ctex(c);
}
function moonTex(size = 256) {
  const c = cnv(size, size), g = c.getContext("2d")!, r = size / 2, img = g.createImageData(size, size), d = img.data, nz = noise2(91);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x + 0.5 - r) / r, dy = (y + 0.5 - r) / r, q = Math.hypot(dx, dy), i = (y * size + x) * 4;
    const limb = 1 - smooth(0.86, 1.0, q), mott = 0.94 + 0.06 * nz(x / 22, y / 22, 3), sh = 1 - 0.06 * smooth(0.2, 1, q);
    d[i] = 246 * mott * sh; d[i + 1] = 238 * mott * sh; d[i + 2] = 222 * mott * sh; d[i + 3] = 255 * limb;
  }
  g.putImageData(img, 0, 0); return ctex(c);
}
function fogTex(seed: number, size = 128) {
  const c = cnv(size, size), g = c.getContext("2d")!, img = g.createImageData(size, size), d = img.data, nz = noise2(seed);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // tileable: blend the four wrapped samples
    const u = x / size, v = y / size, f = (a: number, b: number) => nz(a * 6, b * 6, 4);
    const n = f(u, v) * (1 - u) * (1 - v) + f(u + 1, v) * u * (1 - v) + f(u, v + 1) * (1 - u) * v + f(u + 1, v + 1) * u * v;
    const a = smooth(0.38, 0.78, n), i = (y * size + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = 255 * a;
  }
  g.putImageData(img, 0, 0); const t = ctex(c); t.wrapS = t.wrapT = RepeatWrapping; return t;
}

type Job = () => boolean;   // true = done

export class LaunchPadWorld {
  scene = new Scene();
  camera = new PerspectiveCamera(55, 16 / 9, 20, LP3D.SKY_R * 1.6);
  /** ground-anchored world: moves down as the ship climbs (= the camera rising) */
  root = new Group();
  /** sky dome + moon: infinitely far, follows the camera */
  far = new Group();
  /** 0..1 shown (fade with altitude × built and compiled) */
  amount = 0;
  ready = false;
  private jobs: Job[] = [];
  private flame = new PointLight(0xffa860, 0, 900, 1);
  private floods: PointLight[] = [];
  private decks: { tex: Texture; sp: number }[] = [];
  private skyC: HTMLCanvasElement; private skyT: Texture; private skyRow = 0;
  private v = new Vector3();
  private tmp = new Object3D();
  private compiling = false;

  constructor(public lite: boolean, private compile?: (s: Scene, c: PerspectiveCamera) => Promise<unknown>) {
    const S = this.scene, P = LP3D, r = rng(7);
    S.fog = new FogExp2(P.FOG, P.FOG_D);
    S.add(this.far, this.root);
    // lights: the painting's moon, the sky / city bounce, the roof's sodium floods, and the ship's own flame
    const hemi = new HemisphereLight(0x55507e, 0x1a1426, 0.75);
    const moon = new DirectionalLight(0xfff3e6, 0.9);
    moon.position.set(0, Math.sin((P.MOON_EL * Math.PI) / 180), -Math.cos((P.MOON_EL * Math.PI) / 180)).multiplyScalar(4000);
    S.add(hemi, moon, moon.target);
    for (const x of [-1, 1]) { const f = new PointLight(0xffb35c, 0, 520, 1); f.position.set(x * (P.ROOF_HX - 20), P.ROOF_Y + 8, P.ROOF_Z0 - 10); this.floods.push(f); this.root.add(f); }
    this.root.add(this.flame);

    // ---- sky dome (texture filled a few rows per frame) + moon
    this.skyC = cnv(lite ? 512 : 1024, lite ? 256 : 512);
    this.skyT = ctex(this.skyC);
    const dome = new Mesh(new SphereGeometry(P.SKY_R, lite ? 40 : 64, lite ? 20 : 32), new MeshBasicMaterial({ map: this.skyT, side: BackSide, fog: false, depthWrite: false, toneMapped: false }));
    dome.renderOrder = -100; this.far.add(dome);
    const mEl = (P.MOON_EL * Math.PI) / 180, mD = P.SKY_R * 0.8, mR = mD * Math.tan((P.MOON_R * Math.PI) / 180);
    const moonM = new Mesh(new PlaneGeometry(2 * mR, 2 * mR), new MeshBasicMaterial({ map: moonTex(), transparent: true, fog: false, depthWrite: false, toneMapped: false }));
    moonM.position.set(0, Math.sin(mEl) * mD, -Math.cos(mEl) * mD); moonM.lookAt(0, 0, 0); moonM.renderOrder = -99; this.far.add(moonM);
    this.jobs.push(() => this.skyRows(lite ? 48 : 40));

    // ---- ground
    const ground = new Mesh(new PlaneGeometry(400000, 400000), new MeshLambertMaterial({ color: 0x17152a, toneMapped: false }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(0, -P.H0, -150000); this.root.add(ground);

    // ---- the launch building under the ship: roof slab, body with lit floors, railing, gantry, edge lamps
    const concrete = new MeshLambertMaterial({ color: 0x4a4462, toneMapped: false });
    const steel = new MeshLambertMaterial({ color: 0x2e2a44, toneMapped: false });
    const depth = P.ROOF_Z0 - P.ROOF_Z1, zc = (P.ROOF_Z0 + P.ROOF_Z1) / 2;
    const slab = new Mesh(new BoxGeometry(2 * P.ROOF_HX, 14, depth), concrete); slab.position.set(0, P.ROOF_Y - 7, zc); this.root.add(slab);
    const bodyH = P.H0 + P.ROOF_Y - 14;
    const winB = windowTex(3); winB.wrapS = winB.wrapT = RepeatWrapping; winB.repeat.set(4, bodyH / 170);
    const body = new Mesh(new BoxGeometry(2 * P.ROOF_HX - 24, bodyH, depth - 20),
      new MeshLambertMaterial({ color: 0x211e33, emissive: 0xffffff, emissiveMap: winB, emissiveIntensity: 0.85, toneMapped: false }));
    body.position.set(0, P.ROOF_Y - 14 - bodyH / 2, zc); this.root.add(body);
    const parts: [number, number, number, number, number, number, number?][] = [];   // x y z sx sy sz rotZ
    const railY = P.ROOF_Y + 12;
    for (let x = -P.ROOF_HX + 6; x <= P.ROOF_HX - 6; x += 36) parts.push([x, railY, P.ROOF_Z0 + 4, 3, 24, 3]);
    for (const s of [-1, 1]) for (let z = P.ROOF_Z0 - 30; z > P.ROOF_Z1; z -= 40) parts.push([s * (P.ROOF_HX - 4), railY, z, 3, 24, 3]);
    parts.push([0, railY + 12, P.ROOF_Z0 + 4, 2 * P.ROOF_HX - 8, 3, 3], [0, railY + 2, P.ROOF_Z0 + 4, 2 * P.ROOF_HX - 8, 2, 2]);
    for (const s of [-1, 1]) parts.push([s * (P.ROOF_HX - 4), railY + 12, zc, 3, 3, depth - 8]);
    // gantry: 4 legs, rings every 12, X-braces on the front face, a short mast
    const tw = 34, th = P.TOWER_H, ty0 = P.ROOF_Y;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push([sx * tw / 2, ty0 + th / 2, P.TOWER_Z + sz * tw / 2, 3, th, 3]);
    for (let y = ty0 + 10; y <= ty0 + th; y += 12) { parts.push([0, y, P.TOWER_Z + tw / 2, tw, 2, 2], [0, y, P.TOWER_Z - tw / 2, tw, 2, 2]);
      for (const sx of [-1, 1]) parts.push([sx * tw / 2, y, P.TOWER_Z, 2, 2, tw]); }
    const dg = Math.hypot(tw, 12), ang = Math.atan2(12, tw);
    for (let y = ty0 + 16; y < ty0 + th; y += 12) for (const s of [-1, 1]) parts.push([0, y, P.TOWER_Z + tw / 2 + 1, dg, 1.6, 1.6, s * ang]);
    parts.push([0, ty0 + th + 14, P.TOWER_Z, 2.5, 28, 2.5]);
    const pm = new InstancedMesh(new BoxGeometry(1, 1, 1), steel, parts.length);
    parts.forEach(([x, y, z, sx, sy, sz, rz], i) => { this.tmp.position.set(x, y, z); this.tmp.rotation.set(0, 0, rz || 0); this.tmp.scale.set(sx, sy, sz); this.tmp.updateMatrix(); pm.setMatrixAt(i, this.tmp.matrix); });
    this.root.add(pm);
    const dot = dotTex(), glow = glowTex();
    const lampPos: [number, number, number, number][] = [];   // x y z size
    for (let x = -P.ROOF_HX + 6; x <= P.ROOF_HX - 6; x += 72) lampPos.push([x, railY + 14, P.ROOF_Z0 + 6, 7]);
    lampPos.push([0, ty0 + th + 29, P.TOWER_Z, 9]);
    const lamps = this.quads(lampPos.length, dot, false);
    lampPos.forEach(([x, y, z, s], i) => this.setQuad(lamps, i, x, y, z, s, 1.0, 0.82, 0.55));
    this.root.add(lamps);

    // ---- the city below (instanced boxes with lit windows), street lights in rows, sodium pools, fog decks
    this.jobs.push(() => { this.city(r); return true; });
    this.jobs.push(() => { this.lights(r, dot, glow); return true; });
    this.jobs.push(() => { this.fogDecks(); return true; });
  }

  private quads(n: number, map: Texture, normal: boolean) {
    const m = new MeshBasicMaterial({ map, transparent: true, depthWrite: false, fog: false, toneMapped: false });
    if (!normal) lightBlend(m);
    const q = new InstancedMesh(new PlaneGeometry(1, 1), m, n);
    q.instanceColor = new InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
    q.frustumCulled = false; q.renderOrder = 5;
    return q;
  }
  private setQuad(q: InstancedMesh, i: number, x: number, y: number, z: number, s: number, cr: number, cg: number, cb: number) {
    this.tmp.position.set(x, y, z); this.tmp.rotation.set(0, 0, 0); this.tmp.scale.set(s, s, 1); this.tmp.updateMatrix();
    q.setMatrixAt(i, this.tmp.matrix); q.instanceColor!.setXYZ(i, cr, cg, cb);
  }
  /** distance fog for additive lights (fog would ADD haze colour to a light): fade them to black by the same law */
  private att(d: number) { const k = LP3D.FOG_D * d; return Math.exp(-k * k); }

  private city(r: () => number) {
    const P = LP3D, n = this.lite ? 700 : 1800;
    const geo = new BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
    { const uv = geo.attributes.uv; for (let i = 8; i < 12; i++) uv.setXY(i, 0.02, 0.01); uv.needsUpdate = true; }   // +Y face → the dark texel
    const win = windowTex(11);
    const mat = new MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveMap: win, emissiveIntensity: 0.7, toneMapped: false });
    const im = new InstancedMesh(geo, mat, n), col = new Color();
    let k = 0;
    for (let i = 0; i < n * 3 && k < n; i++) {
      const z = -Math.exp(Math.log(1100) + (Math.log(38000) - Math.log(1100)) * Math.pow(r(), 0.85));
      const half = (Math.abs(z) + 800) * 1.05;
      const x = (r() * 2 - 1) * half;
      if (Math.abs(x) < P.ROOF_HX + 120 && z > P.ROOF_Z1 - 200) continue;
      const grow = 1 + Math.abs(z) / 9000;
      const w = (55 + r() * 150) * grow, d = (55 + r() * 150) * grow;
      let h = (25 + 230 * r() * r() * r()) * (1 + Math.abs(z) / 14000);
      if (r() < 0.05 && Math.abs(z) > 4000) h += 280 + r() * 520;
      h = Math.min(h, P.H0 - 420, 90 + Math.abs(z) * 0.06);
      this.tmp.position.set(x, -P.H0, z); this.tmp.rotation.set(0, (r() - 0.5) * 0.15, 0); this.tmp.scale.set(w, h, d); this.tmp.updateMatrix();
      im.setMatrixAt(k, this.tmp.matrix);
      const b = 0.055 + r() * 0.045; col.setRGB(b * 0.95, b * 0.9, b * 1.35); im.setColorAt(k, col);
      k++;
    }
    im.count = k; im.frustumCulled = false;
    this.root.add(im);
  }

  private lights(r: () => number, dot: Texture, glow: Texture) {
    const P = LP3D, n = this.lite ? 2600 : 7000, ng = this.lite ? 70 : 160;
    const q = this.quads(n, dot, false), eyeY = -LP3D.LIFT * 0.2;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const z = -Math.exp(Math.log(600) + (Math.log(42000) - Math.log(600)) * Math.pow(r(), 0.8));
      const half = (Math.abs(z) + 800) * 1.1;
      let x = (r() * 2 - 1) * half, zz = z;
      const sp = 240 * (1 + Math.abs(z) / 6000), row = r();
      if (row < 0.55) x = Math.round(x / sp) * sp + (r() - 0.5) * 8;        // rows receding to the horizon
      else if (row < 0.85) zz = Math.round(z / sp) * sp + (r() - 0.5) * 8;  // cross streets
      if (Math.abs(x) < P.ROOF_HX + 60 && zz > P.ROOF_Z1 - 60) continue;
      const y = -P.H0 + 5 + r() * 6;
      const dist = Math.hypot(x, y - eyeY, zz);
      const s = Math.max(11, dist * 0.003) * (0.7 + r() * 0.8);
      const t = r(), c = t < 0.62 ? [1.0, 0.66, 0.34] : t < 0.92 ? [1.0, 0.86, 0.66] : [0.78, 0.82, 1.0];
      const b = this.att(dist) * (0.85 + r() * 0.95);
      this.setQuad(q, k++, x, y, zz, s, c[0] * b, c[1] * b, c[2] * b);
    }
    q.count = k; this.root.add(q);
    const g = this.quads(ng, glow, false);
    for (let i = 0; i < ng; i++) {
      const z = -Math.exp(Math.log(900) + (Math.log(30000) - Math.log(900)) * r()), x = (r() * 2 - 1) * (Math.abs(z) + 800) * 0.9;
      const y = -P.H0 + 30, dist = Math.hypot(x, y - eyeY, z), s = (380 + r() * 900) * (1 + Math.abs(z) / 9000), b = this.att(dist) * (0.26 + r() * 0.22);
      this.setQuad(g, i, x, y, z, s, 0.79 * b, 0.54 * b, 0.27 * b);   // #C98A3E-ish sodium haze (the brief's palette), not brand gold
    }
    g.renderOrder = 4; this.root.add(g);
  }

  private fogDecks() {
    const P = LP3D, levels = this.lite ? [[110, 0.3], [520, 0.16]] : [[80, 0.36], [250, 0.26], [560, 0.15]];
    levels.forEach(([h, o], i) => {
      const t = fogTex(17 + i * 13); t.repeat.set(70, 35);
      const m = new Mesh(new PlaneGeometry(240000, 120000), new MeshBasicMaterial({ map: t, color: 0x9a8bb0, transparent: true, opacity: o, depthWrite: false, fog: true, toneMapped: false }));
      m.rotation.x = -Math.PI / 2; m.position.set(0, -P.H0 + h, -60000); m.renderOrder = 6 + i;
      this.root.add(m); this.decks.push({ tex: t, sp: 0.0016 + i * 0.0011 });
    });
  }

  /** a slice of the sky dome texture: gradient by elevation, the moon's halo, film grain */
  private skyRows(rows: number) {
    const C = this.skyC, w = C.width, h = C.height, g = C.getContext("2d")!, y0 = this.skyRow, y1 = Math.min(h, y0 + rows);
    const img = g.createImageData(w, y1 - y0), d = img.data, P = LP3D, mEl = (P.MOON_EL * Math.PI) / 180;
    const mx = 0, my = Math.sin(mEl), mz = -Math.cos(mEl), halo = hex("#d8cbcf");
    let s = 1234567 + y0 * 7919;
    for (let y = y0; y < y1; y++) {
      const th = ((y + 0.5) / h) * Math.PI, e = 90 - (th * 180) / Math.PI, base = skyAt(e);
      for (let x = 0; x < w; x++) {
        const ph = ((x + 0.5) / w) * Math.PI * 2, dx = -Math.cos(ph) * Math.sin(th), dy = Math.cos(th), dz = Math.sin(ph) * Math.sin(th);
        const cosA = clamp(dx * mx + dy * my + dz * mz, -1, 1), a = Math.acos(cosA);
        const front = smooth(-0.2, 1, -dz);   // the painting is brighter toward the moon side
        const above = smooth(-1, 3, e);
        const hk = (Math.exp(-a / 0.11) * 0.62 + Math.exp(-a / 0.42) * 0.3) * above;
        s = (s * 1103515245 + 12345) & 0x7fffffff; const gr = ((s / 0x7fffffff) - 0.5) * 7;
        const lift = 1 + 0.16 * front * smooth(0, 25, e);
        const i = ((y - y0) * w + x) * 4;
        d[i] = clamp(base[0] * lift + (halo[0] - base[0]) * hk + gr, 0, 255);
        d[i + 1] = clamp(base[1] * lift + (halo[1] - base[1]) * hk + gr, 0, 255);
        d[i + 2] = clamp(base[2] * lift + (halo[2] - base[2]) * hk + gr, 0, 255);
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, y0); this.skyRow = y1;
    if (y1 >= h) { this.skyT.needsUpdate = true; return true; }
    return false;
  }

  /** run build jobs for at most `ms` (never a long task), then compile the shaders off-frame */
  private build(ms: number) {
    const t0 = performance.now();
    while (this.jobs.length && performance.now() - t0 < ms) { if (this.jobs[0]()) this.jobs.shift(); }
    if (!this.jobs.length && !this.ready && !this.compiling) {
      this.compiling = true;
      const done = () => { this.ready = true; };
      try { const p = this.compile?.(this.scene, this.camera); if (p && typeof (p as Promise<unknown>).then === "function") (p as Promise<unknown>).then(done, done); else done(); } catch { done(); }
    }
  }

  /** per frame: altitude → camera lift, lane parallax, the flame on the pad, fog drift; copies the camera */
  update(o: { band: number; t: number; W: number; H: number; camX: number; flame: number; nozzle: Vector3; cam: PerspectiveCamera }) {
    if (!this.ready) this.build(3);
    const s = o.H / 800, P = LP3D;
    this.amount = this.ready ? lp3dAmount(o.band) : 0;
    if (this.amount <= 0) return;
    this.root.scale.setScalar(s);
    this.root.position.set(-(o.camX - o.W / 2) * P.LANE_K, -lp3dLift(o.band) * s, 0);
    // the ship's flame lights the pad (same intensity law as the ship's own engine light), floods stay on
    this.v.copy(o.nozzle).sub(this.root.position).divideScalar(s);
    this.flame.position.set(this.v.x, this.v.y - 8, this.v.z + 10);
    this.flame.intensity = 1400 * clamp(o.flame, 0, 1.6);
    for (const f of this.floods) f.intensity = 260;
    for (const d of this.decks) d.tex.offset.x = (o.t * d.sp) % 1;
    this.sync(o.cam);
  }
  /** copy the (play or review) camera; the world camera only adds a far plane for the sky */
  sync(cam: PerspectiveCamera) {
    const c = this.camera;
    c.position.copy(cam.position); c.quaternion.copy(cam.quaternion);
    if (c.fov !== cam.fov || c.aspect !== cam.aspect) { c.fov = cam.fov; c.aspect = cam.aspect; c.updateProjectionMatrix(); }
    c.updateMatrixWorld();
    this.far.position.copy(cam.position);
  }

  dispose() {
    this.scene.traverse((o) => {
      const m = o as Mesh; if (m.geometry) m.geometry.dispose();
      const mat = m.material as Material | Material[] | undefined;
      if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) { const mm = x as MeshBasicMaterial & { emissiveMap?: Texture | null }; mm.map?.dispose(); mm.emissiveMap?.dispose(); x.dispose(); }
    });
  }
}
