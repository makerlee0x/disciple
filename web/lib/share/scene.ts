/**
 * Share card scene, one renderer for every surface:
 *   server PNG (/api/share/card via @napi-rs/canvas) · client video end card (lib/share/video.ts).
 * Look: the game's own tier sky plate (FLIGHT_TIERS[i].sky from lib/flight/tiers.ts, the same list engine.js embeds) graded down into a
 * liminal haze, the pilot's skinned rocket (rocket.png + skin tint + nose coin + thruster colours from the Rocket
 * Factory loadout) climbing through it, film grain, vignette, and heavy Geist type with a glowing +$.
 * Pure canvas 2D: no DOM, no fetch. Callers pass loaded images and a canvas factory.
 */
import { fmtMcap, fmtMoney } from "./format";
import { FLIGHT_TIERS, tierIndexAt } from "@/lib/flight/tiers";
import { defaultUsername } from "@/lib/defaultUsername";
import { RAMPS, applyRamp } from "@/lib/hullRamp";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ctx = any; // CanvasRenderingContext2D | @napi-rs/canvas SKRSContext2D
type Cv = { width: number; height: number; getContext(k: "2d"): Ctx };
export type MakeCanvas = (w: number, h: number) => Cv;
type Img = any; // drawable

/** Tier ladder: single source lib/flight/tiers.ts (added by #50 — this PR depends on it). */
export function tierAt(mcap: number) { const index = tierIndexAt(mcap); return { index, ...FLIGHT_TIERS[index] }; }

export interface Loadout { skin: { tint: string | null; mode?: "color" | "multiply"; strength?: number; sheen?: string; ramp?: string }; coin: { bg: [string, string]; ink: string; glyph: string; rim: string; id: string }; thruster: { core: string; flame: string } }
export interface SceneData {
  gainUsd: number; gainPct: number; kind: "unrealized" | "realized" | "none";
  ticker: string; mcapStart: number; mcapEnd: number; endTs: number;
  username: string | null; refLabel: string; sample: boolean;
  /** Guilds V1: the player's guild tag ("BONK"), drawn as a quiet chip after the name. Optional; never on SAMPLE cards. */
  guildTag?: string | null;
  /** player wallet: no username → footer shows its space-themed default call sign (lib/defaultUsername) */
  wallet?: string | null;
  fills: { side: string; mcapUsd: number }[];
  /** flight log stats (lib/flightLog.ts, from the fills); absent = tiles show "—" and the peak comes from the fills above */
  log?: { peakMcap: number | null; bombsSurvived: number; wingmen: number; slingshots: number; xp: number } | null;
  /** difficulty badge: EASY / HARD / EXPERT (or IN ORBIT), with its colour */
  badge?: { text: string; color: string } | null;
}
/** coinIcon: the coin's own moderated image (lib/server/share/coinIcon). None ⇒ the ticker block draws as before. */
export interface SceneAssets { bg: Img | null; rocket: Img | null; wordmark?: Img | null; coinIcon?: Img | null; /** untinted chrome rocket for the wingmen ships */ wing?: Img | null }
export const FONT = { black: "GeistBlack", mono: "GeistMonoBold", monoMed: "GeistMonoMed", game600: "BarlowCondensedSemiBold", game700: "BarlowCondensedBold", game800: "BarlowCondensedExtraBold", ui600: "InterSemiBold" };

const GREEN = "#5FF0A0", RED = "#F0307F";

