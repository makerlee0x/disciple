// Phone HUD v3 (<740px, lee 10:36 CT): layout math, engine gating, drag-to-steer (unit + handler harness), worker forwarding,
// trade-bar / amount-sheet wiring, tier label. Desktop paths must stay untouched.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const rd = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const hud = rd("components/flight/PhoneHud.tsx"), eng = rd("public/flight/engine.js"), fc = rd("components/FlightCanvas.tsx");
const wb = rd("lib/flight/workerBridge.ts"), wk = rd("public/flight/worker.js"), pnl = rd("components/PnlHud.tsx");
const tb = rd("components/TradeBridge.tsx"), bar = rd("components/flight/PhoneTradeBar.tsx"), sm = rd("components/flight/SettingsMenu.tsx");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// 1) pure layout: extract phoneLayout + its constants and run it
const consts = hud.match(/export const SIDE = [\s\S]*?;\n/)[0].replace("export ", "");
const fn = hud.match(/export function phoneLayout\(o: [^)]+\) \{[\s\S]*?\n\}/)[0].replace(/^export function phoneLayout\(o: [^)]+\)/, "function phoneLayout(o)");
const phoneLayout = new Function(`${consts}\n${fn}\nreturn phoneLayout;`)();
const PHONE_W = +hud.match(/export const PHONE_W = (\d+);/)[1];
ok(PHONE_W === +eng.match(/const HUD_NARROW_W=(\d+)/)[1], "PhoneHud PHONE_W == engine HUD_NARROW_W");
for (const [w, h, top] of [[390, 844, 60], [360, 780, 60], [375, 667, 60]]) {
  const L = phoneLayout({ w, h, topBottom: top });
  ok(L.pillTop >= top + 8 && L.pillTop + 46 < L.hudTop - 220, `${w}x${h}: pill under the top row, open sky below it`);
  ok(L.btnTop + 68 === h - 22 && L.pnlTop + 22 + 14 === L.btnTop && L.hudTop + 28 === L.pnlTop, `${w}x${h}: handle → PnL line → 68px buttons, 22px from the bottom`);
  ok(Math.abs(L.dTop - h * 0.38) <= 1, `${w}x${h}: drawer ~62% of the height`);
  ok(L.body.x === 16 && L.body.w === w - 32 && L.body.y > L.dTop + 72 && L.body.y + L.body.h <= L.dBtnTop - 12, `${w}x${h}: drawer body between tabs and the (60px) buttons`);
  ok(L.body.h >= 200, `${w}x${h}: body tall enough for 4+ feed rows (${L.body.h})`);
  ok(L.dTop > L.pillTop + 46 + 120, `${w}x${h}: rocket room between pill and drawer`);
}
// 2) drawer: Feed / Holders / Chart / Crew / Chat / Run (mockup copy), one at a time, closes on swipe down / dim tap / Esc
const labels = [...hud.matchAll(/\{ id: "(\w+)", label: "([^"]+)"/g)].map((m) => m[2]);
ok(labels.join() === "Feed,Holders,Chart,Crew,Chat,Position", "six drawer tabs from the mockup (Run → Position, lee Oct 30)");
ok(!/PHONE_TABS|phone-tabs|"STAT"|"T\/W"/.test(hud), "old 8 edge tabs removed");
ok(/data-testid="phone-dim" onPointerDown=\{\(e\) => \{ e\.preventDefault\(\); setSheet\(null\); \}\}/.test(hud), "tap the dimmed sky closes");
ok(/e\.clientY - s\.y > 36\) setSheet\(null\)/.test(hud) && /e\.key === "Escape" && sheetRef\.current\) setSheet\(null\)/.test(hud), "swipe down / Esc close");
ok(/dy < -18 \|\| Math\.abs\(dy\) < 8\) setSheet\(lastTab\.current\)/.test(hud), "swipe up / tap the handle opens");
ok(/\[data-testid="phone-drawer"\]'\);/.test(sm), "Esc with the drawer open closes it (Settings does not open)");
ok(/new URLSearchParams\(location\.search\)\.get\("clean"\) === "1"\) return/.test(hud) && /if \(!phone \|\| !L\) return null;/.test(hud), "?clean=1 / desktop render nothing");
ok(hud.match(/DRAWER_BG = "([^"]+)"/)[1] === eng.match(/const PH_DRAWER_BG='([^']+)'/)[1], "drawer tint == engine body tint");
ok(/html\.ap-phone \[data-testid="settings-btn"\]/.test(hud) && !/phone-settings/.test(hud), "gear hidden on phone; no interim Run-tab Settings button (SITE Sidebar 'Settings' item, #149)");
ok(!/#exitX/.test(hud), "no ✕ in the top row any more (coin-screen cleanup, lee Oct 30): no dead #exitX styling left");
// 3) engine gating: desktop branches unchanged, phone draws pill + the open drawer tab only
const ph = new Function("window", `const HUD_NARROW_W=740;\n${eng.match(/function phoneHud\(w,clean\)\{[^\n]+/)[0]}\nreturn phoneHud;`);
const P = { on: true, sheet: null };
ok(ph({ __phoneHud: P })(390, false) === P && ph({ __phoneHud: P })(1440, false) === null && ph({ __phoneHud: P })(390, true) === null && ph({})(390, false) == null, "phoneHud(): phone only, never CLEAN / desktop");
for (const re of [/if \(PH\) drawPhonePill\(m,ti,PH\); else \{\n  \/\/ top-left: ONE header card[^\n]*\n[^\n]*\n[^\n]*\n  const HY=coinIdRowH\(\);\n  if \(cardBegin\('header',20,18,380,130\+HY\)\)\{   \/\* @cards \*\/\n  panel\(20,18,380,130\+HY\); ctx\.save\(\); ctx\.translate\(0,HY\);/, /if \(!PH&&STATUS_BOX\)\{\n  panel\(RX,RT,CW,92\);/,
  /else if \(!docked&&cardBegin\('holders',RX,RT\+STATUS_DY,CW,96\)\)\{ panel\(RX,RT\+STATUS_DY,CW,96\);/, /else if \(cardBegin\('trades',20,H-160,310,140\)\)\{ const FX=20, FY=H, FW=310;/, /if \(S\.controlsDocked\) pushControls\(\); else if \(!PH&&cardBegin\('controls',RX,H-104,310,84\)\) \{ panel\(RX,H-104,310,84\);/,
  /PH\.sheet==='holders'\) drawPhoneHolders\(PH,top,kothTitle\)/, /PH\.sheet==='feed'\) drawPhoneFeed\(PH\)/, /if \(PH\) AMMO_HIT\.forEach\(R=>\{ R\.x=-1e9;/,
  /return P\.sheet==='chart'&&B\?\{x:/, /if\(P\?P\.sheet!=='chart':!C\.on\) return;/, /PD&&PD\.drawer&&PD\.dTop>0\?Math\.min\(ROCKET_Y,PD\.dTop-44\):ROCKET_Y/])
  ok(re.test(eng), "engine: " + re.source.slice(0, 60));
ok(!/drawPhonePresets|drawPhoneMcap/.test(eng), "no canvas preset chips / big mcap card on phones");
ok(/a 'SIM' tag in paper \/ simulated market \(final/.test(eng) && /const sim=source\.isSim\|\|!isLive\(\);/.test(eng) && eng.split("\n").filter((l) => /PLACEHOLDER/.test(l)).every((l) => /PLACEHOLDER copy \(pending lee \+ BRAND\)/.test(l)), "SIM tag (final) on paper / sim; only the post-grad copy is marked PLACEHOLDER (pending lee + BRAND)");
ok(/\{ id: "run", label: "Position" \}/.test(hud) && !/label: "Run"/.test(hud) && /aria-label="Open panels \(feed, holders, chart, crew, chat, position\)"/.test(hud) && /data-ph-sheet="run"\] \.ap-bc:has\(> \[data-testid="tw-open"\]\)/.test(hud) && /data-ph-sheet="run"\] \[data-testid="tw-list"\]/.test(hud), "drawer tab label Position (was Run; id stays run), tramps & walls live under it (no T/W tab)");
// 3b) @tier-label / @tier-progress (lee, Oct 30): "+X% to NEXT_TIER" = the mcap increase still needed, pct = (next.lo / mcap − 1) × 100;
//     bar fill = mcap / next.lo (the same number); phone pill + desktop tier bar, ascended coins too
{
  const tiersSrc = rd("lib/flight/tiers.ts");
  const TIERS = [...tiersSrc.matchAll(/\{ name: "([^"]+)", lo: ([\d._e]+), hi: ([\d._e]+)/g)].map((m) => ({ name: m[1], lo: +m[2].replace(/_/g, ""), hi: +m[3].replace(/_/g, "") }));
  ok(TIERS.length >= 18 && TIERS[4].name === "OUTER SPACE", "tiers parsed");
  const cfg = rd("lib/config.ts"); ok(/name: "LAUNCH PAD"[^\n]*lo: 3_?333/.test(cfg) && /name: "OZONE"[^\n]*lo: 12_?000|name: "OZONE"[^\n]*lo: 12e3/.test(cfg), "lib/config TIERS ladder agrees (LAUNCH PAD 3,333 → OZONE 12,000)");
  const blk = eng.slice(eng.indexOf("/* @tier-label ("), eng.indexOf("/* @tier-label-end */"));
  // monospace stub: 0.6em per glyph
  const ctx = { font: "", save() {}, restore() {}, measureText: (t) => ({ width: String(t).length * 0.6 * +(ctx.font.match(/(\d+)px/) || [0, 10])[1] }) };
  let rules = ""; const S0 = { graduated: false };
  const TL = new Function("TIERS", "clamp", "ctx", "tierRulesText", "S", "ASCENDED", blk + "\nreturn {tierProgress,tierLabel,tierLineEnd};")(TIERS, (v, a, b) => Math.max(a, Math.min(b, v)), ctx, () => rules, S0, "ASCENDED");
  const tiAt = (m) => { let i = 0; while (i < TIERS.length - 1 && m >= TIERS[i + 1].lo) i++; return i; };
  const lab = (m, ti = tiAt(m)) => TL.tierLabel(m, TL.tierProgress(m, ti).next);
  ok(lab(7200) === "+67% to OZONE", `lee's example: $7.2K → (12000/7200 − 1)·100 = 66.7 → "${lab(7200)}"`);
  ok(lab(15000) === "+20% to STRATOSPHERE", `$15K → (18000/15000 − 1) = 20% (${lab(15000)})`);
  ok(lab(30000) === "+11% to OUTER SPACE", `$30K → (33333/30000 − 1) = 11.1% (${lab(30000)})`);
  ok(lab(500e3) === "+55% to THE MOON", `$500K → (777K/500K − 1) = 55.4% (${lab(500e3)})`);
  ok(lab(11000) === "+9.1% to OZONE" && lab(24000) === "+4.2% to KÁRMÁN LINE", `under 10%: one decimal (${lab(11000)}, ${lab(24000)})`);
  ok(lab(11950) === "+0.5% to OZONE" && lab(11999.99) === "+0.1% to OZONE", "tiny gaps round UP to 0.1%: never '+0%' before the tier is reached");
  ok(lab(TIERS[4].lo) === "+65% to FIRMAMENT", "exactly at a tier's floor: the full gap to the next floor");
  ok(lab(2000, 0) === "+500% to OZONE", "below the LAUNCH PAD floor: still the increase to OZONE");
  const top = TIERS.length - 1; ok(lab(TIERS[top].lo * 1.5, top) === "", "top tier: no label (desktop keeps ★ TOP TIER)");
  for (let i = 0; i < top; i++) { const m = TIERS[i].lo * 1.01, p = TL.tierProgress(m, i), L = lab(m, i), pct = (TIERS[i + 1].lo / m - 1) * 100;
    ok(L.endsWith(" to " + TIERS[i + 1].name) && Math.abs(p.f - m / TIERS[i + 1].lo) < 1e-12 && Math.abs(parseFloat(L.slice(1)) - pct) <= Math.max(0.5, pct * 0.01) && Math.abs(1 / p.f - 1 - pct / 100) < 1e-9, `tier ${i}: "${L}" and the bar fill (${(p.f * 100).toFixed(1)}%) are the same number`); }
  ok(TL.tierProgress(TIERS[top].lo * 2, top).f === 1, "top tier: full bar");
  S0.graduated = true; ok(lab(7200) === "+67% to OZONE", "ascended coins get the same label"); S0.graduated = false;
  // desktop: right-aligned at 384 on the TIER line, never over the TIER text / rules text
  ok(/function drawTierBar\(m,ti,leftEnd\)\{\n  const t=TIERS\[ti\], \{f,next:nx\}=tierProgress\(m,ti\);/.test(eng), "desktop bar uses tierProgress");
  ok(/let lb=tierLabel\(m,nx\); if\(lb&&\(leftEnd\|\|0\)\+12>384-ctx\.measureText\(lb\)\.width\) lb=lb\.slice\(0,lb\.indexOf\(' to '\)\);[^\n]*\n    if\(lb&&[^\n]*\) ctx\.fillText\(lb,384,108\);/.test(eng), "desktop: label at the bar's right end, falls back to the bare % if the TIER line is long");
  ok(/const tierEnd=tierLineEnd\(ti,t\);[^\n]*\n  drawTierBar\(m,ti,tierEnd\);/.test(eng), "desktop passes the TIER line end");
  rules = ""; const e0 = TL.tierLineEnd(13, TIERS[13]); ctx.font = "10px"; const w0 = ctx.measureText("+39% to SERAPHIM").width;
  ok(e0 + 12 <= 384 - w0, "desktop: CHERUBIM line + label fit side by side");
  let worst = 0; for (let i = 0; i < top; i++) { ctx.font = "10px"; const w = ctx.measureText("+9.9% to " + TIERS[i + 1].name).width; worst = Math.max(worst, TL.tierLineEnd(i, TIERS[i]) + 12 + w); }
  ok(worst <= 384, `desktop: every tier's line + label fits without rules text (worst ${worst.toFixed(0)} ≤ 384)`);
  // pass 3 #2 (lee): no mode / cap text on the TIER line any more ⇒ a long rules text never changes where the line ends
  { rules = ""; const e1 = TL.tierLineEnd(16, TIERS[16]); rules = "EASY · cap 1% of supply per wallet".slice(0, 28);
    ok(TL.tierLineEnd(16, TIERS[16]) === e1, "pass 3 #2: rules text is not on the TIER line (line end unchanged)"); rules = ""; }
  // phone: one quiet caption centred under the pill; toasts move down to make room; fits 360/390 and the rocket room
  ok(/const tl=tierLabel\(m,nx\), lb=P\.drawer\?'':S\.graduated\?\(tl\?`\$\{ASCENDED\} · \$\{tl\}`:ASCENDED\):tl; S\.phoneTierLabel=lb;/.test(eng) && /ctx\.fillText\(phFit\(lb,W-48\),x\+w\/2,y\+h\+13\)/.test(eng), "phone: caption under the pill, fitted to the width, hidden while the drawer is open");
  ok(/TOY=PH\?PH\.pillTop\+\(S\.phoneTierLabel\?76:58\):136/.test(eng), "phone: toasts sit below the caption");
  for (const [w, h] of [[390, 844], [360, 780]]) { const L = phoneLayout({ w, h, topBottom: 60 }); const capB = L.pillTop + 46 + 13 + 4;
    ok(capB + 60 < L.dTop && capB < L.hudTop - 200, `${w}x${h}: caption clear of the drawer and the bottom HUD`);
    ok(0.6 * 11 * "99% to SEVENTH HEAVEN".length <= w - 48, `${w}: longest label fits without truncation`); }
}
ok(/r=\{txt:[^\n]*at:Date\.now\(\)\}/.test(eng), "feed rows carry a time for the phone 'ago' column");
// 4) drag-to-steer: pure controller (STEER block)
const steer = eng.slice(eng.indexOf("/*STEER-BEGIN*/"), eng.indexOf("/*STEER-END*/"));
const T = new Function(`${steer}\nreturn { stepSteerAuto, steerDragDir, steerMargin };`)();
for (const W of [360, 390]) {
  const st = { x: W / 2, vx: 0 }, m = T.steerMargin(W); let over = 0, t = 0, reached = -1;
  for (const tx of [W / 2 + 110, W / 2 - 90]) {
    reached = -1;
    for (let i = 0; i < 150; i++) { st.idle = 0; T.stepSteerAuto(st, T.steerDragDir(st, tx, W), 1 / 60, W); t = i / 60;
      if (reached < 0 && Math.abs(st.x - tx) < 2) reached = t; over = Math.max(over, Math.sign(tx - W / 2) * (st.x - tx)); }
    ok(reached >= 0 && reached < 1, `${W}: drag target reached in ${reached.toFixed(2)}s`);
    ok(Math.abs(st.x - tx) < 1, `${W}: holds on the finger while held`);
  }
  ok(over < 6, `${W}: no overshoot (${over.toFixed(1)}px)`);
  for (let i = 0; i < 270; i++) T.stepSteerAuto(st, 0, 1 / 60, W);
  ok(Math.abs(st.x - W / 2) < 3, `${W}: release ⇒ auto-centre (x=${st.x.toFixed(1)})`);
  const e = { x: W / 2, vx: 0 }; for (let i = 0; i < 200; i++) { e.idle = 0; T.stepSteerAuto(e, T.steerDragDir(e, W - m, W), 1 / 60, W); }
  ok(e.x <= W - m + 0.01 && e.x > W - m - 2, `${W}: clamped to steerMargin`);
}
ok(T.steerDragDir({ x: 100, vx: 0 }, NaN, 390) === 0, "no target ⇒ no input");
ok(/if \(!dir&&S\.drag&&S\.drag\.on&&S\.drag\.tx!=null\)\{ dir=steerDragDir\(S\.steer,S\.drag\.tx-\(S\.drift\|\|0\)\*0\.35,W\); S\.steer\.idle=0; \}/.test(eng), "sim step: held drag feeds stepSteerAuto (keys win)");
ok(/if\(S\.menuOpen\)\{ S\.keys=\{\}; S\.drag=null; \}/.test(eng) && /addEventListener\('blur',\(\)=>\{ S\.keys=\{\}; S\.drag=null; \}\);/.test(eng), "menu open / blur cancel a drag");
// 5) drag-to-steer: run the real pointer handlers against a fake canvas
const blk = eng.slice(eng.indexOf("/* @drag-steer (maker lee"), eng.indexOf("/* @drag-steer-end */"));
ok(!/trade\(|buyPreset\(|disciple:shoot|disciple:sellpreset|S\.grass\) return(?! true)/.test(blk), "drag block never trades and is allowed in TOUCH GRASS");
const harness = (PHV) => {
  const L = {}; const cv = { addEventListener: (t, f) => (L[t] = L[t] || []).push(f), getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844 }), setPointerCapture() {} };
  const S = { x: 195, steer: { x: 195, vx: 0 }, menuOpen: false, grass: false, phonePill: { x: 80, y: 74, w: 230, h: 46 } };
  new Function("cv", "S", "W", "H", "CLEAN", "phoneHud", "steerMargin", "clamp", "ammoAt", "chartBtnAt", blk)(cv, S, 390, 844, false, () => PHV, T.steerMargin, (v, a, b) => Math.max(a, Math.min(b, v)), () => -1, () => null);
  const fire = (t, x, y, pt = "touch", id = 1) => (L[t] || []).forEach((f) => f({ type: t, clientX: x, clientY: y, pointerType: pt, pointerId: id }));
  return { S, fire };
};
const PHV = { on: true, drawer: false, hudTop: 698, body: null };
{ const { S, fire } = harness(PHV); fire("pointerdown", 195, 400); fire("pointerup", 195, 400); ok(S.drag === null, "tap on sky: drag ends, never activated"); }
{ const { S, fire } = harness(PHV); fire("pointerdown", 195, 400); fire("pointermove", 200, 400); ok(S.drag && !S.drag.on, "under 8px slop: no steer yet");
  fire("pointermove", 315, 405); ok(S.drag.on && S.drag.tx === 315, "drag moves the target x"); fire("pointermove", 900, 405); ok(S.drag.tx === 390 - T.steerMargin(390), "target clamped to steerMargin");
  fire("pointermove", 100, 400, "touch", 2); ok(S.drag.tx === 390 - T.steerMargin(390), "other pointers ignored"); fire("pointercancel", 0, 0); ok(S.drag === null, "pointercancel ends the drag"); }
{ const { S, fire } = harness(PHV); fire("pointerdown", 195, 400, "mouse"); ok(S.drag === null, "mouse: no drag (desktop unchanged)"); fire("pointerdown", 195, 400, "pen"); ok(S.drag, "pen drags"); }
{ const { S, fire } = harness(PHV); fire("pointerdown", 195, 720); ok(S.drag === null, "bottom HUD band: no drag"); fire("pointerdown", 195, 90); ok(S.drag === null, "mcap pill: no drag"); }
{ const { S, fire } = harness({ ...PHV, drawer: true }); fire("pointerdown", 195, 400); ok(S.drag === null, "drawer open: no drag"); }
{ const { S, fire } = harness(PHV); S.menuOpen = true; fire("pointerdown", 195, 400); ok(S.drag === null, "menu open: no drag"); }
{ const { S, fire } = harness(PHV); S.grass = true; fire("pointerdown", 195, 720); ok(S.drag, "TOUCH GRASS: whole screen steers"); }
// 6) worker renderer: the whole gesture is forwarded
ok(/for \(const t of \["pointermove", "pointerleave", "pointerdown", "pointerup", "pointercancel"\]\) on\(o\.canvas, t, ptr\)/.test(wb), "bridge forwards pointerup / pointercancel");
ok(/post\(\{ k: "ptr", type: p\.type, x: p\.clientX, y: p\.clientY, id: p\.pointerId, pt: p\.pointerType \}\)/.test(wb) && /o\.canvas\.setPointerCapture\(p\.pointerId\)/.test(wb), "bridge sends pointerId / pointerType, captures touch");
ok(/case 'ptr': [^\n]*pointerId: d\.id, pointerType: d\.pt/.test(wk), "worker re-dispatches pointerId / pointerType");
ok(/const GLOBALS = \[[^\]]*"__phoneHud"/.test(wb), "worker renderer mirrors window.__phoneHud");
ok(/#c \{\n\s+display: block;\n\s+image-rendering: auto;\n\s+touch-action: none;/.test(fc), "canvas touch-action:none");
// 7) trade bar + amount sheet: layout only, TradeBridge's own state and calls; the sheet never trades
ok(/if \(phone\) return \(/.test(tb) && /onBoost=\{\(\) => shoot\("buy"\)\} onDump=\{\(\) => dumpRef\.current\?\.\(\)\}/.test(tb), "phone bar: body taps = TradeBridge shoot / dumpRef");
ok(/onPickBuy=\{\(i\) => \{ setCustom\(""\); setMode\(i\); window\.dispatchEvent\(new CustomEvent\("disciple:shoot", \{ detail: \{ mode: i \} \}\)\); \}\}/.test(tb), "BUY preset = select only (no side)");
ok(/onPickSell=\{\(i\) => \{ setSellCustom\(""\); selSell\.current\(i\); \}\}/.test(tb) && /onSetSell=\{\(v\) => \{ pickUnit\("%"\); setSellCustom\(v\); \}\}/.test(tb), "DUMP preset / custom = existing sell state");
ok(/data-testid="custom-sell"/.test(tb) && /data-testid="sell-unit"/.test(tb) && /aria-label="custom amount"/.test(tb), "desktop bar markup kept");
const sheetJsx = bar.slice(bar.indexOf("{sheet && <>"), bar.indexOf("<style jsx global>"));
ok(sheetJsx.length > 200 && !/onBoost|onDump/.test(sheetJsx), "amount sheet never trades");
ok(/setSheet\(null\); \}\}>\{o\}(\{tags\[i\] \? <span[^\n]*?: null\})?<\/button>/.test(sheetJsx) && /data-testid="amt-set"/.test(sheetJsx), "tap sets the amount and closes; Custom + SET");
ok(/data-testid=\{b \? "phone-amt-buy" : "phone-amt-sell"\}/.test(bar) && /\.ph-tb \{[^}]*height: 68px; border-radius: 22px;/.test(bar), "68px BOOST / DUMP with amount chips");
// 8) PnL line + panels
ok(/\.__pnlView = detail;/.test(pnl) && /addEventListener\("disciple:phonesheet", onSheet\)/.test(pnl), "PnlHud: view mirrored for the PnL line; Run tab hook kept");
ok(/No position yet/.test(hud) && /disciple:pnlview/.test(hud), "quiet PnL line");
ok(/html\.ap-phone\[data-ph-sheet="run"\] \.pnl-hud/.test(hud) && /html\.ap-phone\[data-ph-sheet="chat"\] \[data-testid="chat-dock"\]/.test(hud), "Crew / Chat / Run reuse the existing panels");
ok(/snipe-chip/.test(hud), "anti-snipe chip kept visible");
// Settings: SITE's Sidebar item (#149) sends a plain Event (no detail) → the listener must not need a CustomEvent
ok(/const o = \(\) => openMenu\(\); addEventListener\("disciple:settings-open", o\);/.test(sm), "SettingsMenu opens on a plain Event('disciple:settings-open') (no detail read)");
{ let opened = 0; const T = new EventTarget(); const o = () => { opened++; }; T.addEventListener("disciple:settings-open", o);
  T.dispatchEvent(new Event("disciple:settings-open")); T.dispatchEvent(new CustomEvent("disciple:settings-open")); ok(opened === 2, "plain Event and CustomEvent both open Settings"); }
// 9) post-grad fixes (play-test 8:26 PM CT, 360 / 390 / 430)
const pillGap = +hud.match(/html\.ap-phone \.cl-coin \{ top: calc\(var\(--ph-pill-top\) \+ 46px \+ (\d+)px\) !important;/)[1];
for (const [w, h] of [[360, 780], [390, 844], [430, 932]]) {
  const L = phoneLayout({ w, h, topBottom: 60 }), floorTop = L.pillTop + 46 + pillGap, floorBottom = floorTop + 30;
  ok(floorTop >= L.pillTop + 46 + 22, `${w}: floor pill starts below the mcap pill + its caption (${floorTop} vs pill ${L.pillTop}–${L.pillTop + 46})`);
  ok(floorBottom < L.dTop && floorBottom < L.hudTop - 200, `${w}: floor pill clear of the drawer and the rocket`);
}
ok(/"pill-top": L\.pillTop/.test(hud) && /"cash-top": cashTop/.test(hud), "--ph-pill-top / --ph-cash-top published");
ok(/html\.ap-phone \[aria-label="cash and portfolio"\] \{ position: fixed !important; top: var\(--ph-cash-top\) !important; left: 16px !important; right: 16px !important;/.test(hud), "cash + portfolio: own row under the logo row");
ok(/html\.ap-phone \[data-testid="cash-card"\], html\.ap-phone \[data-testid="portfolio-card"\] \{[^}]*white-space: nowrap !important;[^}]*background: rgba\(12,14,28,\.9\) !important;/.test(hud), "cash / portfolio cards: contrast + never clipped");
ok(/const topBottom = Math\.max\(64, rowBottom, cash \? cash\.bottom : 0\)/.test(hud), "pill stacks under the cash row");
ok(/setPointerCapture\(e\.pointerId\)/.test(hud.match(/const downOpen = [^\n]*/)[0]) && /onPointerDown=\{downOpen\} onPointerMove=\{moveOpen\} onPointerUp=\{upOpen\}/.test(hud), "handle: pointer capture + drag-to-open (desktop mouse drag)");
ok(!/setPointerCapture/.test(hud.match(/const down = [^\n]*/)[0]) && /data-testid="phone-drawer-head" onPointerDown=\{down\}/.test(hud), "drawer head: no capture (tab / close clicks still reach their buttons)");
{ // gesture harness: a mouse drag that ends off the handle still opens (capture), and opens mid-drag past 24px
  let opened = 0, g = null; const setSheet = () => { opened++; };
  const down = (e) => { g = { y: e.clientY, id: e.pointerId }; }, moveOpen = (e) => { const s = g; if (!s || s.id !== e.pointerId) return; if (e.clientY - s.y < -24) { g = null; setSheet(); } };
  down({ clientY: 700, pointerId: 1 }); moveOpen({ clientY: 690, pointerId: 1 }); ok(opened === 0, "small move: not yet"); moveOpen({ clientY: 640, pointerId: 1 }); ok(opened === 1, "drag up 60px: opens");
  ok(/const moveOpen = \(e: React\.PointerEvent\) => \{ const s = g\.current; if \(!s \|\| s\.id !== e\.pointerId\) return; if \(e\.clientY - s\.y < -24\) \{ g\.current = null; setSheet\(lastTab\.current\); \} \};/.test(hud), "harness mirrors moveOpen"); }
{ // chart tab fills the drawer body
  const line = eng.match(/\{ const P=phoneHud\(W,CLEAN\); if\(P\)\{ const B=P\.body; return P\.sheet==='chart'[^\n]*/)[0];
  const chartRect = new Function("phoneHud", "W", "CLEAN", "clamp", "CHART_STYLE", `return function(){ const st=CHART_STYLE; ${line.replace(/\/\*[\s\S]*$/, "")} };`);
  for (const w of [360, 390, 430]) { const L = phoneLayout({ w, h: 844, topBottom: 60 });
    const r = chartRect(() => ({ sheet: "chart", body: L.body }), w, false, (v, a, b) => Math.max(a, Math.min(b, v)), { w: 300, h: 196 })();
    ok(r.x === L.body.x && r.w === L.body.w && r.h === L.body.h - 8 && r.h > 196, `${w}: chart = drawer body (${r.w}×${r.h})`); }
  ok(/R0=chartRect\(\), h=R0\.h, w=R0\.w\|\|st\.w;[^\n]*if\(C\.cv\.width!==w\) C\.cv\.width=w;/.test(eng), "chart canvas resizes to the rect"); }
{ // holders tab (lee 9:19 PM CT): pool / locker / burn / curve rows on TOP, labelled, greyed, no rank; real holders #1… below
  const f = eng.match(/function drawPhoneHolders\(P,top,title\)\{[\s\S]*?\n  ctx\.restore\(\); \}/)[0];
  ok(/sys\.forEach\(\(r,j\)=>\{ const y=B\.y\+26\+j\*rh/.test(f) && /rows\.forEach\(\(\[w,v\],i\)=>\{ const y=B\.y\+26\+\(off\+i\)\*rh/.test(f) && /const off=sys\.length;/.test(f), "phone: tagged rows drawn first, ranked rows below them");
  ok(/fillText\(String\(i\+1\)/.test(f) && /fillText\('·',x0\+14/.test(f), "phone: ranked from #1, tagged rows have no rank number");
  ok(/ctx\.fillStyle='rgba\(214,222,245,\.62\)'; ctx\.font=`bold 13px \$\{PH_FONT\}`; ctx\.fillText\(phFit\(holderKindText\(r\.label\)/.test(f), "phone: tagged rows labelled + greyed (still readable)");
  ok(/Math\.min\(sysAll\.length,Math\.max\(0,n-1\),4\)/.test(f), "phone: at least one ranked row always fits"); }
// desktop: the "Your Position" card never covers the live chart (lee, Oct 30; prod 1366×680: card bottom 448, chart top 376)
{ const blk = eng.slice(eng.indexOf("/* @chart-desk:"), eng.indexOf("/* @chart-desk-end */"));
  const consts = eng.match(/const CHART_PNL_BOTTOM=[^;]+;/)[0];
  const R = new Function("clamp", `${consts}\n${blk}\nreturn chartDeskRect;`)((v, a, b) => Math.max(a, Math.min(b, v)));
  // every desktop height × every card bottom (collapsed ~282 … expanded ~448 and beyond): the chart is either fully between
  // the card and the trades feed (H-172) with ≥100 px, or parked off-screen — never over the card, never over the feed
  let parked = 0, drawn = 0;
  for (let H = 560; H <= 1600; H += 4) for (let pb = 200; pb <= 760; pb += 4) { const r = R(H, 196, pb);
    if (r.off) { parked++; if (!(r.x < -1000 && r.y < -1000 && H - 172 - (pb + 8) < 100)) { ok(false, `desktop ${H}/${pb}: parked although there is room`); } continue; }
    drawn++; if (!(r.y >= pb + 8 && r.y + r.h <= H - 172 && r.h >= 100 && r.h <= 196)) ok(false, `desktop ${H}px, card bottom ${pb}: chart y ${r.y} h ${r.h} overlaps`); }
  ok(drawn > 1000 && parked > 100, `desktop sweep: ${drawn} layouts drawn without overlap, ${parked} parked (no room)`);
  { const r = R(680, 196, 448); ok(r.off === 1 && r.x < -1000, "1366×680, expanded card (bottom 448): chart parked, not drawn over the card or the feed"); }
  { const r = R(680, 196, 282); ok(!r.off && r.y >= 290 && r.y + r.h === 508, `1366×680, collapsed card: chart ${r.y}..${r.y + r.h} between card and feed`); }
  { const r = R(768, 196, 448); ok(!r.off && r.y === 456 && r.h === 140 && r.y + r.h === 596, "768 tall, expanded card: chart cut to the 140 px of room"); }
  ok(R(900, 196, 282).y + R(900, 196, 282).h === 900 - 172, "room to spare: the chart keeps its place right above the trades feed");
  ok(R(900, 196, null).y + R(900, 196, null).h === 728 && R(900, 196, null).y >= 456, "no card bottom published: the old 456 px budget");
  ok(/const b=chartDeskRect\(H,st\.h,typeof window!=='undefined'\?window\.__pnlBottom:null\);/.test(eng) && /const o=cardPlace\('chart',b\.x,b\.y,st\.w,b\.h\);/.test(eng), "chartRect (desktop live) uses the card's published bottom (+ the chart card's own offset, pass 3 #4)");
  ok(wb.includes('"__pnlBottom"'), "worker render: __pnlBottom forwarded with the other globals");
  ok(/w\.__pnlBottom = !isPhone\(\) && !cardHidden && r\.height > 0 \? Math\.round\(r\.bottom - top - cardDy\) : null/.test(pnl) && /new ResizeObserver\(pub\)/.test(pnl), "PnlHud publishes its bottom (desktop only, tracks open / collapse)");
  ok(/matchMedia\?\.\("\(max-height: 767px\)"\)\.matches\) setOpenS\(false\)/.test(pnl), "short desktop: the card starts collapsed (chart keeps its full height)"); }
// 390 px phone: the chart is a drawer TAB and the Your Position card is another tab → never on screen together
{ ok(/return P\.sheet==='chart'&&B\?\{x:[^\n]*:\{x:-1e4,y:-1e4,w:st\.w,h:st\.h\}/.test(eng), "phone: chart drawn only in the Chart sheet (off-screen otherwise)");
  ok(/html\.ap-phone \.pnl-hud \{ display: none !important; \}/.test(hud) && /html\.ap-phone\[data-ph-sheet="run"\] \.pnl-hud \{/.test(hud), "phone: Your Position only in the Position sheet");
  for (const w of [360, 390, 430]) { const L = phoneLayout({ w, h: 844, topBottom: 60 }); ok(L && L.body.h > 0, `${w}×844: one drawer body hosts either the chart or the run card`); } }
// ONE header card (lee, Oct 30): coin icon · name · pair row inside the MARKET CAP card; card grows by that row
{ const id = rd("components/pairart/CoinIdentity.tsx"), css = rd("app/globals.css");
  const f = new Function("window", eng.match(/function coinIdRowH\(\)\{[^\n]*\}/)[0] + "\nreturn coinIdRowH;");
  ok(f({ __coinIdH: 46 })() === 46 && f({})() === 0 && f({ __coinIdH: -3 })() === 0 && f({ __coinIdH: 900 })() === 64, "coinIdRowH: published row height, 0 when unset, clamped");
  ok(/source instanceof DiscipleSource\?'MARKET CAP':/.test(eng), "coin page: the card has a MARKET CAP label");
  ok(/drawTierBar\(m,ti,tierEnd\);[^\n]*\n  ctx\.restore\(\); ctx\.restore\(\); \} \}/.test(eng), "card contents shifted under the identity row, restored after the tier bar (+ the @cards translate)");
  ok(/w\.__coinIdH = window\.matchMedia\?\.\("\(max-width: 760px\)"\)\.matches \? 0 : Math\.ceil/.test(id) && !/mcap/.test(id.replace(/\/\/[^\n]*/g, "")), "CoinIdentity publishes its row height (0 on phones); no separate mcap in it");
  ok(/\.coin-id \{ position: fixed; left: calc\(var\(--ap-rail-w, 64px\) \+ 28px\); top: 24px;/.test(css) && !/\.coin-id \{[^}]*backdrop-filter/.test(css), "name row sits inside the card (no own pill scrim)");
  ok(wb.includes('"__coinIdH"'), "worker render: __coinIdH forwarded");
  // header card bottom (18 + 130 + row ≤ 64) stays above the Your Position card top (212)
  ok(18 + 130 + 64 <= 212, "header card (max) ends above the Your Position card");
  // pass 3 #2 (lee): ascended shows ASCENDED once (TIER line); no separate badge, the normal bar + '+X% to NEXT' label
  { const tb = eng.slice(eng.indexOf("function drawTierBar(m,ti,leftEnd){"), eng.indexOf("function drawTierBar(m,ti,leftEnd){") + 3000);
    ok(/S\.gradBadge=S\.graduated\?GRAD_BADGE:''; if \(S\.graduated\) S\.tierNeedText='';/.test(tb) && ((c) => !/drawGradBadgeDesk/.test(c) && !/trading on Uniswap/.test(c))(eng.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")), "ascended: no second ASCENDED badge, no 'trading on Uniswap'"); }
  ok(/if\(lb&&\(leftEnd\|\|0\)\+12<=384-ctx\.measureText\(lb\)\.width\) ctx\.fillText\(lb,384,108\);/.test(eng), "curve: the label is dropped rather than drawn over a long TIER line");
  // DISCIPLE status box gone on coin pages, TOP HOLDERS + chat move up
  ok(/const STATUS_BOX=!\(source instanceof DiscipleSource\), STATUS_DY=STATUS_BOX\?100:0;/.test(eng), "no DISCIPLE status box on coin pages");
  const gc = rd("components/gamechat/GameChat.tsx");
  ok(/--ap-status-h", new URLSearchParams\(search\)\.get\("source"\) === "disciple" \? "0px" : "100px"/.test(fc) && /var\(--ap-status-h, 100px\)/.test(gc), "GameChat follows the status box slot");
  const pg = rd("app/coin/[address]/page.tsx");
  ok(/\{CREW_CARD_ENABLED && <CrewPanel coin=\{address\} \/>\}/.test(pg), "CREW card behind CREW_CARD_ENABLED (off by default)");
  // pass 2 (lee, Oct 30): no buy presets / orb-rain unlock on the coin screen even with the flag on — gone from the card itself,
  // and nothing else the coin page mounts renders them
  const noCmt = (t) => t.replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}|(^|[^:])\/\/[^\n]*/g, "$1");
  const crew = noCmt(rd("components/CrewPanel.tsx"));
  ok(!/BUY PRESETS|orb rain|nextUnlock|crew-unlock|Next unlock|ammoTxt/i.test(crew), "CrewPanel: no BUY PRESETS list, no 'Next unlock … orb rain' line");
  const coinSrc = noCmt([pg, fc, rd("components/flight/PhoneHud.tsx"), rd("components/flight/SettingsMenu.tsx"), eng].join("\n"));
  ok(!/orb rain|Next unlock|nextUnlock\(/i.test(coinSrc) && !/BUY PRESETS/.test(coinSrc), "coin page / FlightCanvas / PhoneHud / SettingsMenu / engine: no presets list or orb-rain unlock"); }
console.log(`phone-hud: ${n} checks passed`);
