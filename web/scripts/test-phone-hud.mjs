// Phone-first HUD (<740px): layout math, engine gating, worker mirroring, panel wiring. Desktop paths must stay untouched.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const rd = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const hud = rd("components/flight/PhoneHud.tsx"), eng = rd("public/flight/engine.js"), fc = rd("components/FlightCanvas.tsx");
const wb = rd("lib/flight/workerBridge.ts"), pnl = rd("components/PnlHud.tsx");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// 1) pure layout: extract phoneLayout + its constants and run it
const consts = hud.match(/export const TAB_W = [^;]+;/)[0].replace("export ", "");
const fn = hud.match(/export function phoneLayout\(o: [^)]+\) \{[\s\S]*?\n\}/)[0].replace(/^export function phoneLayout\(o: [^)]+\)/, "function phoneLayout(o)");
const phoneLayout = new Function(`${consts}\n${fn}\nreturn phoneLayout;`)();
const PHONE_W = +hud.match(/export const PHONE_W = (\d+);/)[1];
ok(PHONE_W === +eng.match(/const HUD_NARROW_W=(\d+)/)[1], "PhoneHud PHONE_W == engine HUD_NARROW_W");
const over = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
for (const [w, h, trTop, barTop] of [[390, 844, 53, 747], [360, 780, 53, 683], [375, 667, 53, 570]]) {
  const L = phoneLayout({ w, h, trTop, barTop });
  const strip = { x: L.sx, y: L.top, w: w - 2 * L.sx, h: 60 }, sheet = { x: L.sx, y: L.sy, w: L.sw, h: L.sh }, tabs = { x: L.tabX, y: L.sy, w: 44, h: 10 };
  const presets = { x: L.sx, y: L.py - 56, w: w - 2 * L.sx, h: 56 }, pnlS = { x: L.sx, y: h - L.pnlBottom - 32, w: w - 2 * L.sx, h: 32 }, bar = { x: L.sx, y: barTop, w: w - 2 * L.sx, h: h - barTop };
  const R = { strip, sheet, tabs, presets, pnlS, bar }, ks = Object.keys(R);
  for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) ok(!over(R[ks[i]], R[ks[j]]), `${w}x${h}: ${ks[i]} overlaps ${ks[j]}`);
  ok(L.tabX + 44 <= w && L.sx >= 0, `${w}: tabs on screen`);
  ok(L.sw >= 296, `${w}: sheet fits the 300px chart / 310px panels (sw=${L.sw})`);
  ok(L.chipBottom === h - (L.py - 56) + 6, `${w}: snipe chip sits above the presets`);
}
// 2) tabs: 8 short placeholders (copy pending lee / BRAND), one sheet at a time, ✕ + tap-outside close
const labels = [...hud.matchAll(/\{ id: "(\w+)", label: "([^"]+)"/g)].map((m) => [m[1], m[2]]);
ok(labels.length === 8 && labels.every(([, l]) => l.length <= 5), "8 short tab labels");
ok(/PLACEHOLDERS — pending lee \/ BRAND copy approval/.test(hud), "labels flagged as placeholders");
ok(/useState<PhoneSheet \| null>/.test(hud) && /data-testid="phone-sheet-close"/.test(hud) && /data-testid="phone-backdrop"/.test(hud), "single sheet + close + backdrop");
ok(/new URLSearchParams\(location\.search\)\.get\("clean"\) === "1"\) return/.test(hud), "?clean=1 keeps the phone HUD off");
ok(/if \(!phone \|\| !L\) return null;/.test(hud), "desktop renders nothing");
// 3) engine gating: desktop branches unchanged, phone draws only the open sheet
const ph = new Function("window", `const HUD_NARROW_W=740;\n${eng.match(/function phoneHud\(w,clean\)\{[^\n]+/)[0]}\nreturn phoneHud;`);
const P = { on: true, sheet: null };
ok(ph({ __phoneHud: P })(390, false) === P && ph({ __phoneHud: P })(1440, false) === null && ph({ __phoneHud: P })(390, true) === null && ph({})(390, false) == null, "phoneHud(): phone only, never CLEAN / desktop");
for (const re of [/if \(!PH\|\|PH\.sheet==='status'\)\{\n  panel\(RX,RT,CW,92\);/, /if \(PH\?PH\.sheet==='holders':!S\.kothDocked\)\{ panel\(RX,RT\+100,CW,96\);/,
  /if \(!PH\|\|PH\.sheet==='feed'\)\{ const FX=PH\?PH\.sx:20, FY=PH\?PH\.sy\+160:H/, /if \(S\.controlsDocked\) pushControls\(\); else if \(!PH\) \{ panel\(RX,H-104,310,84\);/,
  /if \(PH\) drawPhonePresets\(PH\); else \{/, /if \(PH\) drawPhoneMcap\(m,ti,PH\); else \{\n  \/\/ top-left: MCAP \+ tier\n  panel\(20,18,380,130\);/,
  /if\(P\) return P\.sheet==='chart'\?\{x:P\.sx,y:P\.sy/, /if\(P\?P\.sheet!=='chart':!C\.on\) return;/])
  ok(re.test(eng), "engine: " + re.source.slice(0, 60));
ok(/R\.x=bx; R\.y=y1; R\.w=cw; R\.h=rh;/.test(eng) && /AMMO_HIT\[6\+k\]; R\.x=bx; R\.y=y2/.test(eng), "phone preset chips reuse AMMO_HIT taps");
// 4) wiring
ok(/const GLOBALS = \[[^\]]*"__phoneHud"/.test(wb), "worker renderer mirrors window.__phoneHud");
ok(/<PhoneHud \/>/.test(fc) && /data-testid="flight-pills"/.test(fc), "FlightCanvas mounts PhoneHud + tags the pill row");
ok(/addEventListener\("disciple:phonesheet", onSheet\)/.test(pnl) && /disciple:phonesheet-req/.test(pnl) && /className="pnl-sub"/.test(pnl), "PnlHud: strip ↔ RUN sheet");
ok(/html\.ap-phone \[data-testid="trade-bar"\]/.test(hud) && !/trade-bar[^\n]*display: none/.test(hud), "trade bar: layout-only CSS, never hidden");
ok(/snipe-chip/.test(hud), "anti-snipe chip kept visible");
console.log(`phone-hud: ${n} checks passed`);