/* ---------------- rocket (server-safe port of lib/rocketSkin tintBase + decal roundel) ---------------- */
export function composeRocket(mk: MakeCanvas, base: Img, lo: Loadout, scale = 4): Cv {
  const w = base.width * scale, h = base.height * scale;
  const c = mk(w, h), o = c.getContext("2d");
  o.imageSmoothingQuality = "high";
  o.drawImage(base, 0, 0, w, h);
  const sk = lo.skin;
  const ramp = sk.ramp ? RAMPS[sk.ramp] : undefined;
  if (ramp) { const im = o.getImageData(0, 0, w, h); applyRamp(im.data, ramp); o.putImageData(im, 0, 0); }
  else if (sk.tint) {
    o.globalAlpha = sk.strength ?? 0.85; o.globalCompositeOperation = sk.mode === "multiply" ? "multiply" : "color";
    o.fillStyle = sk.tint; o.fillRect(0, 0, w, h);
    if (sk.mode !== "multiply") { o.globalAlpha = 0.35; o.globalCompositeOperation = "overlay"; o.fillRect(0, 0, w, h); }
    o.globalAlpha = 1; o.globalCompositeOperation = "destination-in"; o.drawImage(base, 0, 0, w, h);
    if (sk.sheen) {
      o.globalCompositeOperation = "source-atop";
      const g = o.createLinearGradient(0, 0, w, 0); g.addColorStop(0.25, "rgba(255,255,255,0)"); g.addColorStop(0.38, sk.sheen); g.addColorStop(0.5, "rgba(255,255,255,0)");
      o.fillStyle = g; o.fillRect(0, 0, w, h);
    }
    o.globalCompositeOperation = "source-over";
  }
  // nose coin roundel (decal.ts MID geometry), squashed to wrap the hull
  const cx = 0.5 * w, cy = 0.47 * h, r = 0.2 * w;
  o.save(); o.translate(cx, cy); o.transform(0.88, 0, 0, 1, 0, 0);
  o.beginPath(); o.arc(0, 0, r, 0, Math.PI * 2); o.closePath(); o.save(); o.clip();
  const g = o.createRadialGradient(-r * 0.2, -r * 0.3, 0, 0, 0, r); g.addColorStop(0, lo.coin.bg[0]); g.addColorStop(1, lo.coin.bg[1]);
  o.fillStyle = g; o.fillRect(-r, -r, 2 * r, 2 * r);
  if (lo.coin.id === "halo") { o.strokeStyle = "#7a5a10"; o.lineWidth = r * 0.14; o.beginPath(); o.ellipse(0, -r * 0.42, r * 0.56, r * 0.18, 0, 0, 7); o.stroke(); }
  if (/^[A-Za-z0-9]$/.test(lo.coin.glyph)) { o.fillStyle = lo.coin.ink; o.font = `${r * 0.95}px ${FONT.black}`; o.textAlign = "center"; o.textBaseline = "middle"; o.fillText(lo.coin.glyph, 0, r * 0.22); }
  else { o.fillStyle = lo.coin.ink; o.globalAlpha = 0.9; star(o, 0, 0, r * 0.5, lo.coin.id); o.globalAlpha = 1; }
  // shading so it reads painted-on
  const sh = o.createLinearGradient(-r, 0, r, 0); sh.addColorStop(0, "rgba(0,0,0,.35)"); sh.addColorStop(0.45, "rgba(255,255,255,.18)"); sh.addColorStop(1, "rgba(0,0,0,.45)");
  o.fillStyle = sh; o.fillRect(-r, -r, 2 * r, 2 * r);
  o.restore(); o.lineWidth = Math.max(2, r * 0.12); o.strokeStyle = lo.coin.rim; o.stroke(); o.restore();
  return c;
}
/** simple vector stand-ins for emoji glyphs (no emoji font on the server) */
function star(o: Ctx, x: number, y: number, r: number, id: string) {
  o.beginPath();
  if (id === "moon") { o.arc(x, y, r, 0.3 * Math.PI, 1.7 * Math.PI, false); o.arc(x + r * 0.45, y, r * 0.8, 1.6 * Math.PI, 0.4 * Math.PI, true); }
  else if (id === "diamond") { o.moveTo(x, y - r); o.lineTo(x + r * 0.7, y); o.lineTo(x, y + r); o.lineTo(x - r * 0.7, y); }
  else if (id === "sun") { o.arc(x, y, r * 0.5, 0, 7); for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4; o.moveTo(x + Math.cos(a) * r * 0.65, y + Math.sin(a) * r * 0.65); o.arc(x + Math.cos(a) * r * 0.85, y + Math.sin(a) * r * 0.85, r * 0.12, 0, 7); } }
  else { for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4 - Math.PI / 2, rr = k % 2 ? r * 0.32 : r; o.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } }
  o.closePath(); o.fill();
}

