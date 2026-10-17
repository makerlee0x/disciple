/**
 * Rocket cosmetics: body skins (tinted chrome sprite) + nose-coin emblems, composited on canvas.
 * Presentational only — never affects price, fills or odds.
 */
import { BASE_ROCKET_HI_SRC, composeRocket, loadBaseRocket, loadRocketSprite } from "./decal";

export type Skin = { id: string; name: string; tint: string | null; mode?: "color" | "multiply"; strength?: number; sheen?: string };
export type Coin = { id: string; name: string; bg: [string, string]; ink: string; glyph: string; rim: string };
export type Thruster = { id: string; name: string; core: string; flame: string };

export const SKINS: Skin[] = [
  { id: "chrome", name: "Factory Chrome", tint: null },
  { id: "gold", name: "Golden Rocket", tint: "#e0aa2e", strength: 0.9, sheen: "rgba(255,236,170,.35)" },
  { id: "rose", name: "Rose Gold", tint: "#e79a86", strength: 0.8, sheen: "rgba(255,220,210,.3)" },
  { id: "green", name: "Metallic Green", tint: "#22b56a", strength: 0.85, sheen: "rgba(190,255,215,.3)" },
  { id: "cobalt", name: "Cobalt Blue", tint: "#2f6bff", strength: 0.85, sheen: "rgba(190,215,255,.3)" },
  { id: "violet", name: "Seraph Violet", tint: "#9b6bff", strength: 0.8, sheen: "rgba(230,215,255,.3)" },
  { id: "matte", name: "Matte Black", tint: "#2a2c33", mode: "multiply", strength: 1 },
  { id: "crimson", name: "Crimson Candy", tint: "#d42a46", strength: 0.9, sheen: "rgba(255,200,210,.25)" },
];

export const THRUSTERS: Thruster[] = [
  { id: "stock", name: "Stock Burners", core: "#fff1d6", flame: "#ff8a3d" },
  { id: "seraph", name: "Seraph Gold", core: "#fffbe6", flame: "#ffcc33" },
  { id: "ion", name: "Halo Ion (blue)", core: "#e9f6ff", flame: "#3fa9ff" },
  { id: "plasma", name: "Plasma Violet", core: "#f5ecff", flame: "#a24bff" },
  { id: "venom", name: "Venom Green", core: "#effff4", flame: "#2bff88" },
  { id: "inferno", name: "Inferno Red", core: "#fff0e8", flame: "#ff2d3d" },
];

export const COINS: Coin[] = [
  { id: "halo", name: "Halo D", bg: ["#fffbe8", "#d9b65a"], ink: "#3b2a08", glyph: "D", rim: "#f2d48a" },
  { id: "sun", name: "Glory Sun", bg: ["#fff4c2", "#ff9d1c"], ink: "#5a2600", glyph: "☀", rim: "#ffd27a" },
  { id: "star", name: "North Star", bg: ["#e9f1ff", "#3f63c9"], ink: "#ffffff", glyph: "✦", rim: "#bcd0ff" },
  { id: "moon", name: "Night Moon", bg: ["#3a3f66", "#0d1030"], ink: "#ffe7a3", glyph: "☾", rim: "#c9b6f2" },
  { id: "diamond", name: "Diamond Hands", bg: ["#eaffff", "#2bb3c9"], ink: "#0b3a44", glyph: "◆", rim: "#aef3ff" },
  { id: "frog", name: "Choir Frog", bg: ["#e8ffe9", "#3fae4f"], ink: "#0d3a12", glyph: "🐸", rim: "#b8f0bf" },
];

export const skinById = (id: string) => SKINS.find((s) => s.id === id) ?? SKINS[0];
export const coinById = (id: string) => COINS.find((s) => s.id === id) ?? COINS[0];
export const thrusterById = (id: string) => THRUSTERS.find((s) => s.id === id) ?? THRUSTERS[0];

export function coinEmblem(coin: Coin, size = 256): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const bg = g.createRadialGradient(size * 0.4, size * 0.35, 0, size / 2, size / 2, size / 2);
  bg.addColorStop(0, coin.bg[0]); bg.addColorStop(1, coin.bg[1]);
  g.fillStyle = bg; g.fillRect(0, 0, size, size);
  if (coin.id === "halo") {
    g.strokeStyle = "#7a5a10"; g.lineWidth = size * 0.07;
    g.beginPath(); g.ellipse(size / 2, size * 0.3, size * 0.28, size * 0.09, 0, 0, 7); g.stroke();
  }
  g.fillStyle = coin.ink; g.textAlign = "center"; g.textBaseline = "middle";
  g.font = `bold ${size * (coin.id === "halo" ? 0.42 : 0.5)}px Georgia, "Segoe UI Symbol", "Noto Color Emoji", serif`;
  g.fillText(coin.glyph, size / 2, size * (coin.id === "halo" ? 0.64 : 0.54));
  return c;
}

/** Tint the chrome sprite (luminance kept, hue swapped) and mask back to the sprite's alpha. */
export function tintBase(base: HTMLImageElement, skin: Skin, scale = 1): HTMLCanvasElement {
  const w = base.naturalWidth * scale, h = base.naturalHeight * scale;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const o = c.getContext("2d")!;
  o.drawImage(base, 0, 0, w, h);
  if (!skin.tint) return c;
  o.globalAlpha = skin.strength ?? 0.85;
  o.globalCompositeOperation = skin.mode === "multiply" ? "multiply" : "color";
  o.fillStyle = skin.tint; o.fillRect(0, 0, w, h);
  if (skin.mode !== "multiply") { o.globalAlpha = 0.35; o.globalCompositeOperation = "overlay"; o.fillRect(0, 0, w, h); }
  o.globalAlpha = 1; o.globalCompositeOperation = "destination-in"; o.drawImage(base, 0, 0, w, h);
  if (skin.sheen) {
    o.globalCompositeOperation = "source-atop";
    const g = o.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0.25, "rgba(255,255,255,0)"); g.addColorStop(0.38, skin.sheen); g.addColorStop(0.5, "rgba(255,255,255,0)");
    o.fillStyle = g; o.fillRect(0, 0, w, h);
  }
  o.globalCompositeOperation = "source-over";
  return c;
}

export type SkinnedOpts = {
  /** Use the hi-res master sprite (221×609) instead of the 73×200 sprite; `scale` multiplies its size. */
  hi?: boolean;
  scale?: number;
  /** Optional scene lighting applied to the tinted hull before the nose coin is painted on. */
  light?: (hull: HTMLCanvasElement) => void;
};

export async function skinnedRocket(skinId: string, coinId: string, opts: SkinnedOpts = {}): Promise<HTMLCanvasElement> {
  const base = opts.hi ? await loadRocketSprite(BASE_ROCKET_HI_SRC).catch(() => loadBaseRocket()) : await loadBaseRocket();
  const tinted = tintBase(base, skinById(skinId), opts.scale ?? (opts.hi ? 2 : 4));
  opts.light?.(tinted);
  return composeRocket(tinted, coinEmblem(coinById(coinId), opts.hi ? 384 : 256), 1, {}, base);
}

export const LOADOUT_KEY = "disciple.rocket.loadout.v1";
