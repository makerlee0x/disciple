/**
 * Share card scene, one renderer for every surface:
 *   server PNG (/api/share/card via @napi-rs/canvas) · client video end card (lib/share/video.ts).
 * Look: the game's own tier sky plate (FLIGHT_TIERS[i].sky from lib/flight/tiers.ts, the same list engine.js embeds) graded down into a
 * liminal haze, the pilot's skinned rocket (rocket.png + skin tint + nose coin + thruster colours from the Rocket
 * Factory loadout) climbing through it, film grain, vignette, and heavy Geist type with a glowing +$.
 * Pure canvas 2D: no DOM, no fetch. Callers pass loaded images and a canvas factory.
 */
import { fmtCt, fmtMcap, fmtMoney, fmtPct } from "./format";
import { FLIGHT_TIERS, tierIndexAt } from "@/lib/flight/tiers";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ctx = any; // CanvasRenderingContext2D | @napi-rs/canvas SKRSContext2D
type Cv = { width: number; height: number; getContext(k: "2d"): Ctx };
export type MakeCanvas = (w: number, h: number) => Cv;
type Img = any; // drawable

/** Tier ladder: single source lib/flight/tiers.ts (added by #50 — this PR depends on it). */
export function tierAt(mcap: number) { const index = tierIndexAt(mcap); return { index, ...FLIGHT_TIERS[index] }; }

export interface Loadout { skin: { tint: string | null; mode?: "color" | "multiply"; strength?: number; sheen?: string }; coin: { bg: [string, string]; ink: string; glyph: string; rim: string; id: string }; thruster: { core: string; flame: string } }
export interface SceneData {
  gainUsd: number; gainPct: number; kind: "unrealized" | "realized" | "none";
  ticker: string; mcapStart: number; mcapEnd: number; endTs: number;
  username: string | null; refLabel: string; sample: boolean;
  fills: { side: string; mcapUsd: number }[];
}
export interface SceneAssets { bg: Img | null; rocket: Img | null }
export const FONT = { black: "GeistBlack", mono: "GeistMonoBold", monoMed: "GeistMonoMed" };

const GREEN = "#47ff7e", RED = "#ff4040", INK = "#f6f1e4";

