import "server-only";
/**
 * Link preview cards, 1200×630 PNG (step 7, maker 2026-11-13): site, rocket, pilot and invite. Each card is an art
 * plate with the live layer drawn on top. The plate is `public/og/<name>.png` once the art lands (text-free, 2400×1260;
 * names in the handover doc); until then a stand-in is drawn from the game's own tier sky and the chrome rocket.
 * Numbers come from the caller (live data at fetch time); any that are missing are left off, never invented.
 */
import fs from "fs";
import path from "path";
import { createCanvas, GlobalFonts, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { FLIGHT_TIERS, tierIndexAt } from "@/lib/flight/tiers";

const ROOT = process.cwd();
const W = 1200, H = 630, PAD = 72;
const F = { g8: "OgBarlow800", g7: "OgBarlow700", ui: "OgInter600", mono: "OgMono500" };
let fontsOk = false;
function fonts() {
  if (fontsOk) return; fontsOk = true;
  const f = (n: string) => path.join(ROOT, "public/fonts/share", n);
  GlobalFonts.registerFromPath(f("BarlowCondensed-ExtraBold.ttf"), F.g8);
  GlobalFonts.registerFromPath(f("BarlowCondensed-Bold.ttf"), F.g7);
  GlobalFonts.registerFromPath(f("Inter-SemiBold.ttf"), F.ui);
  GlobalFonts.registerFromPath(f("GeistMono-Medium.ttf"), F.mono);
}

const cache = new Map<string, Promise<Image | null>>();
function img(rel: string): Promise<Image | null> {
  let p = cache.get(rel);
  if (!p) {
    const file = path.join(ROOT, "public", rel);
    p = fs.existsSync(file) ? loadImage(file).catch(() => null) : Promise.resolve(null);
    cache.set(rel, p);
  }
  return p;
}

/** Sky band for the rocket card plates (handover doc): 1 ground … 5 heavens. */
export function bandOf(mcap: number): 1 | 2 | 3 | 4 | 5 {
  const i = tierIndexAt(mcap);
  return i <= 1 ? 1 : i <= 3 ? 2 : i <= 6 ? 3 : i <= 10 ? 4 : 5;
}
export const tierName = (mcap: number) => FLIGHT_TIERS[tierIndexAt(mcap)].name;

export type OgCard =
  | { kind: "site" }
  | { kind: "rocket"; ticker: string; name: string; host: string | null; mcapUsd: number | null; orbitPct: number | null; graduated: boolean; aboard: number | null; icon: Buffer | null }
  | { kind: "pilot"; handle: string; level: number | null; trophies: number | null; hull: string | null }
  | { kind: "invite"; from: string | null };

const cover = (o: SKRSContext2D, im: Image, x = 0.5, y = 0.5) => {
  const s = Math.max(W / im.width, H / im.height), w = im.width * s, h = im.height * s;
  o.drawImage(im, (W - w) * x, (H - h) * y, w, h);
};

/** The art plate, or the stand-in (tier sky + chrome rocket on the right). */
async function plate(o: SKRSContext2D, name: string, sky: string, rocket: { rot: number; x: number; h: number } | null) {
  const art = await img(`og/${name}.png`);
  if (art) { cover(o, art); return true; }
  const bg = await img(sky);
  if (bg) cover(o, bg, 0.5, 0.35); else { o.fillStyle = "#121327"; o.fillRect(0, 0, W, H); }
  if (rocket) {
    const r = await img("assets/rocket-hi.webp");
    if (r) {
      const h = rocket.h, w = (r.width / r.height) * h;
      const glow = o.createRadialGradient(rocket.x, H * 0.82, 10, rocket.x, H * 0.82, 260);
      glow.addColorStop(0, "rgba(255,214,160,0.30)"); glow.addColorStop(1, "rgba(255,122,61,0)");
      o.fillStyle = glow; o.fillRect(0, 0, W, H);
      o.save(); o.translate(rocket.x, H / 2); o.rotate((rocket.rot * Math.PI) / 180); o.drawImage(r, -w / 2, -h / 2, w, h); o.restore();
    }
  }
  return false;
}

/** Dark left side so the live text always reads (on the art plates too). */
function shade(o: SKRSContext2D, strength = 0.92) {
  const g = o.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, `rgba(11,12,14,${strength})`); g.addColorStop(0.55, `rgba(11,12,14,${strength * 0.6})`); g.addColorStop(1, "rgba(11,12,14,0.15)");
  o.fillStyle = g; o.fillRect(0, 0, W, H);
}

