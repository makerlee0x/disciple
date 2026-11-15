/**
 * Generated launch badges (Launch page, step 2): a set of patch-style emblems drawn from the rocket's name.
 *
 * The name picks the emblem ("Silent Falcon" → wings, "Lunar Ghost" → a ghost under a crescent) and the colour
 * ("Golden" → gold, "Neon" → plasma, "Feral" → toxic). Typed names with no known word fall back to a hash, so every
 * name still gets its own look. Each set has six takes (different frame, colour and emblem mix); shuffle rolls a new set.
 * Everything is drawn on a canvas, so the badge is stored the same way an upload is (lib/launchImage).
 */
export const BADGE_SIZE = 512;
export const BADGE_TAKES = 6;

export type Palette = { id: string; bg: [string, string]; accent: string; metal: [string, string] };
export type Frame = "ring" | "burst" | "hex" | "shield";
export type Motif =
  | "wings" | "halo" | "crescent" | "sun" | "comet" | "flame" | "gem" | "eye" | "claw" | "bolt" | "tail" | "rocket" | "crown" | "ghost";
export type BadgeSpec = { motif: Motif; palette: Palette; frame: Frame; letters: string };

export const PALETTES: Record<string, Palette> = {
  ember:    { id: "ember",    bg: ["#2A0A05", "#B33A18"], accent: "#FFB35C", metal: ["#FFF0D2", "#FF8A3D"] },
  toxic:    { id: "toxic",    bg: ["#051208", "#1E5A1B"], accent: "#B6FF4A", metal: ["#F2FFD8", "#7BE33B"] },
  royal:    { id: "royal",    bg: ["#140A2E", "#4B2A9A"], accent: "#F2C14E", metal: ["#FFF3CC", "#E0A93A"] },
  ice:      { id: "ice",      bg: ["#04142A", "#1B5D8F"], accent: "#8FE3FF", metal: ["#F4FCFF", "#7CCBF2"] },
  rose:     { id: "rose",     bg: ["#240614", "#A3245A"], accent: "#FF8FC0", metal: ["#FFEAF3", "#FF6FA8"] },
  gold:     { id: "gold",     bg: ["#120E06", "#4E3C12"], accent: "#F2C14E", metal: ["#FFF6D6", "#D9A631"] },
  steel:    { id: "steel",    bg: ["#0D1016", "#3A4250"], accent: "#D4D9E1", metal: ["#FFFFFF", "#9AA3B2"] },
  plasma:   { id: "plasma",   bg: ["#0A0624", "#3B1C8C"], accent: "#FF4FD8", metal: ["#FFE6FB", "#B66BFF"] },
  jade:     { id: "jade",     bg: ["#031C17", "#0F6B57"], accent: "#5FF0C8", metal: ["#E8FFF8", "#47D6AE"] },
  midnight: { id: "midnight", bg: ["#05060F", "#20264D"], accent: "#A9C4FF", metal: ["#F4F7FF", "#8EA4E8"] },
};
const PALETTE_ORDER = ["royal", "ember", "ice", "toxic", "rose", "gold", "plasma", "jade", "steel", "midnight"];
const MOTIF_ORDER: Motif[] = ["wings", "comet", "flame", "bolt", "crescent", "gem", "crown", "eye", "sun", "claw", "halo", "ghost", "tail", "rocket"];
const FRAMES: Frame[] = ["ring", "burst", "hex", "shield"];