/* ---------------- helpers ---------------- */
function cover(ctx: Ctx, im: Img, x: number, y: number, w: number, h: number, zoom = 1, fx = 0.5, fy = 0.5) {
  const s = Math.max(w / im.width, h / im.height) * zoom, dw = im.width * s, dh = im.height * s;
  ctx.drawImage(im, x + (w - dw) * fx, y + (h - dh) * fy, dw, dh);
}
function fitText(ctx: Ctx, text: string, font: (px: number) => string, maxW: number, maxPx: number) {
  let px = maxPx; ctx.font = font(px); while (px > 20 && ctx.measureText(text).width > maxW) { px -= 4; ctx.font = font(px); } return px;
}
function tracked(ctx: Ctx, text: string, x: number, y: number, track: number, align: "left" | "right" = "left") {
  const w = Array.from(text).reduce((s, ch) => s + ctx.measureText(ch).width + track, -track);
  let cx = align === "right" ? x - w : x; for (const ch of Array.from(text)) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + track; }
  return w;
}

/* ---------------- scene ---------------- */
export interface DrawOpts { format: "story" | "og"; /** 0..1 intro progress for the video end card (1 = final still) */ t?: number; seed?: number }

/**
 * Flight log card (approved mockup "Flight log share card", maker Nov 13): the tier sky you peaked in, your rocket with its
 * gold trail and your wingmen's ships, PEAK ALTITUDE + the tier ride, the gain, and four stat tiles (bombs survived,
 * wingmen, slingshots, XP), all from the fills (lib/flightLog.ts). Barlow Condensed (game face) + Inter for the link pill.
 */
