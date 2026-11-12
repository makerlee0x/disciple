/**
 * The flight ship: the authored look-dev rocket, exactly the r5 GLB BRAND accepted (web/public/lookdev/disciple-rocket.glb,
 * baked by lib/flight/lookdev/authoring/build_rocket.py, look-dev HEAD 2d30a76d). It is loaded as-is — no simpler stand-in,
 * no retopo. Note: it is large (~193k tris, ~7.7 MB with its 2k normal + 1k ORM maps); it loads once, in the background,
 * and the 2D flight keeps drawing the official sprite until it is ready.
 *
 * The GLB is authored in sprite units (1 m = 609 sprite px = the full sprite height) with its origin at the nozzle pivot
 * (0.96 of the sprite height, same as the 2D engine), so scaling it by ROCKET_H puts it on the flight plane in screen px at
 * today's 150 px size, and the engine's nozzle position and attitude drive it directly.
 *
 * Chrome recipe (official Three.js PMREM chrome): MeshPhysicalMaterial, metalness 1, the bake's roughness map (0.012–0.02
 * on the hull) and its normal map, no clear coat (as the accepted look-dev); everything you see on it is the world (scene.environment + lights).
 */
import {
  Group, Mesh, MeshStandardMaterial, MeshPhysicalMaterial, CylinderGeometry, CanvasTexture,
  SRGBColorSpace, MeshBasicMaterial, FrontSide, type Texture, type Object3D,
} from "three";

export const ROCKET_H = 150;
export const ROCKET_GLB = "/lookdev/disciple-rocket.glb";
const SPR_W = 221, SPR_H = 609, PIVOT = 0.96;
const U = ROCKET_H / SPR_H;                       // model units per sprite px
const yOf = (row: number) => (PIVOT * SPR_H - row) * U;
const rOf = (halfPx: number) => halfPx * U;
export const BODY_R = rOf(48.5);
export const ROCKET_W = SPR_W * U;

export type RocketParts = {
  group: Group;      // positioned / rotated by the view (nozzle pivot)
  hull: Group;       // rolls about the long axis
  chrome: MeshPhysicalMaterial;
  dark: MeshPhysicalMaterial;
  decal: Mesh;
  setDecal: (canvas: HTMLCanvasElement | OffscreenCanvas | null) => void;
  /** scorch 0..1 after a nuke-class hit: darkens the metal, keeps the bake's own base colours otherwise */
  setScorch: (k: number) => void;
};

/** the r5 GLB's scene (fetched once; the caller keeps the 2D flight on until it resolves) */
export async function loadShip(url = ROCKET_GLB): Promise<Object3D> {
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const g = await new GLTFLoader().loadAsync(url);
  return g.scene;
}

/** glTF metal-rough material → MeshPhysicalMaterial with the same maps and factors (no clear coat) */
function physical(m: MeshStandardMaterial): MeshPhysicalMaterial {
  const p = new MeshPhysicalMaterial({
    name: m.name, color: m.color.clone(), metalness: m.metalness, roughness: m.roughness,
    map: m.map, normalMap: m.normalMap, normalScale: m.normalScale.clone(), roughnessMap: m.roughnessMap, metalnessMap: m.metalnessMap,
    aoMap: m.aoMap, clearcoat: 0, envMapIntensity: 1, side: FrontSide,   // no clear coat: same as the accepted look-dev material
  });
  return p;
}

export function buildRocket(ship: Object3D): RocketParts {
  const group = new Group(), hull = new Group();
  group.add(hull);
  ship.scale.setScalar(ROCKET_H);
  const mats = new Map<MeshStandardMaterial, MeshPhysicalMaterial>();
  let chrome: MeshPhysicalMaterial | null = null, dark: MeshPhysicalMaterial | null = null;
  ship.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const src = m.material as MeshStandardMaterial;
    let p = mats.get(src);
    if (!p) { p = physical(src); mats.set(src, p); if (/engine/i.test(src.name)) dark = p; else chrome = chrome || p; }
    m.material = p;
  });
  const chromeM: MeshPhysicalMaterial = chrome || new MeshPhysicalMaterial({ metalness: 1, roughness: 0.015 });
  const darkM: MeshPhysicalMaterial = dark || chromeM;
  const base = [...mats.values()].map((p) => [p, p.color.clone()] as const);
  const setScorch = (k: number) => { for (const [p, c] of base) p.color.setRGB(c.r * (1 - 0.55 * k), c.g * (1 - 0.6 * k), c.b * (1 - 0.62 * k)); };
  hull.add(ship);

  // coin roundel on the hull (lib/decal.ts MID: x .5, y .47, r .2 of the sprite width) — a curved patch just above the
  // authored skin (which ripples a few % around the sprite radius, so the patch sits at 1.08 r)
  const dr = 0.2 * ROCKET_W, DR = BODY_R * 1.08, arc = (2 * dr) / DR;
  const decalGeo = new CylinderGeometry(DR, DR, 2 * dr, 24, 1, true, -arc / 2, arc);
  const decalMat = new MeshPhysicalMaterial({ transparent: true, metalness: 0.35, roughness: 0.35, alphaTest: 0.35, visible: false });
  const decal = new Mesh(decalGeo, decalMat);
  decal.position.y = yOf(0.47 * SPR_H);
  hull.add(decal);

  let decalTex: Texture | null = null;
  const setDecal = (src: HTMLCanvasElement | OffscreenCanvas | null) => {
    if (!src || !(src.width > 0)) { decalMat.visible = false; return; }
    // crop the roundel out of the branded sprite (same framing as the base sprite)
    const sw = src.width, sh = src.height, cx = 0.5 * sw, cy = 0.47 * sh, r = 0.2 * sw, n = 256;
    const c = document.createElement("canvas"); c.width = c.height = n;
    const g = c.getContext("2d")!;
    g.beginPath(); g.arc(n / 2, n / 2, n / 2 - 1, 0, Math.PI * 2); g.clip();
    g.drawImage(src as CanvasImageSource, cx - r, cy - r, 2 * r, 2 * r, 0, 0, n, n);
    decalTex?.dispose();
    decalTex = new CanvasTexture(c); decalTex.colorSpace = SRGBColorSpace;
    decalMat.map = decalTex; decalMat.visible = true; decalMat.needsUpdate = true;
  };
  return { group, hull, chrome: chromeM, dark: darkM, decal, setDecal, setScorch };
}

/** Hull scorch: a dark burn with a hot rim, stuck to the skin where a blast hit; fades over a few seconds. */
export function scorchMaterials(burn: Texture, glow: Texture) {
  return {
    burn: new MeshBasicMaterial({ map: burn, transparent: true, depthWrite: false, opacity: 0 }),
    glow: new MeshBasicMaterial({ map: glow, transparent: true, depthWrite: false, opacity: 0, blending: 2 /* AdditiveBlending */ }),
  };
}
