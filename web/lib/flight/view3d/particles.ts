/**
 * Instanced camera-facing quads (one draw call per pool). The camera never rotates, so quads in the XY plane always
 * face it. Additive pools fade by colour (black = invisible); normal-blended smoke has no per-instance alpha in a plain
 * material, so it is split into a few alpha buckets (one InstancedMesh each).
 */
import {
  InstancedMesh, PlaneGeometry, MeshBasicMaterial, InstancedBufferAttribute, Object3D, AdditiveBlending, NormalBlending,
  DynamicDrawUsage, type Texture,
} from "three";

const geo = new PlaneGeometry(1, 1);
const tmp = new Object3D();

export class Quads {
  mesh: InstancedMesh;
  private n = 0;
  constructor(public cap: number, map: Texture, additive: boolean, opacity = 1) {
    const mat = new MeshBasicMaterial({ map, transparent: true, depthWrite: false, opacity,
      blending: additive ? AdditiveBlending : NormalBlending, vertexColors: false });
    this.mesh = new InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    this.mesh.instanceColor.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }
  begin() { this.n = 0; }
  push(x: number, y: number, z: number, sx: number, sy: number, rot: number, r: number, g: number, b: number) {
    if (this.n >= this.cap) return;
    tmp.position.set(x, y, z); tmp.rotation.set(0, 0, rot); tmp.scale.set(sx, sy, 1); tmp.updateMatrix();
    this.mesh.setMatrixAt(this.n, tmp.matrix);
    this.mesh.instanceColor!.setXYZ(this.n, r, g, b);
    this.n++;
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/** Smoke in alpha buckets: push(a) picks the bucket closest to alpha a. */
export class SmokeQuads {
  pools: Quads[];
  static LEVELS = [0.75, 0.5, 0.3, 0.14];
  constructor(capEach: number, map: Texture) {
    this.pools = SmokeQuads.LEVELS.map((o) => new Quads(capEach, map, false, o));
  }
  begin() { for (const p of this.pools) p.begin(); }
  push(a: number, x: number, y: number, z: number, s: number, rot: number, r: number, g: number, b: number) {
    if (a < 0.05) return;
    const L = SmokeQuads.LEVELS; let k = 0, best = 9;
    for (let i = 0; i < L.length; i++) { const d = Math.abs(L[i] - a); if (d < best) { best = d; k = i; } }
    this.pools[k].push(x, y, z, s, s, rot, r, g, b);
  }
  end() { for (const p of this.pools) p.end(); }
}

/** Simple particle record for the module's own effects (explosions, debris, sparks). */
export type P = {
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  life: number; max: number; size: number; grow: number; drag: number; g: number;
  rot: number; vr: number; kind: number; r: number; gg: number; b: number;
};
export class PPool {
  a: P[] = [];
  constructor(public cap: number) {}
  spawn(): P | null {
    if (this.a.length >= this.cap) return null;
    const p: P = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, max: 1, size: 1, grow: 0, drag: 0, g: 0, rot: 0, vr: 0, kind: 0, r: 1, gg: 1, b: 1 };
    this.a.push(p); return p;
  }
  step(dt: number) {
    const a = this.a; let j = 0;
    for (let i = 0; i < a.length; i++) {
      const p = a[i]; p.life -= dt; if (p.life <= 0) continue;
      const d = Math.exp(-p.drag * dt); p.vx *= d; p.vy *= d; p.vz *= d; p.vy -= p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.size += p.grow * dt; p.rot += p.vr * dt;
      a[j++] = p;
    }
    a.length = j;
  }
}
