/**
 * Hull colour grades for the launch rocket (canvas board "Rocket variety at launch"). Every hull is the same chrome
 * sprite: each pixel's brightness is looked up on a five-stop ramp, so all hulls share one silhouette and light by
 * construction. Pure (works on any RGBA buffer), so the browser (lib/rocketSkin) and the share renderer
 * (lib/share/scene) grade the same way.
 */
export type Ramp = readonly [r: readonly number[], g: readonly number[], b: readonly number[]];

export const RAMPS: Record<string, Ramp> = {
  matte: [[0.05, 0.14, 0.24, 0.36, 0.46], [0.055, 0.15, 0.25, 0.37, 0.47], [0.065, 0.17, 0.28, 0.41, 0.52]],
  violet: [[0.06, 0.22, 0.42, 0.72, 0.95], [0.03, 0.1, 0.25, 0.58, 0.92], [0.14, 0.42, 0.82, 0.98, 1]],
  gold: [[0.14, 0.45, 0.76, 0.96, 1], [0.08, 0.27, 0.54, 0.82, 0.97], [0.02, 0.06, 0.17, 0.48, 0.85]],
};

const look = (t: readonly number[], v: number) => {
  const x = Math.min(1, Math.max(0, v)) * (t.length - 1), i = Math.min(t.length - 2, Math.floor(x));
  return t[i] + (t[i + 1] - t[i]) * (x - i);
};

/** Grade RGBA pixels in place: equal-weight grey, then the ramp per channel. Alpha is untouched. */
export function applyRamp(d: Uint8ClampedArray, ramp: Ramp) {
  const [R, G, B] = ramp;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const v = (d[i] + d[i + 1] + d[i + 2]) / 765;
    d[i] = look(R, v) * 255; d[i + 1] = look(G, v) * 255; d[i + 2] = look(B, v) * 255;
  }
}
