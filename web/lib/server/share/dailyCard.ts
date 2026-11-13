import "server-only";
/**
 * Daily flight share card (1200×630, the approved ShareCard board): the wordmark, DAILY FLIGHT #N and HARD, "{pilot}
 * cashed out at", the multiple, the three goal checks, the rank pill, the flight path with the cash-out marked and
 * "Beat it at disciple.vip/d/N". Drawn with @napi-rs/canvas from the server's own replay of the run.
 */
import path from "path";
import { createCanvas, GlobalFonts, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { fmtMultiple } from "@/lib/sim/daily";

const ROOT = process.cwd();
const F = { b700: "DcBarlow700", b800: "DcBarlow800", ui: "DcInter600" };
let fontsOk = false;
function fonts() {
  if (fontsOk) return; fontsOk = true;
  const f = (n: string) => path.join(ROOT, "public/fonts/share", n);
  GlobalFonts.registerFromPath(f("BarlowCondensed-Bold.ttf"), F.b700);
  GlobalFonts.registerFromPath(f("BarlowCondensed-ExtraBold.ttf"), F.b800);
  GlobalFonts.registerFromPath(f("Inter-SemiBold.ttf"), F.ui);
}
let skyP: Promise<Image | null> | null = null;
const sky = () => (skyP ??= loadImage(path.join(ROOT, "public/free-play/share-sky.webp")).catch(() => null));

export interface DailyCardData {
  id: number; difficulty: string; host: string;
  /** null: nobody has flown it yet (the card invites the first pilot) */
  run: { name: string; multiple: number; goals: { green: boolean; cash2x: boolean; orbit: boolean }; path: number[]; outAtS: number | null } | null;
  rank: number; count: number;
}
const GOLD = "#F2C14E", INK = "#121327", TXT = "#F2F3F7", DIM = "#D7D9E4";

function rr(g: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function check(g: SKRSContext2D, cx: number, cy: number, on: boolean) {
  const s = 30 / 24;
  if (on) {
    g.fillStyle = GOLD; g.beginPath(); g.arc(cx, cy, 10 * s, 0, Math.PI * 2); g.fill();
    g.strokeStyle = INK; g.lineWidth = 2.4 * s; g.lineCap = "round"; g.lineJoin = "round";
    g.beginPath(); g.moveTo(cx - 4.5 * s, cy + 0.5 * s); g.lineTo(cx - 1.5 * s, cy + 3.5 * s); g.lineTo(cx + 4.5 * s, cy - 3 * s); g.stroke();
  } else { g.strokeStyle = "rgba(215,217,228,0.5)"; g.lineWidth = 1.6 * s; g.beginPath(); g.arc(cx, cy, 9.5 * s, 0, Math.PI * 2); g.stroke(); }
}
export const rankLine = (rank: number, count: number) =>
  count < 10 ? `#${rank} of ${count.toLocaleString("en-US")} pilot${count === 1 ? "" : "s"}` : `Top ${Math.max(1, Math.ceil((rank / count) * 100))}% of ${count.toLocaleString("en-US")} pilots`;

export async function renderDailyCard(d: DailyCardData): Promise<Buffer> {
  fonts();
  const W = 1200, H = 630, c = createCanvas(W, H), g = c.getContext("2d");
  g.fillStyle = "#0B0C0E"; g.fillRect(0, 0, W, H);
  const bg = await sky();
  if (bg) {   // object-fit: cover into right -120px, top -60px, 900×750
    const bw = 900, bh = 750, k = Math.max(bw / bg.width, bh / bg.height), sw = bw / k, sh = bh / k;
    g.drawImage(bg, (bg.width - sw) / 2, (bg.height - sh) / 2, sw, sh, W + 120 - bw, -60, bw, bh);
  }
  const gr = g.createLinearGradient(0, 0, W, 0);
  gr.addColorStop(0, "#0B0C0E"); gr.addColorStop(0.38, "rgba(11,12,14,0.96)"); gr.addColorStop(0.7, "rgba(11,12,14,0.4)"); gr.addColorStop(1, "rgba(11,12,14,0.1)");
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  g.textBaseline = "alphabetic";

  // header: DISCIPLE | DAILY FLIGHT #N [HARD]
  let x = 72; const hy = 64 + 30;
  g.fillStyle = TXT; g.font = `30px ${F.b800}`; g.letterSpacing = "4px"; g.fillText("DISCIPLE", x, hy); x += g.measureText("DISCIPLE").width + 14;
  g.fillStyle = "#2E323A"; g.fillRect(x, hy - 24, 1, 24); x += 15;
  g.fillStyle = "#F3DFA8"; g.font = `24px ${F.b700}`; g.letterSpacing = "2px"; const t = `DAILY FLIGHT #${d.id}`; g.fillText(t, x, hy - 2); x += g.measureText(t).width + 14;
  g.letterSpacing = "0px"; g.font = `20px ${F.b700}`; const dw = g.measureText(d.difficulty).width + 20;
  rr(g, x, hy - 25, dw, 28, 6); g.strokeStyle = "#FF7A3D"; g.lineWidth = 1; g.stroke(); g.fillStyle = "#FFB48F"; g.fillText(d.difficulty, x + 10, hy - 4);

  // the score
  const r = d.run;
  g.fillStyle = DIM; g.font = `22px ${F.ui}`; g.fillText(r ? `${r.name} cashed out at` : "Can you cash out at", 72, 236);
  g.fillStyle = GOLD; g.font = `200px ${F.b800}`; g.fillText(r ? fmtMultiple(r.multiple) : "2×", 66, 236 + 166);
  const gy = 236 + 166 + 14 + 15 + 14;
  const goals = r ? [r.goals.green, r.goals.cash2x, r.goals.orbit] : [false, false, false];
  goals.forEach((on, i) => check(g, 72 + 15 + i * 34, gy + 15, on));
  if (d.count > 0) {
    const pill = rankLine(d.rank, d.count); g.font = `20px ${F.ui}`; const pw = g.measureText(pill).width + 28, px = 72 + 3 * 34 + 12;
    rr(g, px, gy, pw, 32, 16); g.fillStyle = "rgba(95,240,160,0.12)"; g.fill(); g.strokeStyle = "rgba(95,240,160,0.5)"; g.stroke();
    g.fillStyle = "#BFF8D8"; g.fillText(pill, px + 14, gy + 23);
  }

  // footer: the flight path (cash-out marked) and the link
  const fy = H - 64 - 64;
  if (r && r.path.length > 1) {
    const P = r.path, lo = Math.min(...P), hi = Math.max(...P), span = Math.max(1, Math.log(hi / lo)), X = (i: number) => 72 + (i / (P.length - 1)) * 260, Y = (v: number) => fy + 58 - (Math.log(v / lo) / span) * 50;
    g.strokeStyle = "#5FF0A0"; g.lineWidth = 3; g.lineJoin = "round"; g.beginPath(); P.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)))); g.stroke();
    if (r.outAtS != null) { const i = Math.min(P.length - 1, Math.round(r.outAtS)); g.fillStyle = GOLD; g.beginPath(); g.arc(X(i), Y(P[i]), 7, 0, Math.PI * 2); g.fill(); }
  }
  g.fillStyle = TXT; g.font = `34px ${F.b800}`; g.letterSpacing = "1px"; g.fillText(`Beat it at ${d.host}/d/${d.id}`, 72 + 260 + 20, fy + 44);
  return c.encode("png");
}