async function brand(o: SKRSContext2D, y: number, size: number, color = "#E8EAEE") {
  const mark = await img("brand/disciple-mark-light.svg");
  if (mark) o.drawImage(mark, PAD, y - size * 0.82, size, size);
  const word = await img("brand/disciple-wordmark-light-1200.png");   // brand E, the wide italic wordmark
  if (word) { const h = size * 0.62, w = h * (word.width / word.height); o.drawImage(word, PAD + size + 12, y - size * 0.5 - h / 2, w, h); return; }
  o.fillStyle = color; o.font = `${size * 0.86}px ${F.g8}`; o.textBaseline = "alphabetic";
  o.fillText("DISCIPLE", PAD + size + 10, y);
}

function fit(o: SKRSContext2D, text: string, font: (px: number) => string, px: number, max: number) {
  let s = px; o.font = font(s);
  while (s > 20 && o.measureText(text).width > max) { s -= 2; o.font = font(s); }
  return s;
}
function lines(o: SKRSContext2D, text: string, x: number, y: number, max: number, lh: number) {
  const words = text.split(" "); let line = "", yy = y;
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (o.measureText(t).width > max && line) { o.fillText(line, x, yy); line = w; yy += lh; } else line = t;
  }
  if (line) o.fillText(line, x, yy);
  return yy;
}
const money = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, "")}K` : `$${Math.round(v)}`);

export async function renderOgCard(c: OgCard): Promise<Buffer> {
  fonts();
  const cv = createCanvas(W, H), o = cv.getContext("2d");
  o.imageSmoothingQuality = "high";

  if (c.kind === "site") {
    await plate(o, "site", "home/sky/t6.webp", { rot: 8, x: 900, h: 520 });
    shade(o);
    await brand(o, 118, 34);
    o.fillStyle = "#FFFFFF"; o.font = `118px ${F.g8}`;
    o.fillText("RIDE IT", PAD, 300); o.fillText("TO ORBIT", PAD, 400);
    o.fillStyle = "#BCC0CA"; o.font = `26px ${F.ui}`;
    lines(o, "Every rocket is a live match. The crew boosts it up, and anyone can bomb it down.", PAD, 466, 520, 36);
  }

  if (c.kind === "rocket") {
    const mcap = c.mcapUsd ?? 0;
    const name = c.graduated ? "rocket-orbit" : `rocket-band${bandOf(mcap)}`;
    const sky = FLIGHT_TIERS[tierIndexAt(mcap)].sky.replace(/^\//, "");
    await plate(o, name, sky, { rot: -6, x: 930, h: 560 });
    shade(o, 0.94);
    await brand(o, 100, 26, "#BCC0CA");
    // status chip
    const chip = c.graduated ? "In orbit" : "In flight";
    o.font = `18px ${F.ui}`; const cw = o.measureText(chip).width + 40;
    const cx = PAD + 170;
    o.fillStyle = "rgba(11,12,14,0.65)"; o.beginPath(); o.roundRect(cx, 74, cw, 34, 17); o.fill();
    o.fillStyle = c.graduated ? "#F2C14E" : "#5FF0A0"; o.beginPath(); o.arc(cx + 18, 91, 5, 0, Math.PI * 2); o.fill();
    o.fillStyle = "#E8EAEE"; o.fillText(chip, cx + 30, 97);
    // icon + ticker
    let tx = PAD;
    const icon = c.icon ? await loadImage(c.icon).catch(() => null) : null;
    if (icon) {
      o.save(); o.beginPath(); o.roundRect(PAD, 160, 120, 120, 26); o.clip(); o.drawImage(icon, PAD, 160, 120, 120); o.restore();
      tx = PAD + 144;
    }
    o.fillStyle = "#FFFFFF";
    fit(o, `$${c.ticker}`, (px) => `${px}px ${F.g8}`, 92, 620 - tx);
    o.fillText(`$${c.ticker}`, tx, 240);
    o.fillStyle = "#BCC0CA"; o.font = `24px ${F.ui}`;
    const sub = c.host ? `${c.name} · hosted by @${c.host}` : c.name;
    fit(o, sub, (px) => `${px}px ${F.ui}`, 24, 640 - tx); o.fillText(sub, tx, 278);
    // tier + orbit
    if (c.mcapUsd != null) {
      const y = 400, bw = 560;
      o.fillStyle = "#A9C4FF"; o.font = `44px ${F.g8}`; o.fillText(tierName(mcap), PAD, y);
      o.fillStyle = "#E8EAEE"; o.font = `26px ${F.mono}`; const m = money(mcap); o.fillText(m, PAD + bw - o.measureText(m).width, y);
      if (c.graduated) {
        o.fillStyle = "#F3DFA8"; o.font = `24px ${F.ui}`; o.fillText(c.aboard ? `Reached orbit · ${c.aboard.toLocaleString("en-US")} aboard` : "Reached orbit", PAD, y + 56);
      } else if (c.orbitPct != null) {
        o.fillStyle = "rgba(232,234,238,0.14)"; o.beginPath(); o.roundRect(PAD, y + 22, bw, 12, 6); o.fill();
        const g = o.createLinearGradient(PAD, 0, PAD + bw, 0); g.addColorStop(0, "#F3DFA8"); g.addColorStop(1, "#F2C14E");
        o.fillStyle = g; o.beginPath(); o.roundRect(PAD, y + 22, Math.max(12, (bw * Math.min(100, c.orbitPct)) / 100), 12, 6); o.fill();
        o.fillStyle = "#9095A0"; o.font = `22px ${F.ui}`;
        o.fillText(`${Math.round(c.orbitPct)}% to orbit${c.aboard ? ` · ${c.aboard.toLocaleString("en-US")} aboard` : ""}`, PAD, y + 70);
      }
    }
  }

  if (c.kind === "pilot") {
    const hull = c.hull && ["chrome", "matte", "violet", "gold"].includes(c.hull) ? c.hull : "chrome";
    await plate(o, `pilot-${hull}`, "assets/tier5.webp", { rot: 0, x: 900, h: 500 });
    shade(o, 0.95);
    await brand(o, 100, 26, "#BCC0CA");
    // ring
    const rx = PAD + 62, ry = 262;
    o.fillStyle = "#2A2D36"; o.beginPath(); o.arc(rx, ry, 62, 0, Math.PI * 2); o.fill();
    o.strokeStyle = "#F2C14E"; o.lineWidth = 8; o.beginPath(); o.arc(rx, ry, 58, 0, Math.PI * 2); o.stroke();
    o.fillStyle = "#FFFFFF"; o.font = `56px ${F.g8}`; o.textAlign = "center"; o.fillText(c.handle[0]?.toUpperCase() ?? "?", rx, ry + 20); o.textAlign = "left";
    const tx = PAD + 152;
    o.fillStyle = "#FFFFFF"; fit(o, `@${c.handle}`, (px) => `${px}px ${F.g8}`, 84, 620 - tx); o.fillText(`@${c.handle}`.toUpperCase(), tx, 262);
    if (c.level != null) { o.fillStyle = "#F3DFA8"; o.font = `28px ${F.ui}`; o.fillText(`Level ${c.level} pilot`, tx, 304); }
    if (c.trophies) {
      o.fillStyle = "#FFFFFF"; o.font = `40px ${F.mono}`; o.fillText(String(c.trophies), PAD, 460);
      o.fillStyle = "#9095A0"; o.font = `20px ${F.ui}`; o.fillText(c.trophies === 1 ? "trophy" : "trophies", PAD, 492);
    }
  }

  if (c.kind === "invite") {
    await plate(o, "invite", "assets/tier3.webp", { rot: 10, x: 910, h: 540 });
    const warm = o.createRadialGradient(880, 315, 20, 880, 315, 420);
    warm.addColorStop(0, "rgba(242,193,78,0.20)"); warm.addColorStop(1, "rgba(242,193,78,0)");
    o.fillStyle = warm; o.fillRect(0, 0, W, H);
    shade(o, 0.94);
    await brand(o, 100, 26, "#BCC0CA");
    o.fillStyle = "#F3DFA8"; o.font = `22px ${F.mono}`;
    o.fillText(c.from ? `@${c.from} SENT YOU`.toUpperCase() : "YOU'RE INVITED", PAD, 196);
    o.fillStyle = "#FFFFFF"; o.font = `104px ${F.g8}`;
    o.fillText("A SEAT ON", PAD, 300); o.fillText("THE ROCKET", PAD, 392);
    o.fillStyle = "#BCC0CA"; o.font = `26px ${F.ui}`;
    lines(o, "Sign in, take your seat and boost your first rocket.", PAD, 456, 520, 36);
  }

  return cv.encode("png");
}
