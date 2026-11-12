/**
 * The flight WORLD that lights the chrome ship (step 2).
 *
 * Existing solutions this is built on:
 *  - Three.js's own chrome recipe (the official "ocean" / PMREM examples): an HDR equirect → PMREMGenerator →
 *    scene.environment, reflected by MeshPhysicalMaterial (metalness 1, roughness 0.012–0.02 from the look-dev bake).
 *  - BRAND's env plates r1 (disciple-brand/mockups/flight-3d-lookdev-r1/env/, see its README): per tier an equirect wrap of
 *    the approved sky plate, highlight-boosted to an .hdr, plus lights.json (the plate's brightest light: direction and
 *    colour). Copied here at 2048×1024 (same 512 px PMREM cube as the 2560 source; three sizes the cube from width / 4).
 *  - The visible sky stays the engine's own drawBg() of the approved plates (public/assets/tierN.webp, lee Oct 16), so the
 *    backdrop and the reflections are the SAME picture: one rotation for both (ENV_ROT_Y puts the plate's centre, +X in
 *    the map, behind the ship on −Z, exactly where the backdrop is).
 *  - The plate's hard light sources are real three.js lights in the same direction and colour as lights.json (moon, sun,
 *    galactic core, the Launch Pad's sodium city lights), because the map alone only gives soft reflections.
 *
 * Only the five plates BRAND has made are wired. Other tiers use the nearest wired plate until BRAND signs theirs off.
 * No studio light: no softbox strips (those stay on /flight/lookdev only) and no light behind the camera.
 */
import { DirectionalLight, Group, Vector3 } from "three";

/** plate centre (+X in the equirect) → behind the ship (−Z), where the backdrop is. Same rotation for env and lights. */
export const ENV_ROT_Y = Math.PI / 2;

type L = { dir: [number, number, number]; color: string; intensity: number };
export type WorldTier = {
  id: "launch-pad" | "ozone" | "outer-space" | "the-moon" | "seventh-heaven";
  /** engine tier index (FLIGHT_TIERS / V.band floor) */
  tier: number;
  name: string;
  hdr: string;
  /** scene.environmentIntensity and renderer exposure, tuned by eye against rocket-hi.webp */
  envI: number;
  exposure: number;
  /** lights.json key light (dir_threejs_equirectUv, colour_hex) + any other light already in the plate */
  lights: L[];
};

// directions are in the plate's own (un-rotated) equirectUv frame, copied from lights.json; ENV_ROT_Y is applied below
export const WORLD_TIERS: WorldTier[] = [
  { id: "launch-pad", tier: 0, name: "LAUNCH PAD", hdr: "/world/env/launch-pad.hdr", envI: 1.0, exposure: 1.15, lights: [
    { dir: [0.9006, 0.4345, 0.0119], color: "#fff3e6", intensity: 3.0 },          // the moon (lights.json key)
    // sodium city lights spread across the plate just under its horizon (plate px y ≈ 360–520), colour = median of those
    // pixels in the approved plate (#cc976d). Low, warm, from where they are in the picture.
    { dir: [0.80, -0.10, -0.59], color: "#cc976d", intensity: 0.9 },
    { dir: [0.97, -0.12, 0.20], color: "#cc976d", intensity: 0.9 },
    { dir: [0.75, -0.12, 0.65], color: "#cc976d", intensity: 0.7 },
  ] },
  { id: "ozone", tier: 1, name: "OZONE", hdr: "/world/env/ozone.hdr", envI: 1.0, exposure: 1.1, lights: [
    { dir: [0.8442, -0.4877, 0.2224], color: "#fff8fe", intensity: 2.2 },          // glow on the cloud horizon
  ] },
  { id: "outer-space", tier: 4, name: "OUTER SPACE", hdr: "/world/env/outer-space.hdr", envI: 1.0, exposure: 1.15, lights: [
    { dir: [0.9968, -0.0793, 0.0051], color: "#ffe4e4", intensity: 1.6 },          // galactic core (lights.json key)
    { dir: [0.132, 0.672, 0.729], color: "#f4f2ff", intensity: 1.4 },              // the small moon, plate px (1207, 60) per README
  ] },
  { id: "the-moon", tier: 8, name: "THE MOON", hdr: "/world/env/the-moon.hdr", envI: 1.0, exposure: 1.1, lights: [
    { dir: [0.8544, 0.4833, 0.1907], color: "#fef6ff", intensity: 3.2 },           // moon disk and rim
  ] },
  { id: "seventh-heaven", tier: 17, name: "SEVENTH HEAVEN", hdr: "/world/env/seventh-heaven.hdr", envI: 0.85, exposure: 0.9, lights: [
    { dir: [0.59, -0.1664, 0.7901], color: "#fffaee", intensity: 3.0 },           // low sun and its glint
  ] },
];

/** the wired plate for an engine tier: its own, else the nearest wired one (ties go to the lower tier) */
export function worldFor(band: number): WorldTier {
  const t = Math.max(0, Math.floor(band || 0));
  let best = WORLD_TIERS[0];
  for (const w of WORLD_TIERS) if (Math.abs(w.tier - t) < Math.abs(best.tier - t)) best = w;
  return best;
}

/** a direction from the plate's frame into the world (same rotation as scene.environmentRotation.y) */
export function worldDir(d: [number, number, number], out = new Vector3()) {
  return out.set(d[0], d[1], d[2]).normalize().applyAxisAngle(new Vector3(0, 1, 0), ENV_ROT_Y);
}

/** the plate's real lights, rebuilt when the tier's world changes */
export class WorldLights {
  group = new Group();
  private pool: DirectionalLight[] = [];
  apply(w: WorldTier, dist = 4000) {
    for (let i = 0; i < Math.max(w.lights.length, this.pool.length); i++) {
      let l = this.pool[i];
      if (!l) { l = new DirectionalLight(0xffffff, 0); this.pool.push(l); this.group.add(l); this.group.add(l.target); }
      const s = w.lights[i];
      if (!s) { l.visible = false; l.intensity = 0; continue; }
      l.visible = true; l.color.set(s.color); l.intensity = s.intensity;
      worldDir(s.dir, l.position).multiplyScalar(dist);
    }
  }
}

/** HDR cache: one fetch per plate, shared by every frame / tier switch */
const cache = new Map<string, Promise<unknown>>();
export function loadWorldHDR(url: string): Promise<unknown> {
  let p = cache.get(url);
  if (!p) {
    p = (async () => {
      const THREE = await import("three");
      const { HDRLoader } = await import("three/examples/jsm/loaders/HDRLoader.js");
      const t = await new HDRLoader().setDataType(THREE.HalfFloatType).loadAsync(url);
      t.mapping = THREE.EquirectangularReflectionMapping;
      return t;
    })();
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}
