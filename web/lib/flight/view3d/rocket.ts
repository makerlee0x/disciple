/**
 * The official chrome rocket (web/public/assets/rocket-hi.webp, 221×609) as a 3D model: a lathe body traced from the
 * sprite's own silhouette (nose cone, two hull bands, straight body), four swept fins, and the engine bells. Model
 * units = screen px at the flight plane; the origin is the nozzle pivot (0.96 of the sprite height, same as the 2D
 * engine), so the engine's nozzle position and attitude drive it directly. Height = 150 px, the same size as today.
 */
import {
  Group, LatheGeometry, Vector2, Mesh, MeshStandardMaterial, Shape, ExtrudeGeometry, CylinderGeometry, CanvasTexture,
  SRGBColorSpace, MeshBasicMaterial, DoubleSide, type Texture,
} from "three";

export const ROCKET_H = 150;
const SPR_W = 221, SPR_H = 609, PIVOT = 0.96;
const U = ROCKET_H / SPR_H;                       // model units per sprite px
const yOf = (row: number) => (PIVOT * SPR_H - row) * U;
const rOf = (halfPx: number) => halfPx * U;
export const BODY_R = rOf(48.5);
export const ROCKET_W = SPR_W * U;

/** Sprite silhouette (row, half-width px), measured from rocket-hi.webp's alpha, with the two raised hull bands. */
const PROFILE: [number, number][] = [
  [5, 0], [10, 4], [20, 13.5], [40, 21.5], [60, 29.5], [80, 36.5], [100, 41.5], [110, 44],
  [111, 46.2], [118, 46.2], [119, 45.4], [140, 47.6], [176, 48.5], [177, 50.3], [184, 50.3], [185, 48.5],
  [330, 48.5], [560, 48.5], [568, 46], [574, 40], [576, 26],
];

export type RocketParts = {
  group: Group;      // positioned / rotated by the view (nozzle pivot)
  hull: Group;       // rolls about the long axis
  chrome: MeshStandardMaterial;
  dark: MeshStandardMaterial;
  decal: Mesh;
  setDecal: (canvas: HTMLCanvasElement | OffscreenCanvas | null) => void;
};

export function buildRocket(segments: number): RocketParts {
  const group = new Group(), hull = new Group();
  group.add(hull);
  const chrome = new MeshStandardMaterial({ color: 0xe9edf4, metalness: 1, roughness: 0.14, envMapIntensity: 1.25 });
  const dark = new MeshStandardMaterial({ color: 0xa4acba, metalness: 1, roughness: 0.26, envMapIntensity: 1.1 });

  // lathe wants bottom → top
  const pts = PROFILE.slice().reverse().map(([row, hw]) => new Vector2(rOf(hw), yOf(row)));
  const body = new Mesh(new LatheGeometry(pts, segments), chrome);
  hull.add(body);

  // fins: swept leading edge from the body (row 330) out to the tip (row 458), straight outer edge, raked trailing edge
  const fin = new Shape();
  fin.moveTo(BODY_R - 0.5, yOf(330));
  fin.lineTo(rOf(108.5), yOf(458));
  fin.lineTo(rOf(109.5), yOf(566));
  fin.quadraticCurveTo(rOf(80), yOf(552), BODY_R - 0.5, yOf(548));
  fin.closePath();
  const finGeo = new ExtrudeGeometry(fin, { depth: 1.6, bevelEnabled: true, bevelThickness: 0.5, bevelSize: 0.45, bevelSegments: 2, curveSegments: 6 });
  finGeo.translate(0, 0, -0.8);
  for (let k = 0; k < 4; k++) {
    const m = new Mesh(finGeo, chrome);
    m.rotation.y = (k * Math.PI) / 2;
    hull.add(m);
  }

  // engine bells: one main, two small (the sprite's nozzle cluster)
  const bell = (r0: number, r1: number, h: number) => new CylinderGeometry(r0, r1, h, Math.max(12, segments >> 1), 1, true);
  const main = new Mesh(bell(rOf(20), rOf(30), yOf(574) - yOf(600)), dark);
  main.material.side = DoubleSide;
  main.position.y = (yOf(574) + yOf(600)) / 2;
  hull.add(main);
  for (const s of [-1, 1]) {
    const m = new Mesh(bell(rOf(9), rOf(14), yOf(574) - yOf(592)), dark);
    m.position.set(s * rOf(34), (yOf(574) + yOf(592)) / 2, 0);
    hull.add(m);
  }

  // coin roundel on the hull (lib/decal.ts MID: x .5, y .47, r .2 of the sprite width) — a curved patch just above the skin
  const dr = 0.2 * ROCKET_W, arc = (2 * dr) / BODY_R;
  const decalGeo = new CylinderGeometry(BODY_R + 0.25, BODY_R + 0.25, 2 * dr, 24, 1, true, -arc / 2, arc);
  const decalMat = new MeshStandardMaterial({ transparent: true, metalness: 0.35, roughness: 0.35, alphaTest: 0.35, visible: false });
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

  return { group, hull, chrome, dark, decal, setDecal };
}

/** Hull scorch: a dark burn with a hot rim, stuck to the skin where a blast hit; fades over a few seconds. */
export function scorchMaterials(burn: Texture, glow: Texture) {
  return {
    burn: new MeshBasicMaterial({ map: burn, transparent: true, depthWrite: false, opacity: 0 }),
    glow: new MeshBasicMaterial({ map: glow, transparent: true, depthWrite: false, opacity: 0, blending: 2 /* AdditiveBlending */ }),
  };
}
