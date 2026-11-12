/**
 * The 3D flight scene: the chrome rocket, its flame and contrail, explosions on the hull, clouds and stars.
 *
 * It only WATCHES the flight engine (public/flight/engine.js): every engine frame hands it a snapshot (rocket nozzle
 * position and attitude, flame, world scroll, sky colour, hyperspeed / drop amounts) and a few events that already
 * happened (a sell's blast, a new tier, an ascension). Nothing here feeds back into the engine, prices, PnL or trades.
 *
 * Camera: a fixed perspective camera set so the flight plane (z = 0) maps 1:1 onto screen px, i.e. the rocket sits
 * exactly where the 2D engine puts it today, upright in the flight lane at the same 150 px size. Depth (clouds and
 * stars in front of / far behind the rocket) gives the parallax.
 *
 * Step 2 (world): the ship is the authored r5 GLB (rocket.ts) and the WORLD lights it (world.ts): the tier's BRAND env
 * plate → PMREM → scene.environment, rotated so it agrees with the visible sky plate, plus the plate's own moon / sun /
 * city lights as real lights. The flame (engineLight) and blasts (blastLight) are real lights too, so they light and
 * reflect in the chrome. No studio strips, no light behind the camera.
 */
import {
  Scene, PerspectiveCamera, HemisphereLight, PointLight, Group, Mesh, MeshBasicMaterial,
  PlaneGeometry, DoubleSide, InstancedMesh, IcosahedronGeometry, MeshStandardMaterial, Object3D,
  Vector3, Color, ACESFilmicToneMapping, InstancedBufferAttribute, DynamicDrawUsage, type Texture,
} from "three";
import { buildRocket, BODY_R, ROCKET_H, type RocketParts } from "./rocket";
import { ENV_ROT_Y, WorldLights, worldFor, loadWorldHDR, type WorldTier } from "./world";
import { Quads, SmokeQuads, PPool, lightBlend } from "./particles";
import { radialTex, puffTex, cloudTex, flameTex, streakTex } from "./textures";
import { govInit, govStep, type Gov, type Preset, type View3DBackend } from "./detect";
import type { FlightPost } from "./post";

export type Snap = {
  W: number; H: number; t: number; dt: number; ts: number;
  x: number; y: number; ang: number;
  flame: number; flick: number; fall: number;
  boost: number; vy: number;
  sky: number[]; band: number; tier: number;
  cloudY: number; camX: number;
  hyper: number; drop: number; braking: boolean;
  thrustMul: number; glowMul: number; auraMul: number;
  scorch: number;
  P: { a: { x: number; y: number; s: number; life: number; hot: boolean }[]; n: number } | null;
  tn: number; tx: Float32Array; ty: Float32Array;
  decalT0: number; decal: HTMLCanvasElement | OffscreenCanvas | null;
};
export type Ev = { k: "boom"; tier: number; x: number; y: number } | { k: "puff"; x: number; y: number } | { k: "tier"; tier: number } | { k: "hyper" };

type RendererLike = {
  render: (s: Scene, c: PerspectiveCamera) => unknown;
  setSize: (w: number, h: number, style?: boolean) => void;
  setPixelRatio: (r: number) => void;
  setClearColor: (c: number, a: number) => void;
  dispose: () => void;
  toneMapping: number; toneMappingExposure: number;
};
/** the renderer's own PMREMGenerator (three for WebGL, three/webgpu for WebGPU), used once to prefilter the chrome env */
export type PmremLike = { fromEquirectangular: (t: Texture) => { texture: Texture; dispose: () => void }; dispose: () => void };

const FOV = 55, TANH = Math.tan((FOV / 2) * Math.PI / 180);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** sizes of the hull blast by engine bomb tier: puff, grenade, bunker buster, cruise missile, nuke, atom bomb */
export const BLAST = [0.45, 1, 1.7, 2.4, 3.3, 4.6];

type Cloud = { m: Mesh; x: number; y: number; z: number; w: number; h: number; vx: number; vy: number; ox: number; oy: number; a: number };

export class FlightView3D {
  scene = new Scene();
  camera = new PerspectiveCamera(FOV, 16 / 9, 1, 8000);
  rocket: RocketParts;
  private fixed = new Group();   // rocket transform without roll (flame, scorch)
  private flameOuter: Mesh; private flameCore: Mesh; private nozzleGlow: Mesh; private streaks: Quads;
  private streakA: { a: number; r: number; sp: number; w: number }[] = [];
  private envRT: { texture: Texture; dispose: () => void } | null = null;
  private engineLight = new PointLight(0xffa860, 0, 260, 1);
  private blastLight = new PointLight(0xffc880, 0, 900, 1);
  private hemi = new HemisphereLight(0xbfd2ff, 0x1a1626, 0.7);
  private worldLights = new WorldLights();
  private pmrem: PmremLike | null = null;
  /** the world currently on the hull, the one being fetched, and the one the snapshot asks for */
  world: WorldTier | null = null; private worldLoading: WorldTier | null = null;
  /** review framing for BRAND stills only (?f3dcam=front|three-quarter|underside): a large, readable shot of the ship */
  review: { view: string; roll: number } | null = null;
  private exhaust: Quads; private fire: Quads; private sparks: Quads; private flash: Quads; private stars: Quads;
  private smoke: SmokeQuads; private trail: SmokeQuads;
  private debris: InstancedMesh;
  private fireP: PPool; private smokeP: PPool; private sparkP: PPool; private debrisP: PPool;
  private clouds: Cloud[] = [];
  private starsA: { x: number; y: number; z: number; s: number; tw: number }[] = [];
  private scorch: { burn: Mesh; glow: Mesh; age: number };
  private W = 0; private H = 0; private D = 1;
  private lastCloudY: number | null = null; private lastCamX: number | null = null;
  private stut = 0; private pitch = 0; private pitchV = 0; private rollK = 0; private rollV = 0;
  private flashT = 9; private flashMax = 0; private tierPulse = 0;
  private decalT0 = -1;
  private gov: Gov; private fc = 0;
  private tmp = new Object3D(); private v3 = new Vector3(); private col = new Color(); private col2 = new Color();
  private t = 0;
  private hit = { x: 0, y: 0, z: 0, s: 1 };
  /** STEP 3 post stack (post.ts); null = plain render */
  post: FlightPost | null = null;
  visible = true;
  stats = { frames: 0, drawn: 0, skipped: 0, lastMs: 0, ema: 0, ratio: 1, post: "off", heavy: false };

