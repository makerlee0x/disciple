// game/hud-sidebar-layout: the desktop top row (header card · BUY/SELL panel · TOP HOLDERS column) never overlaps,
// nor runs under the wallet strip (cash / total), for any content width (sidebar open 270 / 220 / rail 64, 1280–1920).
//   Run: node scripts/test-hud-layout.mjs
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const eng = fs.readFileSync(path.join(web, "public/flight/engine.js"), "utf8");
const blk = eng.match(/\/\* @hud-layout:start[\s\S]*?\*\/([\s\S]*?)\/\* @hud-layout:end \*\//); if (!blk) throw new Error("@hud-layout markers missing");
const hudTopLayout = new Function(blk[1] + "\nreturn hudTopLayout;")();
let bad = 0; const ok = (c, m) => { if (!c) { console.log("FAIL " + m); bad++; } };
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
let n = 0;
for (const vw of [1280, 1366, 1440, 1536, 1680, 1920]) for (const side of [64, 220, 248, 270]) for (const walletW of [0, 180, 300, 430]) for (const hdrB of [148, 176]) for (const rows of [1, 3]) {
  const W = vw - side, colTop = walletW ? (rows === 3 ? 140 : 70) : 28, walletL = walletW ? W - 20 - walletW : 0;
  const L = hudTopLayout({ W, AW: 472, AH: 108, CW: 310, hdrR: 400, hdrB, colTop, colH: 96, walletL });
  const hdr = { x: 20, y: 18, w: 380, h: hdrB - 18 }, ammo = { x: L.ax, y: L.ay, w: 472, h: 108 }, col = { x: L.RX, y: L.colTop, w: 310, h: 96 };
  const wallet = walletW ? { x: walletL, y: 0, w: walletW, h: colTop - 18 } : null;
  const tag = `vw ${vw} side ${side} wallet ${walletW}×${rows} rows hdrB ${hdrB}: ammo ${JSON.stringify(ammo)} col ${JSON.stringify(col)}`;
  ok(!hit(hdr, ammo), "header × BUY panel · " + tag);
  ok(!hit(ammo, col), "BUY panel × TOP HOLDERS · " + tag);
  ok(!wallet || !hit(ammo, wallet), "BUY panel × wallet strip · " + tag);
  ok(!wallet || !hit(col, wallet), "TOP HOLDERS × wallet strip · " + tag);
  ok(ammo.x >= 20 && ammo.x + ammo.w <= W - 20 && col.x + col.w <= W, "on screen · " + tag);
  n++;
}
// overlay sidebar (SITE #222): canvas full width, left 248 blocked while open → header column starts at 248+20 (hdrR = 248+400)
for (const vw of [1280, 1440, 1920]) for (const walletW of [0, 430]) { const W = vw, colTop = walletW ? 70 : 28, walletL = walletW ? W - 20 - walletW : 0;
  const L = hudTopLayout({ W, AW: 472, AH: 108, CW: 310, hdrR: 248 + 400, hdrB: 176, colTop, colH: 96, walletL });
  const hdr = { x: 268, y: 18, w: 380, h: 158 }, ammo = { x: L.ax, y: L.ay, w: 472, h: 108 }, col = { x: L.RX, y: L.colTop, w: 310, h: 96 };
  ok(!hit(hdr, ammo) && !hit(ammo, col) && ammo.x >= 248 && ammo.x + 472 <= W - 20, `overlay vw ${vw} wallet ${walletW}: ${JSON.stringify(ammo)} ${JSON.stringify(col)}`); n++; }
// unchanged where it already fit: wide canvas, no wallet → centred between header and column, top row
{ const W = 1920 - 64, L = hudTopLayout({ W, AW: 472, AH: 108, CW: 310, hdrR: 400, hdrB: 148, colTop: 28, colH: 96, walletL: 0 });
  ok(L.ay === 18 && L.colTop === 28 && L.ax === Math.round((W - 472) / 2), "wide screen: same layout as before " + JSON.stringify(L)); }
ok(/body\.side-open \.flight-wrap/.test(fs.readFileSync(path.join(web, "components/FlightCanvas.tsx"), "utf8")), "canvas still starts at the sidebar edge");
ok(!/\b270\b/.test(blk[1]) && !/\b220\b/.test(blk[1]), "no hard-coded sidebar width in the layout");
console.log(bad ? `FAIL · ${bad}` : `ok · ${n} layouts, no overlaps`); process.exit(bad ? 1 : 0);