/* ---------------- rocket (server-safe port of lib/rocketSkin tintBase + decal roundel) ---------------- */
export function composeRocket(mk: MakeCanvas, base: Img, lo: Loadout, scale = 4): Cv {
  const w = base.width * scale, h = base.height * scale;
  const c = mk(w, h), o = c.getContext("2d");
  o.imageSmoothingQuality = "high";
  o.drawImage(base, 0, 0, w, h);
  const sk = lo.skin;
  if (sk.tint) {
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
function seeded(seed: number) { let a = seed >>> 0 || 1; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const grainCache = new Map<string, Cv>();
function grainTile(mk: MakeCanvas, seed = 7): Cv {
  const k = String(seed); const hit = grainCache.get(k); if (hit) return hit;
  const S = 256, c = mk(S, S), g = c.getContext("2d"), id = g.createImageData(S, S), rnd = seeded(seed);
  for (let i = 0; i < id.data.length; i += 4) { const v = rnd() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 30 + rnd() * 26; }
  g.putImageData(id, 0, 0); grainCache.set(k, c); return c;
}
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

export function drawShareScene(ctx: Ctx, mk: MakeCanvas, d: SceneData, a: SceneAssets, lo: Loadout, o: DrawOpts) {
  const story = o.format === "story", W = 1080, H = story ? 1920 : 1080, t = o.t ?? 1;
  const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  const tier = tierAt(d.mcapEnd);
  const up = d.gainUsd >= 0, accent = up ? GREEN : RED;
  ctx.save();
  ctx.fillStyle = "#07070b"; ctx.fillRect(0, 0, W, H);

  // 1) far sky: tier plate, soft + slightly oversized (depth), drifting with t
  if (a.bg) {
    ctx.save(); ctx.filter = "blur(10px) saturate(1.15)"; ctx.globalAlpha = 0.9; cover(ctx, a.bg, -40, -40, W + 80, H + 80, 1.18, 0.5, 0.35 + 0.05 * (1 - t)); ctx.restore();
    // near sky: sharper plate masked to the upper area
    ctx.save(); ctx.filter = "saturate(1.2) contrast(1.1)"; ctx.globalAlpha = 0.75; cover(ctx, a.bg, 0, 0, W, story ? H * 0.72 : H, 1.02, story ? 0.42 : 0.6, 0.4); ctx.restore();
  }
  // 2) grade: crush to a liminal dusk; colour stays from the plate
  let g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "rgba(6,6,12,.30)"); g.addColorStop(0.4, "rgba(6,6,12,.05)"); g.addColorStop(story ? 0.62 : 0.7, "rgba(6,6,12,.55)"); g.addColorStop(1, "rgba(4,4,8,.97)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // 3) atmospheric haze bands (dreamcore bloom) + god-ray
  ctx.save(); ctx.globalCompositeOperation = "screen";
  const hz = (y: number, r: number, al: number, col: string, x = W * 0.6) => { const rg = ctx.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, `rgba(${col},${al})`); rg.addColorStop(1, `rgba(${col},0)`); ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H); };
  hz(story ? H * 0.2 : H * 0.15, W * 0.9, 0.22, "255,236,200");
  hz(story ? H * 0.5 : H * 0.6, W * 0.7, 0.12, "200,210,255", W * 0.25);
  ctx.globalAlpha = 0.16; ctx.translate(W * 0.75, -40); ctx.rotate(0.32);
  const ray = ctx.createLinearGradient(-160, 0, 160, 0); ray.addColorStop(0, "rgba(255,245,220,0)"); ray.addColorStop(0.5, "rgba(255,245,220,1)"); ray.addColorStop(1, "rgba(255,245,220,0)");
  ctx.fillStyle = ray; ctx.fillRect(-160, 0, 320, H * 1.4); ctx.fillRect(-420, 0, 120, H * 1.4);
  ctx.restore();

  // 4) the rocket: big, tilted, climbing out of the haze; thruster glow from the loadout
  if (a.rocket) {
    const rc = a.rocket, rh = story ? 980 : 760, rw = (rh * rc.width) / rc.height;
    const rx = story ? W * 0.72 : W * 0.76, ry = (story ? H * 0.40 : H * 0.56) + 60 * (1 - ease(t * 1.4)), tilt = 0.2;
    ctx.save(); ctx.translate(rx, ry); ctx.rotate(tilt);
    ctx.globalCompositeOperation = "source-over";
    // rim light + body
    ctx.shadowColor = "rgba(255,236,190,.55)"; ctx.shadowBlur = 60;
    ctx.drawImage(rc, -rw / 2, -rh / 2, rw, rh);
    ctx.shadowBlur = 0;
    // atmospheric perspective: haze over the lower hull
    const fog = ctx.createLinearGradient(0, -rh * 0.1, 0, rh * 0.6); fog.addColorStop(0, "rgba(20,20,30,0)"); fog.addColorStop(1, "rgba(14,14,22,.55)");
    ctx.globalCompositeOperation = "source-atop"; ctx.fillStyle = fog; ctx.fillRect(-rw, -rh, rw * 2, rh * 2);
    ctx.restore();
  }
  // foreground haze over everything below the rocket (depth)
  g = ctx.createLinearGradient(0, story ? H * 0.55 : H * 0.55, 0, H); g.addColorStop(0, "rgba(10,10,16,0)"); g.addColorStop(0.45, "rgba(8,8,12,.78)"); g.addColorStop(1, "rgba(5,5,8,.96)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // left scrim so type holds on bright skies
  g = ctx.createLinearGradient(0, 0, W * 0.75, 0); g.addColorStop(0, `rgba(6,6,10,${story ? 0.45 : 0.6})`); g.addColorStop(1, "rgba(6,6,10,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // thruster plume after the haze so it glows through it
  if (a.rocket) {
    const rc = a.rocket, rh = story ? 980 : 760;
    const rx = story ? W * 0.72 : W * 0.76, ry = (story ? H * 0.40 : H * 0.56) + 60 * (1 - ease(t * 1.4)), tilt = 0.2;
    ctx.save(); ctx.translate(rx, ry); ctx.rotate(tilt); void rc;
    // exhaust plume (several stacked glows, long tail fading into haze)
    ctx.globalCompositeOperation = "screen";
    for (let k = 0; k < 7; k++) {
      const yy = rh * 0.5 + k * rh * 0.16, rr = rh * (0.1 + k * 0.07), al = 0.42 * (1 - k / 7);
      const pg = ctx.createRadialGradient(0, yy, 0, 0, yy, rr); pg.addColorStop(0, hexA(lo.thruster.core, al)); pg.addColorStop(0.35, hexA(lo.thruster.flame, al * 0.8)); pg.addColorStop(1, hexA(lo.thruster.flame, 0));
      ctx.fillStyle = pg; ctx.fillRect(-rr, yy - rr, 2 * rr, 2 * rr);
    }
    ctx.restore();
  }
  // vignette
  const vg = ctx.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.35, W / 2, H * 0.5, Math.max(W, H) * 0.75);
  vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,.7)"); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

  // 5) type
  const L = 64, R = W - 64;
  ctx.textBaseline = "alphabetic"; ctx.fillStyle = INK;
  ctx.font = `30px ${FONT.mono}`; tracked(ctx, "DISCIPLE", L, story ? 120 : 92, 8);
  ctx.font = `26px ${FONT.monoMed}`; ctx.fillStyle = "rgba(246,241,228,.75)"; tracked(ctx, fmtCt(d.endTs || Date.now()), R, story ? 120 : 92, 3, "right");
  ctx.fillStyle = INK; ctx.fillRect(L, story ? 146 : 114, R - L, 5);
  // tier tag
  ctx.font = `24px ${FONT.mono}`; ctx.fillStyle = "rgba(246,241,228,.85)";
  tracked(ctx, `TIER ${tier.index} · ${tier.name}`, L, story ? 200 : 160, 6);
  if (d.sample) { ctx.save(); ctx.translate(R - 150, story ? 196 : 156); ctx.rotate(0.05); ctx.fillStyle = "#ffd166"; ctx.fillRect(-110, -32, 250, 46); ctx.fillStyle = "#0a0a0a"; ctx.font = `24px ${FONT.mono}`; tracked(ctx, "SAMPLE DATA", -96, 0, 4); ctx.restore(); }

  // ticker block
  const tickY = story ? 960 : 330;
  ctx.fillStyle = INK; const tpx = fitText(ctx, `$${d.ticker}`, (p) => `${p}px ${FONT.black}`, story ? 760 : 560, story ? 132 : 104);
  ctx.font = `${tpx}px ${FONT.black}`; ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = 30; ctx.fillText(`$${d.ticker}`, L - 4, tickY); ctx.shadowBlur = 0;
  ctx.font = `26px ${FONT.mono}`; ctx.fillStyle = "rgba(246,241,228,.7)";
  tracked(ctx, d.kind === "realized" ? "CLOSED · REALIZED" : "STILL HOLDING · UNREALIZED", L, tickY + 46, 5);

  // the number: glow + crisp pass, slams in on the video
  const big = fmtMoney(d.gainUsd), bt = ease(t * 1.6);
  const bpx = fitText(ctx, big, (p) => `${p}px ${FONT.black}`, story ? R - L : 640, story ? 270 : 190);
  const bigY = story ? tickY + 300 : tickY + 230;
  ctx.save(); ctx.globalAlpha = bt; ctx.translate(L - 6, bigY); const sc = 1 + 0.08 * (1 - bt); ctx.scale(sc, sc);
  ctx.font = `${bpx}px ${FONT.black}`;
  ctx.shadowColor = hexA(accent, 0.9); ctx.shadowBlur = 90; ctx.fillStyle = hexA(accent, 0.55); ctx.fillText(big, 0, 0);
  ctx.shadowBlur = 28; ctx.fillStyle = accent; ctx.fillText(big, 0, 0);
  ctx.shadowBlur = 0; ctx.globalAlpha = bt * 0.25; ctx.fillStyle = "#ffffff"; ctx.fillText(big, 0, -3);
  ctx.restore();
  const pct = fmtPct(d.gainPct), pt = ease(t * 1.6 - 0.25);
  ctx.save(); ctx.globalAlpha = pt; ctx.font = `${story ? 130 : 92}px ${FONT.black}`; ctx.shadowColor = hexA(accent, 0.7); ctx.shadowBlur = 40; ctx.fillStyle = accent;
  ctx.fillText(pct, L - 4, bigY + (story ? 150 : 108)); ctx.restore();

  // stats + fills strip
  const sy = story ? bigY + 250 : bigY + 180, st = ease(t * 1.6 - 0.45);
  ctx.save(); ctx.globalAlpha = st;
  const col = (label: string, val: string, x: number) => { ctx.font = `22px ${FONT.monoMed}`; ctx.fillStyle = "rgba(246,241,228,.6)"; tracked(ctx, label, x, sy, 4); ctx.font = `${story ? 50 : 40}px ${FONT.black}`; ctx.fillStyle = INK; ctx.fillText(val, x, sy + (story ? 56 : 46)); };
  col("ENTRY MCAP", fmtMcap(d.mcapStart), L); col(d.kind === "realized" ? "EXIT MCAP" : "MCAP NOW", fmtMcap(d.mcapEnd), L + (story ? 330 : 260)); col("FILLS", String(d.fills.length), L + (story ? 660 : 520));
  if (story) fillsStrip(ctx, d, L, sy + 100, R - L, 120, accent);
  ctx.restore();

  // footer
  const fy = H - (story ? 90 : 62);
  ctx.fillStyle = "rgba(246,241,228,.35)"; ctx.fillRect(L, fy - (story ? 70 : 58), R - L, 2);
  ctx.fillStyle = INK; ctx.font = `${story ? 54 : 42}px ${FONT.black}`;
  ctx.fillText(d.username ? `@${d.username}` : d.refLabel.split("/r/")[1] || "", L, fy);
  ctx.font = `${story ? 28 : 24}px ${FONT.mono}`;
  const lw = ctx.measureText(d.refLabel).width + 36;
  ctx.fillStyle = "rgba(10,10,14,.6)"; ctx.fillRect(R - lw, fy - (story ? 42 : 36), lw, story ? 56 : 48);
  ctx.strokeStyle = "rgba(246,241,228,.5)"; ctx.lineWidth = 2; ctx.strokeRect(R - lw, fy - (story ? 42 : 36), lw, story ? 56 : 48);
  ctx.fillStyle = INK; ctx.fillText(d.refLabel, R - lw + 18, fy - 4);

  // 6) grain on top (seeded; animated per-frame on video via seed)
  ctx.globalCompositeOperation = "overlay"; const gt = grainTile(mk, o.seed ?? 7);
  ctx.fillStyle = ctx.createPattern(gt, "repeat"); ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = "source-over";
  ctx.restore();
}

function fillsStrip(ctx: Ctx, d: SceneData, x: number, y: number, w: number, h: number, accent: string) {
  const pts = d.fills.map((f) => ({ m: f.mcapUsd, s: f.side }));
  if (d.kind === "unrealized") pts.push({ m: d.mcapEnd, s: "now" });
  if (pts.length < 1) return;
  const ls = pts.map((p) => Math.log10(Math.max(1, p.m))); let lo = Math.min(...ls), hi = Math.max(...ls);
  if (hi - lo < 0.08) { const c = (hi + lo) / 2; lo = c - 0.04; hi = c + 0.04; }
  const X = (i: number) => x + 14 + (pts.length > 1 ? i / (pts.length - 1) : 0.5) * (w - 28), Y = (m: number) => y + h - 14 - ((Math.log10(Math.max(1, m)) - lo) / (hi - lo)) * (h - 28);
  ctx.fillStyle = "rgba(8,8,12,.45)"; ctx.fillRect(x, y, w, h); ctx.strokeStyle = "rgba(246,241,228,.18)"; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
  ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.m)) : ctx.moveTo(X(i), Y(p.m))));
  ctx.strokeStyle = INK; ctx.lineWidth = 5; ctx.lineJoin = "round"; ctx.shadowColor = hexA(accent, 0.6); ctx.shadowBlur = 16; ctx.stroke(); ctx.shadowBlur = 0;
  pts.forEach((p, i) => {
    const px = X(i), py = Y(p.m); ctx.beginPath();
    if (p.s === "buy") { ctx.moveTo(px - 12, py + 11); ctx.lineTo(px, py - 13); ctx.lineTo(px + 12, py + 11); ctx.fillStyle = GREEN; }
    else if (p.s === "sell") { ctx.moveTo(px - 12, py - 11); ctx.lineTo(px, py + 13); ctx.lineTo(px + 12, py - 11); ctx.fillStyle = RED; }
    else { ctx.arc(px, py, 10, 0, 7); ctx.fillStyle = INK; }
    ctx.closePath(); ctx.fill();
  });
}
function hexA(hex: string, a: number) {
  const h = hex.replace("#", ""); const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