  constructor(public renderer: RendererLike, public backend: View3DBackend, public preset: Preset, dpr: number, pmrem: PmremLike | null, ship: Object3D) {
    const p = preset;
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
    this.gov = govInit(p, dpr);
    renderer.setPixelRatio(this.gov.ratio);

    const S = this.scene;
    S.add(this.hemi, this.blastLight, this.worldLights.group);
    const lite = p.quality === "lite";

    // the world on the chrome: environment rotated so the plate's centre sits behind the ship, where the backdrop shows it
    this.pmrem = pmrem || null;
    S.environmentRotation.y = ENV_ROT_Y;

    // rocket: the r5 GLB (preloaded by index.ts)
    this.rocket = buildRocket(ship);
    this.rocket.group.add(this.fixed);
    this.fixed.add(this.engineLight); this.engineLight.position.set(0, -10, 16);
    S.add(this.rocket.group);

    // flame: two additive cones (outer fire, white-blue core) pointing out of the nozzle, plus the nozzle bloom
    // flame: camera-facing cards (the camera never turns), top edge at the nozzle — soft teardrop, not a solid cone
    const cone = new PlaneGeometry(1, 1); cone.translate(0, -0.5, 0);
    const fmat = (t: Texture, o: number) => lightBlend(new MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, side: DoubleSide, opacity: o }));
    this.flameOuter = new Mesh(cone, fmat(flameTex(false), 0.85));
    this.flameCore = new Mesh(cone, fmat(flameTex(true), 1));
    const glowTex = radialTex([[0, "rgba(255,250,232,1)"], [0.3, "rgba(255,210,150,0.55)"], [1, "rgba(255,140,60,0)"]]);
    this.nozzleGlow = new Mesh(new PlaneGeometry(1, 1), lightBlend(new MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false })));
    this.fixed.add(this.flameOuter, this.flameCore, this.nozzleGlow);
    this.flameOuter.renderOrder = 2; this.flameCore.renderOrder = 3; this.nozzleGlow.renderOrder = 4;

    // hull scorch (does not roll with the hull, so it stays on the side the blast came from)
    const burnTex = radialTex([[0, "rgba(10,6,4,0.95)"], [0.45, "rgba(30,18,12,0.75)"], [1, "rgba(30,18,12,0)"]], 64);
    const hotTex = radialTex([[0, "rgba(255,230,160,1)"], [0.35, "rgba(255,120,40,0.7)"], [1, "rgba(255,60,10,0)"]], 64);
    const burn = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: burnTex, transparent: true, depthWrite: false, opacity: 0 }));
    const glow = new Mesh(new PlaneGeometry(1, 1), lightBlend(new MeshBasicMaterial({ map: hotTex, transparent: true, depthWrite: false, opacity: 0 })));
    burn.renderOrder = 5; glow.renderOrder = 6;
    this.fixed.add(burn, glow);
    this.scorch = { burn, glow, age: 99 };

    // particle pools
    const dot = radialTex([[0, "rgba(255,255,255,1)"], [0.35, "rgba(255,255,255,0.45)"], [1, "rgba(255,255,255,0)"]], 64);
    const fireT = puffTex(3), smokeT = puffTex(11);
    this.exhaust = new Quads(p.exhaust, dot, true);
    this.trail = new SmokeQuads(p.trail, smokeT);
    this.fire = new Quads(p.fire, fireT, true);
    this.smoke = new SmokeQuads(p.smoke, smokeT);
    this.sparks = new Quads(p.sparks, dot, true);
    this.flash = new Quads(8, glowTex, true);
    this.stars = new Quads(p.stars, dot, true);
    this.streaks = new Quads(lite ? 14 : 30, streakTex(), true);
    for (let i = 0; i < this.streaks.cap; i++) this.streakA.push({ a: 0, r: -1, sp: 0, w: 0 });
    this.fireP = new PPool(p.fire); this.smokeP = new PPool(p.smoke * 3); this.sparkP = new PPool(p.sparks); this.debrisP = new PPool(p.debris);
    const debrisMat = new MeshStandardMaterial({ color: 0xcfd5df, metalness: 1, roughness: 0.3 });
    this.debris = new InstancedMesh(new IcosahedronGeometry(1, 0), debrisMat, p.debris);
    this.debris.instanceMatrix.setUsage(DynamicDrawUsage); this.debris.frustumCulled = false; this.debris.count = 0;
    this.stars.mesh.renderOrder = -10;
    this.exhaust.mesh.renderOrder = 1;
    for (const pool of this.trail.pools) pool.mesh.renderOrder = 0;
    this.streaks.mesh.renderOrder = -6;
    S.add(this.stars.mesh, this.streaks.mesh, this.exhaust.mesh, this.fire.mesh, this.sparks.mesh, this.flash.mesh, this.debris);
    for (const pool of [...this.trail.pools, ...this.smoke.pools]) S.add(pool.mesh);
    this.fire.mesh.renderOrder = 8; this.sparks.mesh.renderOrder = 9; this.flash.mesh.renderOrder = 10;
    for (const pool of this.smoke.pools) pool.mesh.renderOrder = 7;

    // clouds: a handful of cumulus cards at different depths (far ones behind the rocket, a couple in front)
    const ctex = [0, 1, 2, 3].map((i) => cloudTex(i + 1));
    for (let i = 0; i < p.clouds; i++) {
      const front = i === 0;
      const z = front ? 40 + Math.random() * 60 : -1900 + Math.random() * 1700;
      const w = (front ? 160 : 200) + Math.random() * 220, h = w * (0.5 + Math.random() * 0.12);
      const m = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: ctex[i % 4], transparent: true, depthWrite: false, opacity: 0 }));
      m.renderOrder = front ? 12 : -5;
      this.clouds.push({ m, x: 0, y: 0, z, w, h, vx: 0, vy: 0, ox: 0, oy: 0, a: front ? 0.4 : 0.55 + Math.random() * 0.25 });
      S.add(m);
    }
    for (let i = 0; i < p.stars; i++) this.starsA.push({ x: 0, y: 0, z: -2600 + Math.random() * 2300, s: 1.2 + Math.random() * 2.2, tw: Math.random() * 6.28 });
  }

  /** Put a tier's world on the hull: its HDR plate through PMREM, its lights. Runs between frames (promise callback). */
  setWorld(w: WorldTier, hdr: Texture) {
    let rt: { texture: Texture; dispose: () => void } | null = null;
    if (this.pmrem) { try { rt = this.pmrem.fromEquirectangular(hdr); } catch { rt = null; } }
    this.scene.environment = rt ? rt.texture : hdr;
    this.envRT?.dispose(); this.envRT = rt;
    this.scene.environmentIntensity = w.envI;
    this.renderer.toneMappingExposure = w.exposure;
    this.worldLights.apply(w);
    this.post?.setPunch(w.punch);
    this.world = w;
  }
  /** fetch the world for this band if it is not the one on the hull (never waits; the old world stays until it lands) */
  wantWorld(band: number): Promise<void> | null {
    const w = worldFor(band);
    if (w === this.world || w === this.worldLoading) return null;
    this.worldLoading = w;
    return loadWorldHDR(w.hdr).then((t) => { if (this.worldLoading === w) { this.worldLoading = null; this.setWorld(w, t as Texture); } })
      .catch((e) => { if (this.worldLoading === w) this.worldLoading = null; console.warn("[flight 3d] world plate failed", w.id, e); });
  }

  /** BRAND review stills only: a long-lens camera close on the ship (the play camera is untouched without ?f3dcam). The
   *  ship is rolled for the three-quarter view instead of orbiting the camera, so the backdrop, the environment and the
   *  lights stay exactly as in play; only the elevation tilts the camera. */
  private reviewCam() {
    const r = this.review!, c = this.camera, el = ({ front: 6, "three-quarter": 10, underside: -36 } as Record<string, number>)[r.view] ?? 6;
    const ctr = this.v3.set(0, ROCKET_H * 0.47, 0); this.rocket.group.localToWorld(ctr);
    c.fov = 24; const dist = (ROCKET_H * 0.6) / Math.tan((c.fov * Math.PI) / 360), e = (el * Math.PI) / 180;
    c.position.set(ctr.x, ctr.y + Math.sin(e) * dist, ctr.z + Math.cos(e) * dist);
    c.near = 5; c.far = dist + 4000; c.lookAt(ctr); c.updateProjectionMatrix();
  }

  private resize(W: number, H: number) {
    this.W = W; this.H = H;
    this.D = H / 2 / TANH;
    this.camera.aspect = W / H; this.camera.position.set(0, 0, this.D); this.camera.near = 5; this.camera.far = this.D + 4000;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(W, H, false);
    this.post?.setSize(W, H);
    // scatter clouds / stars over the visible area at their depth
    for (const c of this.clouds) { const [hw, hh] = this.half(c.z); c.x = (Math.random() * 2 - 1) * hw; c.y = (Math.random() * 2 - 1) * hh; }
    for (const s of this.starsA) { const [hw, hh] = this.half(s.z); s.x = (Math.random() * 2 - 1) * hw; s.y = (Math.random() * 2 - 1) * hh; }
  }
  /** half width / height of the view at depth z */
  private half(z: number): [number, number] { const hh = (this.D - z) * TANH; return [hh * (this.W / this.H), hh]; }
  private wx(sx: number) { return sx - this.W / 2; }
  private wy(sy: number) { return this.H / 2 - sy; }

  /** An event that already happened in the engine (it never waits on this). */
  ev(e: Ev) {
    if (e.k === "boom") this.boom(e.tier);
    else if (e.k === "puff") this.puff(e.x, e.y);
    else if (e.k === "tier") { this.tierPulse = 1; this.glitter(); }
    else if (e.k === "hyper") { this.tierPulse = 1.4; }
  }

  /** a point on the hull, toward the camera, on a random side; world coords → this.hit */
  private hullPoint() {
    const s = Math.random() < 0.5 ? -1 : 1, ly = 22 + Math.random() * 86;
    this.v3.set(s * BODY_R * 0.75, ly, BODY_R * 0.8);
    this.rocket.group.localToWorld(this.v3);
    this.hit.x = this.v3.x; this.hit.y = this.v3.y; this.hit.z = this.v3.z + 6; this.hit.s = s;
    return ly;
  }

  private boom(tier: number) {
    tier = clamp(tier | 0, 0, 5);
    const sz = BLAST[tier], lite = this.preset.quality === "lite" ? 0.55 : 1;
    const ly = this.hullPoint(), { x, y, z, s } = this.hit;
    // fireball: billowing additive puffs, white-hot → orange → dark red as they age
    const nf = Math.round([5, 14, 24, 34, 46, 64][tier] * lite);
    for (let i = 0; i < nf; i++) { const p = this.fireP.spawn(); if (!p) break;
      const a = Math.random() * Math.PI * 2, v = (40 + Math.random() * 170) * Math.sqrt(sz);
      Object.assign(p, { x: x + (Math.random() - 0.5) * 8, y: y + (Math.random() - 0.5) * 8, z: z + Math.random() * 10,
        vx: Math.cos(a) * v + s * 60 * sz, vy: Math.sin(a) * v + 20, vz: Math.random() * 60, size: (10 + Math.random() * 14) * sz, grow: 34 * sz,
        life: 0, max: (0.45 + Math.random() * 0.5) * (0.7 + 0.18 * tier), drag: 3.2, g: -40, rot: Math.random() * 6.3, vr: (Math.random() - 0.5) * 2, kind: 0 });
      p.life = p.max; }
    // smoke left behind
    const ns = Math.round([3, 7, 11, 15, 20, 28][tier] * lite);
    for (let i = 0; i < ns; i++) { const p = this.smokeP.spawn(); if (!p) break;
      const a = Math.random() * Math.PI * 2, v = (20 + Math.random() * 70) * Math.sqrt(sz);
      Object.assign(p, { x: x + (Math.random() - 0.5) * 14 * sz, y: y + (Math.random() - 0.5) * 14 * sz, z: z - 4, vx: Math.cos(a) * v + s * 30, vy: Math.sin(a) * v + 25,
        vz: 0, size: (12 + Math.random() * 12) * sz, grow: 26 * sz, life: 0, max: 1.4 + Math.random() * 1.2 + tier * 0.25, drag: 1.6, g: -18,
        rot: Math.random() * 6.3, vr: (Math.random() - 0.5) * 0.8, kind: 1, r: 0.2, gg: 0.18, b: 0.18 });
      p.life = p.max; }
    // sparks flying off the hull
    const nk = Math.round([4, 14, 22, 30, 42, 56][tier] * lite);
    for (let i = 0; i < nk; i++) { const p = this.sparkP.spawn(); if (!p) break;
      const a = (s > 0 ? 0 : Math.PI) + (Math.random() - 0.5) * 2.4, v = 220 + Math.random() * 480 * Math.sqrt(sz);
      Object.assign(p, { x, y, z, vx: Math.cos(a) * v, vy: Math.sin(a) * v + 80, vz: (Math.random() - 0.2) * 200, size: 2 + Math.random() * 2, grow: 0,
        life: 0, max: 0.25 + Math.random() * 0.45, drag: 2.2, g: 520, rot: 0, vr: 0, kind: 2 });
      p.life = p.max; }
    // chrome debris knocked off
    const nd = Math.round([0, 3, 5, 8, 11, 15][tier] * lite);
    for (let i = 0; i < nd; i++) { const p = this.debrisP.spawn(); if (!p) break;
      const a = (s > 0 ? 0 : Math.PI) + (Math.random() - 0.5) * 2, v = 120 + Math.random() * 260;
      Object.assign(p, { x, y, z, vx: Math.cos(a) * v, vy: Math.sin(a) * v + 140, vz: 40 + Math.random() * 160, size: 1.2 + Math.random() * 2.4 * Math.sqrt(sz), grow: 0,
        life: 0, max: 1.2 + Math.random() * 0.8, drag: 0.6, g: 620, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 14, kind: 3 });
      p.life = p.max; }
    // light flash
    this.flashT = 0; this.flashMax = [0.6, 2.5, 5, 7, 10, 16][tier];
    this.blastLight.position.set(x, y, z + 40);
    if (tier >= 1) { const f = this.fireP.spawn(); if (f) Object.assign(f, { x, y, z: z + 12, vx: 0, vy: 0, vz: 0, size: 70 * sz, grow: 120 * sz, life: 0.16 + 0.03 * tier, max: 0.16 + 0.03 * tier, drag: 0, g: 0, rot: 0, vr: 0, kind: 4 }); }
    // the hit itself: scorch on the hull, the rocket stutters and is knocked in depth and roll
    if (tier >= 1) {
      const sc = this.scorch; sc.age = 0;
      const lx = s * BODY_R * 0.55, sizeS = clamp(10 + 5 * sz, 10, 34);
      sc.burn.position.set(lx, ly, BODY_R + 0.8); sc.burn.scale.set(sizeS, sizeS * 1.25, 1);
      sc.glow.position.set(lx, ly, BODY_R + 1.2); sc.glow.scale.set(sizeS * 1.4, sizeS * 1.6, 1);
      this.stut = Math.min(1.2, this.stut + 0.25 + 0.17 * tier);
      this.pitchV += (Math.random() < 0.5 ? -1 : 1) * (0.5 + 0.22 * tier);
      this.rollV += -s * (1.4 + 0.8 * tier);
    }
    // the blast shoves nearby clouds
    for (const c of this.clouds) {
      const dx = c.x + c.ox - x, dy = c.y + c.oy - y, d = Math.hypot(dx, dy) + 1, R = 260 * sz;
      if (d < R * 2) { const f = (1 - d / (R * 2)) * 260 * sz; c.vx += (dx / d) * f; c.vy += (dy / d) * f; }
    }
  }

  private puff(sx: number, sy: number) {
    const x = this.wx(sx), y = this.wy(sy);
    for (let i = 0; i < 5; i++) { const p = this.smokeP.spawn(); if (!p) break;
      Object.assign(p, { x: x + (Math.random() - 0.5) * 10, y: y + (Math.random() - 0.5) * 8, z: 4, vx: -40 - Math.random() * 80, vy: (Math.random() - 0.5) * 40,
        vz: 0, size: 8 + Math.random() * 6, grow: 26, life: 0, max: 0.7 + Math.random() * 0.4, drag: 2.4, g: -10, rot: Math.random() * 6, vr: 0.5, kind: 1, r: 0.85, gg: 0.82, b: 0.78 });
      p.life = p.max; }
    for (let i = 0; i < 3; i++) { const p = this.sparkP.spawn(); if (!p) break;
      Object.assign(p, { x, y, z: 6, vx: -120 - Math.random() * 120, vy: (Math.random() - 0.5) * 90, vz: 0, size: 1.6, grow: 0, life: 0, max: 0.3, drag: 3, g: 120, rot: 0, vr: 0, kind: 2 });
      p.life = p.max; }
  }

  /** a new tier: a shower of gold glitter that falls past the rocket (not a ring) */
  private glitter() {
    const g = this.rocket.group.position, n = this.preset.quality === "lite" ? 18 : 40;
    for (let i = 0; i < n; i++) { const p = this.sparkP.spawn(); if (!p) break;
      Object.assign(p, { x: g.x + (Math.random() - 0.5) * 360, y: g.y + 80 + Math.random() * 260, z: -40 + Math.random() * 120, vx: (Math.random() - 0.5) * 40,
        vy: -60 - Math.random() * 120, vz: 0, size: 2 + Math.random() * 2.5, grow: 0, life: 0, max: 1.2 + Math.random() * 0.8, drag: 0.4, g: 30, rot: 0, vr: 0, kind: 5 });
      p.life = p.max; }
  }

  /** One engine frame. Returns quickly; may skip the GPU draw when the governor says frames are too expensive. */
  frame(V: Snap) {
    this.stats.frames++;
    if (V.W !== this.W || V.H !== this.H) this.resize(V.W, V.H);
    const dt = clamp(V.dt, 0, 0.1) * (V.ts > 0 ? V.ts : 1);
    this.t += dt;
    if (!this.visible) return;
    const t0 = performance.now();

    // ---- rocket: position and attitude from the engine; stutter / knock-back from hits on top (visual only)
    this.stut = Math.max(0, this.stut - dt * 1.6);
    const st = this.stut * this.stut, T = this.t;
    const jx = st * (Math.sin(T * 83) * 0.6 + Math.sin(T * 131 + 1) * 0.4) * 7, jy = st * Math.sin(T * 97 + 2) * 4;
    const jr = st * Math.sin(T * 71) * 0.07;
    this.pitchV += (-38 * this.pitch - 7 * this.pitchV) * dt; this.pitch = clamp(this.pitch + this.pitchV * dt, -0.22, 0.22);
    this.rollV += (-6 * this.rollK - 3.2 * this.rollV) * dt; this.rollK += this.rollV * dt;
    const R = this.rocket;
    // the big-sell dip never pushes the rocket off the flight lane (nozzle stays above the trade bar)
    const drop = clamp(V.drop, 0, Math.max(0, V.H * 0.82 - V.y));
    const px0 = R.group.position.x, py0 = R.group.position.y;
    R.group.position.set(this.wx(V.x) + jx, this.wy(V.y + drop) + jy, 0);
    // the blast's fire is carried a little with the hull as it is knocked down
    const cdx = R.group.position.x - px0, cdy = R.group.position.y - py0;
    if (Math.abs(cdx) < 200 && Math.abs(cdy) < 200) {
      for (const p of this.fireP.a) { p.x += cdx * 0.7; p.y += cdy * 0.7; }
      for (const p of this.smokeP.a) { if (p.kind === 1 && p.r < 0.5) { p.x += cdx * 0.35; p.y += cdy * 0.35; } }
    }
    // a big-sell drop tips the nose over a little while it falls
    const dropTilt = clamp(drop / 900, 0, 0.12);
    R.group.rotation.set(this.pitch + dropTilt, 0, -V.ang + jr);
    if (this.review) R.group.rotation.set(0, 0, 0);   // review stills: the ship upright, like the official sprite
    R.hull.rotation.y = this.review ? this.review.roll : Math.sin(T * 0.45) * 0.38 + this.rollK;
    if (V.decal && V.decalT0 !== this.decalT0) { this.decalT0 = V.decalT0; R.setDecal(V.decal); }
    if (this.review) R.decal.visible = false;   // review stills: the bare hull (the coin roundel stays in play)
    // heat on the hull after a nuke-class hit (engine scorch 0..1)
    // the sky's colour now comes from the world itself (env + lights); only the scorch darkens the metal
    R.setScorch(clamp(V.scorch, 0, 1));

    // ---- flame (same sizing law as the 2D engine)
    const fl = Math.max(0, V.flame), fk = V.flick, br = V.braking ? 0.55 : 1;
    const L = (26 + 84 * Math.min(fl, 1.6)) * (0.85 + 0.3 * fk) * V.thrustMul * br, Wf = (20 + 9 * Math.min(fl, 1.6)) * br;
    this.flameOuter.scale.set(Wf * (0.95 + 0.1 * fk), L, 1); this.flameOuter.position.set(0, -2, 1);
    (this.flameOuter.material as MeshBasicMaterial).opacity = clamp(0.45 + 0.35 * fl, 0, 0.9);
    this.flameCore.scale.set(Wf * 0.6, L * 0.48, 1); this.flameCore.position.set(0, -2, 2);
    (this.flameCore.material as MeshBasicMaterial).opacity = clamp(0.55 + 0.4 * fl, 0, 1);
    const gs = Math.min(70, 30 + 32 * fl) * fk * Math.sqrt(V.glowMul) * 1.3;
    this.nozzleGlow.scale.set(gs, gs, 1); this.nozzleGlow.position.set(0, -4, 14);
    (this.nozzleGlow.material as MeshBasicMaterial).opacity = clamp(0.55 * fl * fk * V.glowMul, 0, 1);
    this.engineLight.intensity = 900 * clamp(fl, 0, 1.6) * fk;

    // ---- world scroll (climb, hyperspeed and big-sell fall all come in through cloudY)
    const dY = this.lastCloudY == null ? 0 : clamp(V.cloudY - this.lastCloudY, -4000, 4000); this.lastCloudY = V.cloudY;
    const dX = this.lastCamX == null ? 0 : V.camX - this.lastCamX; this.lastCamX = V.camX;
    const spd = dt > 0 ? Math.abs(dY) / dt : 0, hyper = clamp(V.hyper, 0, 1);

    // ---- sky light: the tier's sky colour on the hemisphere light, chrome env re-tinted on tier changes
    const [sr, sg, sb] = V.sky;
    this.hemi.color.setRGB(0.55 + sr / 600, 0.58 + sg / 600, 0.65 + sb / 600);
    this.tierPulse = Math.max(0, this.tierPulse - dt * 0.9);
    this.hemi.intensity = 1.3 + 0.9 * this.tierPulse + 0.6 * hyper;
    const bandI = Math.floor(V.band);
    this.wantWorld(bandI);   // the tier's world on the hull (async fetch + PMREM between frames; the old one stays meanwhile)

    // ---- blast light
    this.flashT += dt;
    this.blastLight.intensity = this.flashMax * 4000 * Math.exp(-this.flashT / 0.18);

    // ---- clouds: parallax by depth, thin out in space, stretched and rushing during hyperspeed
    const cloudAmt = 1 - 0.7 * smooth(3.4, 4.6, V.band);
    const tint = 0.22, nightK = smooth(4, 7, V.band);
    const rx = R.group.position.x, ry = R.group.position.y;
    // hyperspeed vanishing point: just above the nose; the world streams out of it and past the rocket
    const vpx = rx * 0.4, vpy = Math.max(ry + ROCKET_H + 160, this.H * 0.34), radK = Math.min(1, hyper * 3);
    for (const c of this.clouds) {
      c.vx += (-1.1 * c.ox - 1.9 * c.vx) * dt; c.vy += (-1.1 * c.oy - 1.9 * c.vy) * dt; c.ox += c.vx * dt; c.oy += c.vy * dt;
      c.y -= dY * 0.6; c.x -= dX * 0.25;
      if (hyper > 0) c.z += hyper * 700 * dt;
      const [hw, hh] = this.half(c.z);
      if (c.z > 220) { c.z = -1900 + Math.random() * 400; const [w2, h2] = this.half(c.z); c.x = (Math.random() * 2 - 1) * w2; c.y = h2 + c.h; }
      else if (c.y < -hh - c.h) { c.y += 2 * hh + 2 * c.h; c.x = (Math.random() * 2 - 1) * hw; }
      else if (c.y > hh + c.h) { c.y -= 2 * hh + 2 * c.h; c.x = (Math.random() * 2 - 1) * hw; }
      if (c.x < -hw - c.w) c.x += 2 * hw + 2 * c.w; else if (c.x > hw + c.w) c.x -= 2 * hw + 2 * c.w;
      const stretch = 1 + clamp(spd / 3000, 0, 0.6) + hyper * 0.9;
      c.m.position.set(c.x + c.ox, c.y + c.oy, c.z); c.m.scale.set(c.w / (1 + 0.35 * hyper), c.h * stretch, 1);
      // in hyperspeed each cloud is smeared along its line out of the vanishing point
      c.m.rotation.z = radK > 0 ? (Math.atan2(c.y - vpy, c.x - vpx) + Math.PI / 2) * radK : 0;
      let a = c.a * cloudAmt / stretch;
      if (c.z > 0) { const d = Math.hypot(c.x - rx, (c.y - ry - 70) * 0.8); if (d < c.w * 0.6 + 60) a *= 0.3; }
      if (this.review && c.z > -250) a = 0;   // review stills: nothing between the close camera and the ship
      const mat = c.m.material as MeshBasicMaterial;
      mat.opacity = clamp(a, 0, 1);
      this.col.setRGB(1 - tint + (tint * sr) / 255, 1 - tint + (tint * sg) / 255, 1 - tint + (tint * sb) / 255);
      if (nightK > 0) this.col.lerp(this.col2.setRGB(sr / 400 + 0.25, sg / 400 + 0.25, sb / 360 + 0.3), nightK * 0.6);
      mat.color.copy(this.col);
    }

    // ---- stars: space tiers, and the world rushing past in hyperspeed
    const starAmt = Math.max(smooth(2.6, 4.2, V.band), hyper);
    this.stars.begin();
    if (starAmt > 0.01) {
      for (const s of this.starsA) {
        s.y -= dY * 0.6; s.x -= dX * 0.25;
        if (hyper > 0) s.z += hyper * 1400 * dt;
        const [hw, hh] = this.half(s.z);
        if (s.z > -60) { s.z = -2600 + Math.random() * 300; const [w2, h2] = this.half(s.z); s.x = (Math.random() * 2 - 1) * w2; s.y = (Math.random() * 2 - 1) * h2; }
        if (s.y < -hh) s.y += 2 * hh; else if (s.y > hh) s.y -= 2 * hh;
        if (s.x < -hw) s.x += 2 * hw; else if (s.x > hw) s.x -= 2 * hw;
        const k = (this.D - s.z) / this.D, size = s.s * k * (1 + 0.6 * hyper);
        const len = size + clamp(spd * 0.08, 0, 1400) * (0.3 + 1.2 * hyper) * k * (this.D / (this.D - s.z));
        const tw = 0.6 + 0.4 * Math.sin(T * 2.2 + s.tw), b = starAmt * tw * (1 + 0.8 * hyper);
        if (radK > 0.05) {
          let dx = s.x - vpx, dy = s.y - vpy; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
          const L2 = size + (len - size) * radK * 0.45 + hyper * 30 * k;
          this.stars.push(s.x + dx * L2 / 2, s.y + dy * L2 / 2, s.z, size, L2, Math.atan2(dy, dx) - Math.PI / 2, b * 0.45, b * 0.45, b * 0.55);
        } else this.stars.push(s.x, s.y + len / 2, s.z, size, len, 0, b, b, b * 1.05);
      }
    }
    this.stars.end();

    // ---- hyperspeed streaks: cloud-wisps and light rushing outward from the vanishing point (never from the rocket:
    //      the cone straight down behind the rocket is left empty)
    this.streaks.begin();
    if (hyper > 0.02) {
      const maxR = Math.hypot(this.W, this.H) * 0.75;
      for (const k of this.streakA) {
        if (k.r < 0 || k.r > maxR) {
          let a = Math.random() * Math.PI * 2; const down = -Math.PI / 2;
          const da = Math.atan2(Math.sin(a - down), Math.cos(a - down)); if (Math.abs(da) < 0.45) a = down + Math.sign(da || 1) * (0.45 + Math.random() * 0.3);
          k.a = a; k.r = 20 + Math.random() * (k.r < 0 ? maxR : 80); k.sp = 0.8 + Math.random() * 1.4; k.w = 7 + Math.random() * 12;
        }
        k.r += (60 + k.r * 2.4) * k.sp * hyper * dt;
        const len = (40 + k.r * 0.6) * hyper, cx = vpx + Math.cos(k.a) * (k.r + len / 2), cy = vpy + Math.sin(k.a) * (k.r + len / 2);
        const b = hyper * smooth(maxR * 0.22, maxR * 0.45, k.r) * (1 - smooth(maxR * 0.75, maxR, k.r)) * 0.16;
        this.streaks.push(cx, cy, -120, k.w * (1 + k.r / 500), len, k.a - Math.PI / 2, b * 0.78, b * 0.74, b);
      }
    } else for (const k of this.streakA) k.r = -1;
    this.streaks.end();

    // ---- exhaust glow from the engine's own particles
    this.exhaust.begin();
    if (V.P) { const a = V.P.a; for (let i = 0; i < V.P.n; i++) { const p = a[i], al = clamp(0.14 * p.life, 0, 1), s = p.s * (1.3 - p.life * 0.3) * 1.5;
      if (p.hot) this.exhaust.push(this.wx(p.x), this.wy(p.y + drop), -2, s * 0.8, s * 0.8, 0, al * 0.85, al * 0.42, al * 0.14);
      else this.exhaust.push(this.wx(p.x), this.wy(p.y + drop), -2, s, s, 0, al * 0.05, al * 0.05, al * 0.08); } }
    this.exhaust.end();

    // ---- contrail: soft smoke along the engine's trail points (oldest → nozzle), not a line
    this.trail.begin();
    const n = V.tn, am = V.auraMul, sc = V.scorch;
    for (let i = 0; i < n; i++) { const u = n > 1 ? i / (n - 1) : 1;
      const a = Math.min(1, Math.pow(u, 1.6) * (0.06 + 0.05 * clamp(fl, 0, 1.6)) * am), s = (6 + 34 * Math.pow(1 - u, 0.8)) * am * 1.6;
      const c = 1 - 0.7 * sc;
      this.trail.push(a, this.wx(V.tx[i]), this.wy(V.ty[i] + drop * Math.pow(u, 6)), -6, s, i * 0.7, c * 0.78, c * 0.76, c * 0.88); }
    this.trail.end();

    // ---- own particles: fire, smoke, sparks, debris
    this.fireP.step(dt); this.smokeP.step(dt); this.sparkP.step(dt); this.debrisP.step(dt);
    if (V.braking && Math.random() < 0.5) {   // retro jets at the nose while a DUMP is pending (replaces the 2D brake rings)
      this.v3.set((Math.random() < 0.5 ? -1 : 1) * BODY_R, ROCKET_H * 0.78, 2); R.group.localToWorld(this.v3);
      const p = this.smokeP.spawn(); if (p) { Object.assign(p, { x: this.v3.x, y: this.v3.y, z: 8, vx: (this.v3.x - R.group.position.x) * 9, vy: 30, vz: 0, size: 5, grow: 30, life: 0.45, max: 0.45, drag: 3, g: 0, rot: 0, vr: 1, kind: 1, r: 0.92, gg: 0.92, b: 0.96 }); }
    }
    if ((drop > 10 || this.stut > 0.35) && Math.random() < (this.preset.quality === "lite" ? 0.35 : 0.7)) {
      this.v3.set((Math.random() - 0.5) * BODY_R, 30 + Math.random() * 80, BODY_R * 0.6); R.group.localToWorld(this.v3);
      const p = this.smokeP.spawn(); if (p) { Object.assign(p, { x: this.v3.x, y: this.v3.y, z: this.v3.z - 8, vx: (Math.random() - 0.5) * 30, vy: 60 + Math.random() * 60, vz: 0, size: 10 + Math.random() * 8, grow: 40, life: 1.6, max: 1.6, drag: 1.2, g: -30, rot: Math.random() * 6, vr: 0.6, kind: 1, r: 0.09, gg: 0.08, b: 0.1 }); }
      const e = this.sparkP.spawn(); if (e) { Object.assign(e, { x: this.v3.x, y: this.v3.y, z: this.v3.z + 4, vx: (Math.random() - 0.5) * 120, vy: 40 + Math.random() * 120, vz: 30, size: 1.6 + Math.random(), grow: 0, life: 0.6, max: 0.6, drag: 1.5, g: -60, rot: 0, vr: 0, kind: 2 }); }
    }
    this.fire.begin();
    for (const p of this.fireP.a) { const u = 1 - p.life / p.max;
      if (p.kind === 4) { const f = 1 - u; this.fire.push(p.x, p.y, p.z, p.size, p.size, 0, f, f * 0.95, f * 0.85); continue; }
      let r: number, g: number, b: number;
      if (u < 0.15) { r = 1; g = 0.96; b = 0.8; } else if (u < 0.45) { const k = (u - 0.15) / 0.3; r = 1; g = 0.96 - 0.46 * k; b = 0.8 - 0.65 * k; }
      else { const k = (u - 0.45) / 0.55; r = 1 - 0.65 * k; g = 0.5 - 0.42 * k; b = 0.15 - 0.12 * k; }
      const f = (1 - u) * (1 - u) * 1.2; this.fire.push(p.x, p.y, p.z, p.size, p.size, p.rot, r * f, g * f, b * f); }
    this.fire.end();
    this.smoke.begin();
    for (const p of this.smokeP.a) { const u = 1 - p.life / p.max, a = (u < 0.1 ? u / 0.1 : 1) * (1 - u) * 0.9; this.smoke.push(a, p.x, p.y, p.z, p.size, p.rot, p.r, p.gg, p.b); }
    this.smoke.end();
    this.sparks.begin();
    for (const p of this.sparkP.a) { const f = clamp(p.life / p.max, 0, 1);
      if (p.kind === 5) { const tw = 0.6 + 0.4 * Math.sin(T * 14 + p.x); this.sparks.push(p.x, p.y, p.z, p.size * 2, p.size * 2, 0, f * tw, f * tw * 0.82, f * tw * 0.35); continue; }
      const v = Math.hypot(p.vx, p.vy), len = clamp(v * 0.035, 2, 26);
      this.sparks.push(p.x, p.y, p.z, p.size, len, Math.atan2(p.vy, p.vx) - Math.PI / 2, f, f * 0.82, f * 0.45); }
    this.sparks.end();
    let di = 0;
    for (const p of this.debrisP.a) { if (di >= this.debris.instanceMatrix.count) break;
      this.tmp.position.set(p.x, p.y, p.z); this.tmp.rotation.set(p.rot, p.rot * 0.7, p.rot * 1.3); this.tmp.scale.setScalar(p.size); this.tmp.updateMatrix();
      this.debris.setMatrixAt(di++, this.tmp.matrix); }
    this.debris.count = di; this.debris.instanceMatrix.needsUpdate = true;

    // ---- scorch on the hull fades out
    const scA = this.scorch; scA.age += dt;
    (scA.burn.material as MeshBasicMaterial).opacity = clamp(1 - scA.age / 4.5, 0, 0.9);
    (scA.glow.material as MeshBasicMaterial).opacity = clamp(1 - scA.age / 1.1, 0, 1) * (0.75 + 0.25 * Math.sin(T * 30));

    // ---- draw (or drop this 3D frame if the governor says we're over budget)
    const g = this.gov, skip = g.skip > 0 && (this.fc++ % (g.skip + 1)) !== 0;
    if (skip) { this.stats.skipped++; return; }
    if (this.review) this.reviewCam();
    if (this.post) this.post.render(); else this.renderer.render(this.scene, this.camera);
    const ms = performance.now() - t0;
    this.stats.drawn++; this.stats.lastMs = ms;
    const slowFrame = V.dt * 1000 > 26 ? this.preset.budgetMs * 1.3 : 0;
    const act = this.stats.drawn > 30 ? govStep(g, this.preset, Math.max(ms, slowFrame)) : null;   // skip shader-compile warm-up frames
    const P = this.post;
    if ((act === "down" || act === "skip") && P?.heavy) {   // over budget: drop SSR + AO first, keep resolution and frames
      if (act === "down") g.ratio = Math.min(this.preset.maxPixelRatio, +(g.ratio / 0.8).toFixed(3)); else g.skip = 0;
      P.setHeavy(false);
    } else if (act === "up" && P && P.kind === "full" && !P.heavy && g.ratio >= this.preset.maxPixelRatio - 1e-6) {
      P.setHeavy(true);                 // lots of headroom at full resolution: bring them back
    } else if (act === "down" || act === "up") { this.renderer.setPixelRatio(g.ratio); P?.setPixelRatio(g.ratio); }
    this.stats.ema = g.ema; this.stats.ratio = g.ratio; this.stats.post = P?.kind ?? "off"; this.stats.heavy = !!P?.heavy;
  }

  dispose() {
    this.scene.traverse((o) => {
      const m = o as Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as MeshBasicMaterial | MeshBasicMaterial[] | undefined;
      if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) { x.map?.dispose(); x.dispose(); }
    });
    try { this.post?.dispose(); } catch { /* ignore */ }
    this.envRT?.dispose(); try { this.pmrem?.dispose(); } catch { /* ignore */ }
    this.renderer.dispose();
  }
}

/** for unit tests */
export const _internals = { FOV, TANH, InstancedBufferAttribute };