const CHAMP = "#F3DFA8", PEARL = "#FFF6DC", GOLD = "#F2C14E", DIM = "rgba(215,217,228,0.85)", DOWN_SOFT = "#FF9CC4";
const WING_COLS = ["242,193,78", "68,212,226", "255,122,61", "95,240,160", "200,196,255", "255,156,196", "243,223,168", "68,212,226", "255,122,61", "95,240,160", "200,196,255", "255,156,196"];
type Lay = {
  pad: number; headTop: number; headW: number; wordPx: number; datePx: number; rule: number | null;
  coinTop: number; iconPx: number; tickPx: number; badgePx: number;
  peakTop: number; peakLbl: number; peakPx: number; tierFrom: number; tierTo: number; arrowW: number;
  resTop: number; gainPx: number; pctPx: number; statusPx: number; statusTop: number | null;
  tilesTop: number; tilesW: number; tileGap: number; tilePad: number; tileLbl: number; tileVal: number; tileR: number;
  footBottom: number; avatar: number; namePx: number; pillPx: number; pillPadX: number; pillPadY: number; pillLead: string;
  rocket: [number, number, number, number]; trailW: number; trailL: number; flame: [number, number]; glow: [number, number, number];
  slots: [number, number, number][]; wingTrail: number;
};
const STORY: Lay = {
  pad: 72, headTop: 72, headW: 936, wordPx: 44, datePx: 28, rule: 136,
  coinTop: 196, iconPx: 84, tickPx: 96, badgePx: 28,
  peakTop: 1060, peakLbl: 30, peakPx: 210, tierFrom: 34, tierTo: 52, arrowW: 64,
  resTop: 1430, gainPx: 120, pctPx: 64, statusPx: 30, statusTop: null,
  tilesTop: 1590, tilesW: 936, tileGap: 16, tilePad: 22, tileLbl: 22, tileVal: 64, tileR: 20,
  footBottom: 64, avatar: 56, namePx: 38, pillPx: 26, pillPadX: 24, pillPadY: 14, pillLead: "Board my rocket · ",
  rocket: [570, 330, 230, 680], trailW: 16, trailL: 760, flame: [70, 110], glow: [800, 660, 280],
  slots: [[420, 520, 0.62], [860, 560, 0.6], [330, 760, 0.5], [930, 800, 0.52], [470, 900, 0.44], [820, 960, 0.42], [250, 520, 0.4], [990, 460, 0.4], [360, 330, 0.36], [880, 330, 0.36], [180, 700, 0.34], [1010, 680, 0.34]], wingTrail: 260,
};
const SQUARE: Lay = {
  pad: 64, headTop: 64, headW: 620, wordPx: 36, datePx: 24, rule: null,
  coinTop: 150, iconPx: 64, tickPx: 72, badgePx: 24,
  peakTop: 280, peakLbl: 26, peakPx: 170, tierFrom: 28, tierTo: 44, arrowW: 52,
  resTop: 610, gainPx: 104, pctPx: 54, statusPx: 26, statusTop: 730,
  tilesTop: 800, tilesW: 640, tileGap: 12, tilePad: 16, tileLbl: 17, tileVal: 48, tileR: 16,
  footBottom: 52, avatar: 48, namePx: 32, pillPx: 22, pillPadX: 20, pillPadY: 12, pillLead: "",
  rocket: [765, 170, 180, 530], trailW: 13, trailL: 520, flame: [56, 88], glow: [870, 370, 230],
  slots: [[700, 330, 0.5], [1010, 360, 0.5], [660, 520, 0.42], [1040, 560, 0.42], [760, 640, 0.36], [980, 700, 0.36], [620, 200, 0.32], [1050, 200, 0.32], [700, 760, 0.3], [960, 820, 0.3], [600, 640, 0.28], [1060, 440, 0.28]], wingTrail: 200,
};
const BC = (w: 600 | 700 | 800, px: number) => `${px}px ${w === 800 ? FONT.game800 : w === 700 ? FONT.game700 : FONT.game600}`;
const money = (v: number) => fmtMoney(v).replace(/^-/, "−");
const pctTxt = (v: number) => `${v < 0 ? "−" : "+"}${Math.abs(v) >= 10 ? Math.round(Math.abs(v)) : Math.abs(v).toFixed(1)}%`;
const dayLabel = (ms: number) => new Date(ms).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" }).toUpperCase();
function rrect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
/** a rocket box (CSS: left/top/w/h, rotate about its centre) with its trail out of the nozzle (92% down) and a flame glow */
function ship(ctx: Ctx, im: Img | null, x: number, y: number, w: number, h: number, deg: number, alpha: number, trail: { w: number; l: number; col: string; head: string }, flame: { w: number; h: number; col: string }, shadow?: string) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x + w / 2, y + h / 2); ctx.rotate((deg * Math.PI) / 180); ctx.translate(-w / 2, -h / 2);
  const ty = h * 0.92, tg = ctx.createLinearGradient(0, ty, 0, ty + trail.l);
  tg.addColorStop(0, trail.head); tg.addColorStop(0.13, `rgba(${trail.col},0.82)`); tg.addColorStop(1, `rgba(${trail.col},0)`);
  ctx.fillStyle = tg; rrect(ctx, w / 2 - trail.w / 2, ty, trail.w, trail.l, trail.w / 2); ctx.fill();
  const fy = h * 0.9 + flame.h / 2, fg = ctx.createRadialGradient(w / 2, fy, 0, w / 2, fy, flame.h / 2);
  fg.addColorStop(0, "rgba(255,246,220,1)"); fg.addColorStop(0.45, `rgba(${flame.col},0.7)`); fg.addColorStop(1, `rgba(${flame.col},0)`);
  ctx.save(); ctx.translate(w / 2, fy); ctx.scale(flame.w / flame.h, 1); ctx.translate(-w / 2, -fy); ctx.fillStyle = fg; ctx.fillRect(w / 2 - flame.h / 2, fy - flame.h / 2, flame.h, flame.h); ctx.restore();
  if (im) {
    const k = Math.min(w / im.width, h / im.height), dw = im.width * k, dh = im.height * k;
    if (shadow) { ctx.shadowColor = shadow; ctx.shadowBlur = 40; }
    ctx.drawImage(im, (w - dw) / 2, (h - dh) / 2, dw, dh); ctx.shadowBlur = 0;
  }
  ctx.restore();
}