/** Name words → emblem. Covers every word the name shuffle uses (lib/rocketNames) plus common typed ones. */
const WORD_MOTIF: Record<string, Motif> = {
  falcon: "wings", angel: "wings", seraph: "wings", pilgrim: "wings", eagle: "wings", hawk: "wings", bird: "wings", raven: "wings", crow: "wings",
  phoenix: "flame", dragon: "flame", fire: "flame", blaze: "flame", inferno: "flame", hell: "flame", burn: "flame",
  halo: "halo", holy: "halo", saint: "halo", blessed: "halo", choir: "halo", monk: "halo", heaven: "halo", god: "halo",
  lunar: "crescent", moon: "crescent", night: "crescent", silent: "crescent", dark: "crescent",
  solar: "sun", sun: "sun", golden: "sun", gilded: "sun", dawn: "sun", sol: "sun",
  comet: "comet", celestial: "comet", cosmic: "comet", star: "comet", nova: "comet", astro: "comet", galaxy: "comet", orbit: "comet",
  crystal: "gem", pearly: "gem", diamond: "gem", gem: "gem", velvet: "gem", ice: "gem",
  oracle: "eye", prophet: "eye", eye: "eye", vision: "eye", seer: "eye",
  wolf: "claw", lion: "crown", cat: "claw", inu: "claw", dog: "claw", doge: "claw", ape: "claw", tiger: "claw", bear: "claw", feral: "claw", wild: "claw",
  neon: "bolt", based: "bolt", iron: "bolt", volt: "bolt", thunder: "bolt", zap: "bolt", turbo: "bolt", frog: "bolt", pepe: "bolt",
  whale: "tail", shark: "tail", fish: "tail", ocean: "tail", wave: "tail",
  rocket: "rocket", moonshot: "rocket", ship: "rocket", launch: "rocket",
  king: "crown", queen: "crown", royal: "crown", crown: "crown", prime: "crown", emperor: "crown",
  ghost: "ghost", spirit: "ghost", phantom: "ghost", spook: "ghost",
};
/** Name words → colour. */
const WORD_PALETTE: Record<string, string> = {
  golden: "gold", gilded: "gold", gold: "gold", holy: "gold", blessed: "gold", saint: "gold", king: "gold", lion: "gold",
  neon: "plasma", cosmic: "plasma", celestial: "plasma", galaxy: "plasma", nova: "plasma",
  lunar: "ice", crystal: "ice", ice: "ice", whale: "ice", ocean: "ice", pearly: "steel",
  solar: "ember", phoenix: "ember", dragon: "ember", fire: "ember", blaze: "ember", sun: "ember",
  feral: "toxic", wild: "toxic", frog: "toxic", pepe: "toxic", based: "toxic", ape: "toxic",
  velvet: "royal", seraph: "royal", angel: "royal", oracle: "royal", prophet: "royal", royal: "royal", crown: "royal", choir: "royal",
  iron: "steel", falcon: "steel", wolf: "steel", rocket: "steel", silent: "midnight", ghost: "midnight", night: "midnight", monk: "jade", inu: "rose", cat: "rose",
};

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function badgeLetters(ticker: string): string {
  const t = ticker.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return (t || "?").slice(0, 8);
}

/** Six takes for this name (seed 0 = the best match first; shuffle bumps the seed). */
export function badgeSpecs(name: string, ticker: string, seed = 0): BadgeSpec[] {
  const words = name.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
  const h = hash(name.toLowerCase().trim() + "|" + seed);
  const motifs: Motif[] = [];
  // the noun leads ("Silent Falcon Prime" → wings first); suffix words like Prime / X / One come last
  const SUFFIX = new Set(["prime", "x", "one", "zero", "mk", "ii"]);
  const ranked = [...words.filter((w) => !SUFFIX.has(w)).reverse(), ...words.filter((w) => SUFFIX.has(w))];
  for (const w of ranked) { const m = WORD_MOTIF[w]; if (m && !motifs.includes(m)) motifs.push(m); }
  const palettes: string[] = [];
  for (const w of words) { const p = WORD_PALETTE[w]; if (p && !palettes.includes(p)) palettes.push(p); }
  for (let i = 0; motifs.length < 4; i++) { const m = MOTIF_ORDER[(h + i * 5) % MOTIF_ORDER.length]; if (!motifs.includes(m)) motifs.push(m); }
  for (let i = 0; palettes.length < BADGE_TAKES; i++) { const p = PALETTE_ORDER[(h + i * 3) % PALETTE_ORDER.length]; if (!palettes.includes(p)) palettes.push(p); }
  const letters = badgeLetters(ticker);
  // seed > 0: rotate so a shuffle shows a new lead take, not the same six reordered
  const mOff = seed % motifs.length, pOff = seed % palettes.length, fOff = (h >>> 3) % FRAMES.length;
  const motifPlan = [0, 0, 1, 0, 1, 2];
  return Array.from({ length: BADGE_TAKES }, (_, i) => ({
    motif: motifs[(motifPlan[i] + mOff) % motifs.length],
    palette: PALETTES[palettes[(i + pOff) % palettes.length]],
    frame: FRAMES[(i + fOff + (seed ? 0 : 0)) % FRAMES.length],
    letters,
  }));
}

// ---------------------------------------------------------------- drawing (100 × 100 design box)