/** the card's peak: the flight log's (highest mcap while aboard), else the highest the fills show */
export const scenePeak = (d: SceneData) => d.log?.peakMcap ?? Math.max(d.mcapStart || 0, d.mcapEnd || 0, ...d.fills.map((f) => f.mcapUsd || 0));

export function drawShareScene(ctx: Ctx, mk: MakeCanvas, d: SceneData, a: SceneAssets, lo: Loadout, o: DrawOpts) {
  void mk; void lo;
  const story = o.format === "story", W = 1080, H = story ? 1920 : 1080, t = o.t ?? 1, Y = story ? STORY : SQUARE, L = Y.pad;
  const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  const log = d.log, peak = scenePeak(d);
  const pt = tierAt(peak), st = tierAt(d.mcapStart || peak);
  const up = d.gainUsd >= 0, good = up && d.kind !== "none";
  ctx.save(); ctx.textBaseline = "top";
  ctx.fillStyle = "#121327"; ctx.fillRect(0, 0, W, H);

  // sky: the tier you peaked in, dimmed (brightness .8, saturate .85), then the scrim
  if (a.bg) { ctx.save(); ctx.filter = "saturate(0.85) brightness(0.8)"; cover(ctx, a.bg, 0, 0, W, H, 1, story ? 0.5 : 0.6, 0.4); ctx.restore(); }
  const g = story ? ctx.createLinearGradient(0, 0, 0, H) : ctx.createLinearGradient(0, 0, W, 0);
  if (story) { g.addColorStop(0, "rgba(18,19,39,0.55)"); g.addColorStop(0.3, "rgba(18,19,39,0.05)"); g.addColorStop(0.52, "rgba(18,19,39,0.2)"); g.addColorStop(0.74, "rgba(11,12,14,0.92)"); g.addColorStop(1, "#0B0C0E"); }
  else { g.addColorStop(0, "rgba(11,12,14,0.94)"); g.addColorStop(0.46, "rgba(11,12,14,0.78)"); g.addColorStop(0.72, "rgba(18,19,39,0.1)"); g.addColorStop(1, "rgba(18,19,39,0.1)"); }
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  { const [gx, gy, gr] = Y.glow, rg = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
    rg.addColorStop(0, `rgba(255,246,220,${story ? 0.32 : 0.3})`); rg.addColorStop(0.4, "rgba(242,193,78,0.10)"); rg.addColorStop(0.7, "rgba(242,193,78,0)"); rg.addColorStop(1, "rgba(242,193,78,0)");
    ctx.fillStyle = rg; ctx.fillRect(gx - gr, gy - gr, gr * 2, gr * 2); }

  // wingmen: one ship per pilot who boosted while you were aboard (up to 12), each with its own trail
  const wing = a.wing ?? null, n = Math.max(0, Math.min(12, log?.wingmen ?? 0));
  for (let i = 0; i < n; i++) {
    const [x, y, s] = Y.slots[i], w = Math.round(221 * s * 0.45), h = Math.round(609 * s * 0.45), c = WING_COLS[i];
    ship(ctx, wing, x - w / 2, y + 20 * (1 - ease(t * 1.3)), w, h, i % 2 ? 6 : 10, 0.55 + s * 0.4, { w: 4, l: Y.wingTrail, col: c, head: "rgba(255,246,220,0.95)" }, { w: 14, h: 22, col: c });
  }
  // your rocket (your hull) with the gold trail
  { const [x, y, w, h] = Y.rocket;
    ship(ctx, a.rocket, x, y + 40 * (1 - ease(t * 1.4)), w, h, 8, 1, { w: Y.trailW, l: Y.trailL, col: "242,193,78", head: "rgba(255,246,220,1)" }, { w: Y.flame[0], h: Y.flame[1], col: "242,193,78" }, `rgba(242,193,78,${good ? 0.35 : 0.18})`); }

  // header: DISCIPLE · FLIGHT LOG · <day>
  ctx.fillStyle = "#F2F3F7"; ctx.font = BC(800, Y.wordPx); tracked(ctx, "DISCIPLE", L, Y.headTop, Y.wordPx * 0.22);
  ctx.fillStyle = CHAMP; ctx.font = BC(600, Y.datePx); tracked(ctx, `FLIGHT LOG · ${dayLabel(d.endTs || Date.now())}`, L + Y.headW, Y.headTop + (Y.wordPx - Y.datePx) / 2, Y.datePx * 0.14, "right");
  if (Y.rule !== null) { ctx.fillStyle = "rgba(243,223,168,0.35)"; ctx.fillRect(L, Y.rule, W - 2 * L, 2); }
  if (d.sample) { ctx.save(); ctx.translate(W - L - 120, Y.coinTop + 20); ctx.rotate(0.05); ctx.fillStyle = "#FFD84D"; ctx.fillRect(-120, -26, 240, 46); ctx.fillStyle = "#0a0a0a"; ctx.font = BC(800, 26); tracked(ctx, "SAMPLE DATA", -96, -14, 4); ctx.restore(); }

  // coin row: icon (the coin's own, else a gold disc with its initial), $TICKER, difficulty badge
  { const I = Y.iconPx, cy = Y.coinTop, ic = a.coinIcon;
    ctx.save(); ctx.beginPath(); ctx.arc(L + I / 2, cy + I / 2, I / 2, 0, Math.PI * 2); ctx.closePath();
    if (ic) { ctx.clip(); const k = Math.max(I / ic.width, I / ic.height); ctx.drawImage(ic, L + (I - ic.width * k) / 2, cy + (I - ic.height * k) / 2, ic.width * k, ic.height * k); }
    else { const cg = ctx.createRadialGradient(L + I * 0.35, cy + I * 0.3, 0, L + I / 2, cy + I / 2, I * 0.6); cg.addColorStop(0, PEARL); cg.addColorStop(0.55, GOLD); cg.addColorStop(1, "#8A6420"); ctx.fillStyle = cg; ctx.fill();
      ctx.fillStyle = "#121327"; ctx.font = BC(800, Math.round(I * 0.52)); ctx.textAlign = "center"; ctx.fillText((d.ticker[0] || "?").toUpperCase(), L + I / 2, cy + I * 0.2); ctx.textAlign = "left"; }
    ctx.restore();
    const tx = L + I + 20, tickMax = (story ? W - 2 * L : Y.headW) - I - 20 - (d.badge ? 160 : 0);
    ctx.fillStyle = "#F2F3F7"; const tp = fitText(ctx, `$${d.ticker}`, (px) => BC(800, px), tickMax, Y.tickPx);
    const tty = cy + (I - tp) / 2; ctx.fillText(`$${d.ticker}`, tx, tty);
    if (d.badge) { const bx = tx + ctx.measureText(`$${d.ticker}`).width + 20, bp = Y.badgePx; ctx.font = BC(700, bp);
      const bw = Array.from(d.badge.text).reduce((s2, ch) => s2 + ctx.measureText(ch).width + bp * 0.12, -bp * 0.12) + (story ? 28 : 24), bh = bp + (story ? 16 : 12), by = cy + (I - bh) / 2;
      ctx.strokeStyle = hexA(d.badge.color, 0.7); ctx.lineWidth = 2; rrect(ctx, bx, by, bw, bh, story ? 10 : 9); ctx.stroke();
      ctx.fillStyle = d.badge.color; tracked(ctx, d.badge.text, bx + (story ? 14 : 12), by + (bh - bp) / 2 + 1, bp * 0.12); } }

  // PEAK ALTITUDE + the tier ride
  const fade = ease(t * 1.6);
  ctx.save(); ctx.globalAlpha = fade;
  ctx.fillStyle = DIM; ctx.font = BC(600, Y.peakLbl); tracked(ctx, "PEAK ALTITUDE", L, Y.peakTop, Y.peakLbl * 0.16);
  const pkY = Y.peakTop + Y.peakLbl * 1.2 + 6, pk = fmtMcap(peak);
  ctx.font = BC(800, Y.peakPx); ctx.shadowColor = "rgba(242,193,78,0.35)"; ctx.shadowBlur = 40; ctx.fillStyle = PEARL; ctx.fillText(pk, L - Y.peakPx * 0.02, pkY - Y.peakPx * 0.07); ctx.shadowBlur = 0;
  const trY = pkY + Y.peakPx * 0.86 + 10, toH = Y.tierTo, mid = trY + toH * 0.6;
  if (st.index < pt.index) {
    ctx.font = BC(700, Y.tierFrom); ctx.fillStyle = "rgba(215,217,228,0.7)"; const fw = tracked(ctx, st.name, L, mid - Y.tierFrom * 0.6, Y.tierFrom * 0.08);
    const ax = L + fw + 18, aw = Y.arrowW; ctx.strokeStyle = GOLD; ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(ax + 2, mid); ctx.lineTo(ax + aw - 6, mid); ctx.moveTo(ax + aw - 16, mid - 8); ctx.lineTo(ax + aw - 6, mid); ctx.lineTo(ax + aw - 16, mid + 8); ctx.stroke();
    ctx.font = BC(800, toH); ctx.fillStyle = CHAMP; tracked(ctx, pt.name, ax + aw + 18, mid - toH * 0.6, toH * 0.06);
  } else {
    ctx.font = BC(800, toH); ctx.fillStyle = CHAMP; const tw = tracked(ctx, pt.name, L, mid - toH * 0.6, toH * 0.06);
    const next = FLIGHT_TIERS[pt.index + 1];
    if (next && pt.hi > pt.lo) { const share = Math.round(Math.max(0, Math.min(0.99, (peak - pt.lo) / (pt.hi - pt.lo))) * 100);
      ctx.font = BC(700, Y.tierFrom); ctx.fillStyle = "rgba(215,217,228,0.7)"; tracked(ctx, `· ${share}% OF THE WAY TO ${next.name}`, L + tw + 18, mid - Y.tierFrom * 0.6, Y.tierFrom * 0.08); }
  }
  ctx.restore();

  // the gain (same PnL as before) + status
  ctx.save(); ctx.globalAlpha = ease(t * 1.6 - 0.2);
  const gTxt = money(d.gainUsd), pTxt = pctTxt(d.gainPct), gc = up ? GREEN : RED;
  ctx.font = BC(800, Y.gainPx); ctx.shadowColor = hexA(gc, 0.35); ctx.shadowBlur = 30; ctx.fillStyle = gc; ctx.fillText(gTxt, L, Y.resTop); ctx.shadowBlur = 0;
  const gw = ctx.measureText(gTxt).width; ctx.font = BC(700, Y.pctPx); ctx.fillStyle = up ? GREEN : DOWN_SOFT; ctx.fillText(pTxt, L + gw + (story ? 24 : 20), Y.resTop + (Y.gainPx - Y.pctPx) * 0.78);
  const status = d.kind === "realized" ? "CASHED OUT" : d.kind === "none" ? "NO BAG YET" : "STILL ABOARD";
  ctx.font = BC(700, Y.statusPx); ctx.fillStyle = CHAMP;
  if (Y.statusTop === null) tracked(ctx, status, W - L, Y.resTop + Y.gainPx * 0.8 - Y.statusPx * 0.8, Y.statusPx * 0.12, "right");
  else tracked(ctx, status, L, Y.statusTop, Y.statusPx * 0.12);
  ctx.restore();

  // four tiles: bombs survived · wingmen · slingshots · XP earned
  ctx.save(); ctx.globalAlpha = ease(t * 1.6 - 0.4);
  const tiles: [string, string, boolean][] = [["BOMBS SURVIVED", log ? String(log.bombsSurvived) : "—", false], ["WINGMEN", log ? String(log.wingmen) : "—", false], ["SLINGSHOTS", log ? String(log.slingshots) : "—", false], ["XP EARNED", log ? `+${log.xp}` : "—", true]];
  const tw4 = (Y.tilesW - 3 * Y.tileGap) / 4, th = Y.tilePad * 2 + Y.tileLbl * 1.2 + 10 + Y.tileVal;
  tiles.forEach(([lbl, val, xp], k) => {
    const x = L + k * (tw4 + Y.tileGap), y = Y.tilesTop;
    rrect(ctx, x + 0.5, y + 0.5, tw4 - 1, th - 1, Y.tileR); ctx.fillStyle = story ? "rgba(22,24,28,0.82)" : "rgba(22,24,28,0.85)"; ctx.fill();
    ctx.strokeStyle = xp ? "rgba(243,223,168,0.35)" : "#2E323A"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = DIM; ctx.font = BC(600, Y.tileLbl); tracked(ctx, lbl, x + Y.tilePad, y + Y.tilePad, Y.tileLbl * (story ? 0.12 : 0.1));
    ctx.fillStyle = xp ? GOLD : "#F2F3F7"; ctx.font = BC(800, Y.tileVal); ctx.fillText(val, x + Y.tilePad, y + Y.tilePad + Y.tileLbl * 1.2 + 10 - Y.tileVal * 0.08);
  });
  ctx.restore();

  // footer: avatar + @name (guild chip) · gold "Board my rocket" pill
  const who = d.username ? `@${d.username}` : defaultUsername(d.wallet) || d.refLabel.split("/r/")[1] || "";
  const fyC = H - Y.footBottom - Math.max(Y.avatar, Y.pillPx + 2 * Y.pillPadY) / 2, A = Y.avatar;
  ctx.beginPath(); ctx.arc(L + A / 2, fyC, A / 2 - 1, 0, Math.PI * 2); ctx.fillStyle = "#26274B"; ctx.fill(); ctx.strokeStyle = "#3D4A79"; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = CHAMP; ctx.font = BC(700, Math.round(A * 0.46)); ctx.textAlign = "center";
  ctx.fillText(who.replace(/^@/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase(), L + A / 2, fyC - A * 0.27); ctx.textAlign = "left";
  ctx.fillStyle = "#F2F3F7"; ctx.font = BC(700, Y.namePx); ctx.fillText(who, L + A + 16, fyC - Y.namePx * 0.58);
  if (d.guildTag && /^[A-Z0-9]{2,5}$/.test(d.guildTag)) {
    const nx = L + A + 16 + ctx.measureText(who).width + 14; ctx.font = BC(700, Math.round(Y.namePx * 0.62));
    const cw = ctx.measureText(d.guildTag).width + 20, ch = Math.round(Y.namePx * 0.95);
    ctx.strokeStyle = "rgba(243,223,168,0.45)"; ctx.lineWidth = 2; rrect(ctx, nx, fyC - ch / 2, cw, ch, 8); ctx.stroke();
    ctx.fillStyle = CHAMP; ctx.fillText(d.guildTag, nx + 10, fyC - Y.namePx * 0.36);
  }
  { const txt = Y.pillLead + d.refLabel; ctx.font = `${Y.pillPx}px ${FONT.ui600}`;
    const pw = ctx.measureText(txt).width + 2 * Y.pillPadX, ph = Y.pillPx * 1.2 + 2 * Y.pillPadY;
    rrect(ctx, W - L - pw, fyC - ph / 2, pw, ph, ph / 2); ctx.fillStyle = GOLD; ctx.fill();
    ctx.fillStyle = "#121327"; ctx.fillText(txt, W - L - pw + Y.pillPadX, fyC - Y.pillPx * 0.55); }
  ctx.restore();
}

function hexA(hex: string, a: number) {
  const h = hex.replace("#", ""); const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