const MIRROR_WING = "M50 56 C42 48 28 40 6 36 C12 44 18 48 24 51 C16 51 10 50 4 49 C11 56 19 59 27 61 C20 62 14 62 8 61 C17 68 30 71 42 67 C46 65 48 61 50 60 Z";
const PATHS: Record<Motif, string[]> = {
  wings: [MIRROR_WING, "M50 40 C55 40 57 46 56 54 L54 70 L50 76 L46 70 L44 54 C43 46 45 40 50 40 Z"],
  halo: ["M50 34 L56 52 L74 58 L56 64 L50 82 L44 64 L26 58 L44 52 Z"],
  crescent: ["M62 14 A36 36 0 1 0 62 86 A42 42 0 0 1 62 14 Z", "M70 36 L73 44 L81 47 L73 50 L70 58 L67 50 L59 47 L67 44 Z"],
  sun: [],
  comet: ["M62 20 L67 36 L83 41 L67 46 L62 62 L57 46 L41 41 L57 36 Z", "M50 50 L18 82 L22 86 L54 54 Z", "M44 42 L20 62 L23 65 L47 45 Z", "M58 56 L38 80 L41 83 L61 59 Z"],
  flame: ["M50 10 C60 26 76 36 74 58 C73 74 62 88 50 88 C37 88 26 77 26 62 C26 49 34 42 38 30 C42 42 46 46 50 48 C54 38 54 24 50 10 Z",
    "M50 52 C56 60 62 64 61 72 C60 80 55 84 50 84 C44 84 39 80 39 73 C39 67 44 64 46 58 C48 62 50 62 50 52 Z"],
  gem: ["M26 38 L38 20 L62 20 L74 38 L50 84 Z"],
  eye: ["M10 50 C28 24 72 24 90 50 C72 76 28 76 10 50 Z"],
  claw: ["M52 10 C46 34 34 58 14 80 C30 66 46 46 58 14 Z", "M70 16 C64 40 52 64 32 88 C50 72 64 50 76 20 Z", "M86 28 C80 50 70 70 52 90 C68 78 80 60 90 34 Z"],
  bolt: ["M58 8 L26 56 L46 56 L38 92 L74 40 L54 40 L64 8 Z"],
  tail: ["M50 88 C47 74 46 62 50 50 C42 40 26 36 10 40 C20 26 40 24 50 36 C60 24 80 26 90 40 C74 36 58 40 50 50 C54 62 53 74 50 88 Z"],
  rocket: ["M50 8 C62 20 66 36 64 58 L72 70 L72 80 L62 74 L38 74 L28 80 L28 70 L36 58 C34 36 38 20 50 8 Z", "M44 78 L56 78 L53 92 L47 92 Z"],
  crown: ["M18 70 L14 30 L34 48 L50 20 L66 48 L86 30 L82 70 Z", "M18 76 L82 76 L82 84 L18 84 Z"],
  ghost: ["M28 86 L28 46 C28 30 38 18 50 18 C62 18 72 30 72 46 L72 86 L64 78 L57 86 L50 78 L43 86 L36 78 Z"],
};

function framePath(frame: Frame, c: number, r: number): Path2D {
  const p = new Path2D();
  if (frame === "ring") { p.arc(c, c, r, 0, Math.PI * 2); return p; }
  if (frame === "burst") {
    const n = 28;
    for (let i = 0; i <= n * 2; i++) {
      const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
      const rr = i % 2 === 0 ? r : r * 0.92;
      const x = c + rr * Math.cos(a), y = c + rr * Math.sin(a);
      if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
    }
    p.closePath(); return p;
  }
  if (frame === "hex") {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      const x = c + r * Math.cos(a), y = c + r * Math.sin(a);
      if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
    }
    p.closePath(); return p;
  }
  // shield: flat top, pointed base
  const w = r * 0.9, top = c - r * 0.86;
  p.moveTo(c - w, top + r * 0.06);
  p.quadraticCurveTo(c - w, top, c - w + r * 0.08, top);
  p.lineTo(c + w - r * 0.08, top);
  p.quadraticCurveTo(c + w, top, c + w, top + r * 0.06);
  p.lineTo(c + w, c + r * 0.12);
  p.bezierCurveTo(c + w, c + r * 0.6, c + r * 0.4, c + r * 0.86, c, c + r);
  p.bezierCurveTo(c - r * 0.4, c + r * 0.86, c - w, c + r * 0.6, c - w, c + r * 0.12);
  p.closePath();
  return p;
}

let gameFont: string | null = null;
function fontFamily(): string {
  if (gameFont) return gameFont;
  if (typeof document === "undefined") return "'Barlow Condensed', 'Arial Narrow', sans-serif";
  const v = getComputedStyle(document.documentElement).getPropertyValue("--font-barlow-condensed").trim();
  gameFont = `${v ? v + ", " : ""}'Barlow Condensed', 'Arial Narrow', sans-serif`;
  return gameFont;
}

function drawMotif(ctx: CanvasRenderingContext2D, spec: BadgeSpec, size: number, box: { x: number; y: number; s: number }) {
  const { palette: pl, motif } = spec;
  const k = box.s / 100;
  ctx.save();
  ctx.translate(box.x, box.y);
  ctx.scale(k, k);
  const metal = ctx.createLinearGradient(0, 8, 0, 92);
  metal.addColorStop(0, pl.metal[0]);
  metal.addColorStop(0.55, pl.metal[1]);
  metal.addColorStop(1, pl.accent);
  ctx.fillStyle = metal;
  ctx.strokeStyle = metal;
  ctx.shadowColor = "rgba(0,0,0,.55)";
  ctx.shadowBlur = size * 0.02;
  ctx.shadowOffsetY = size * 0.008;
  const fill = (d: string) => ctx.fill(new Path2D(d));
  if (motif === "wings") {
    fill(PATHS.wings[0]);
    ctx.save(); ctx.translate(100, 0); ctx.scale(-1, 1); fill(PATHS.wings[0]); ctx.restore();
    fill(PATHS.wings[1]);
  } else if (motif === "halo") {
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.ellipse(50, 24, 26, 9, 0, 0, Math.PI * 2); ctx.stroke();
    fill(PATHS.halo[0]);
  } else if (motif === "sun") {
    ctx.beginPath(); ctx.arc(50, 50, 18, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2, l = i % 2 ? 38 : 44;
      ctx.beginPath();
      ctx.moveTo(50 + 24 * Math.cos(a - 0.12), 50 + 24 * Math.sin(a - 0.12));
      ctx.lineTo(50 + l * Math.cos(a), 50 + l * Math.sin(a));
      ctx.lineTo(50 + 24 * Math.cos(a + 0.12), 50 + 24 * Math.sin(a + 0.12));
      ctx.closePath(); ctx.fill();
    }
  } else if (motif === "eye") {
    fill(PATHS.eye[0]);
    ctx.shadowColor = "transparent";
    ctx.fillStyle = pl.bg[0];
    ctx.beginPath(); ctx.arc(50, 50, 15, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = pl.accent;
    ctx.beginPath(); ctx.arc(50, 50, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath(); ctx.arc(54, 46, 3, 0, Math.PI * 2); ctx.fill();
  } else if (motif === "gem") {
    fill(PATHS.gem[0]);
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "rgba(0,0,0,.35)"; ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(26, 38); ctx.lineTo(74, 38);
    ctx.moveTo(38, 20); ctx.lineTo(44, 38); ctx.lineTo(50, 84); ctx.lineTo(56, 38); ctx.lineTo(62, 20);
    ctx.moveTo(44, 38); ctx.lineTo(50, 20); ctx.lineTo(56, 38);
    ctx.stroke();
  } else if (motif === "ghost") {
    fill(PATHS.ghost[0]);
    ctx.shadowColor = "transparent";
    ctx.fillStyle = pl.bg[0];
    ctx.beginPath(); ctx.ellipse(42, 46, 5, 7, 0, 0, Math.PI * 2); ctx.ellipse(58, 46, 5, 7, 0, 0, Math.PI * 2); ctx.fill();
  } else {
    for (const d of PATHS[motif]) fill(d);
  }
  ctx.restore();
}

/** Draw one badge onto a square canvas (browser only). */
export function drawBadge(ctx: CanvasRenderingContext2D, size: number, spec: BadgeSpec) {
  const { palette: pl, frame, letters } = spec;
  const c = size / 2, R = size / 2 - size * 0.015;
  ctx.clearRect(0, 0, size, size);

  // base disc: deep colour, lit from the top left
  const bg = ctx.createRadialGradient(size * 0.36, size * 0.3, size * 0.05, c, c, R);
  bg.addColorStop(0, pl.bg[1]);
  bg.addColorStop(1, pl.bg[0]);
  ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.fillStyle = bg; ctx.fill();

  // fine rays behind the emblem
  ctx.save();
  ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.clip();
  ctx.globalAlpha = 0.1; ctx.fillStyle = pl.accent;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(c, c * 0.84);
    ctx.lineTo(c + R * 1.2 * Math.cos(a - 0.05), c * 0.84 + R * 1.2 * Math.sin(a - 0.05));
    ctx.lineTo(c + R * 1.2 * Math.cos(a + 0.05), c * 0.84 + R * 1.2 * Math.sin(a + 0.05));
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();

  // frame plate + metal edge
  const plateR = R * 0.8;
  const plate = framePath(frame, c, plateR);
  const pg = ctx.createLinearGradient(0, c - plateR, 0, c + plateR);
  pg.addColorStop(0, pl.bg[1]);
  pg.addColorStop(1, pl.bg[0]);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = size * 0.04; ctx.shadowOffsetY = size * 0.015;
  ctx.fillStyle = pg; ctx.fill(plate);
  ctx.restore();
  const edge = ctx.createLinearGradient(0, 0, size, size);
  edge.addColorStop(0, pl.metal[0]); edge.addColorStop(0.5, pl.accent); edge.addColorStop(1, pl.metal[1]);
  ctx.strokeStyle = edge; ctx.lineWidth = size * 0.022; ctx.stroke(plate);
  ctx.strokeStyle = "rgba(255,255,255,.14)"; ctx.lineWidth = size * 0.006; ctx.stroke(framePath(frame, c, plateR * 0.9));

  // outer ring
  ctx.beginPath(); ctx.arc(c, c, R - size * 0.012, 0, Math.PI * 2);
  ctx.strokeStyle = pl.accent; ctx.globalAlpha = 0.55; ctx.lineWidth = size * 0.01; ctx.stroke(); ctx.globalAlpha = 1;

  // emblem
  const ms = size * 0.47;
  drawMotif(ctx, spec, size, { x: c - ms / 2, y: size * (frame === "shield" ? 0.15 : 0.14), s: ms });

  // ticker on a ribbon
  const fs = Math.round(size * (letters.length <= 4 ? 0.15 : letters.length <= 6 ? 0.12 : 0.1));
  ctx.font = `800 ${fs}px ${fontFamily()}`;
  const tw = ctx.measureText(letters).width;
  const ry = size * 0.72, rh = fs * 1.25, rw = Math.min(size * 0.78, tw + fs * 1.1);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.5)"; ctx.shadowBlur = size * 0.02; ctx.shadowOffsetY = size * 0.006;
  const rib = ctx.createLinearGradient(0, ry - rh / 2, 0, ry + rh / 2);
  rib.addColorStop(0, pl.metal[0]); rib.addColorStop(1, pl.metal[1]);
  ctx.fillStyle = rib;
  ctx.beginPath();
  ctx.moveTo(c - rw / 2 - fs * 0.35, ry - rh / 2); ctx.lineTo(c + rw / 2 + fs * 0.35, ry - rh / 2);
  ctx.lineTo(c + rw / 2, ry); ctx.lineTo(c + rw / 2 + fs * 0.35, ry + rh / 2);
  ctx.lineTo(c - rw / 2 - fs * 0.35, ry + rh / 2); ctx.lineTo(c - rw / 2, ry); ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = pl.bg[0];
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(letters, c, ry + fs * 0.04);

  // gloss: soft highlight top left, shade bottom right
  ctx.save();
  ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.clip();
  const gl = ctx.createRadialGradient(size * 0.3, size * 0.2, 0, size * 0.3, size * 0.2, size * 0.6);
  gl.addColorStop(0, "rgba(255,255,255,.22)"); gl.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gl; ctx.fillRect(0, 0, size, size);
  const sh = ctx.createRadialGradient(size * 0.75, size * 0.85, 0, size * 0.75, size * 0.85, size * 0.6);
  sh.addColorStop(0, "rgba(0,0,0,.28)"); sh.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = sh; ctx.fillRect(0, 0, size, size);
  ctx.restore();
}

/** PNG data URI of one badge, or null without a canvas (SSR / tests). */
export function badgeDataUri(spec: BadgeSpec, size = BADGE_SIZE): string | null {
  if (typeof document === "undefined") return null;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  drawBadge(ctx, size, spec);
  return cv.toDataURL("image/png");
}
