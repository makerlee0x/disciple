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
ok(labels.join() === "Feed,Holders,Chart,Crew,Chat,Run", "six drawer tabs from the mockup");
ok(!/PHONE_TABS|phone-tabs|"STAT"|"T\/W"/.test(hud), "old 8 edge tabs removed");
ok(/data-testid="phone-dim" onPointerDown=\{\(e\) => \{ e\.preventDefault\(\); setSheet\(null\); \}\}/.test(hud), "tap the dimmed sky closes");
ok(/e\.clientY - s\.y > 36\) setSheet\(null\)/.test(hud) && /e\.key === "Escape" && sheetRef\.current\) setSheet\(null\)/.test(hud), "swipe down / Esc close");
ok(/dy < -18 \|\| Math\.abs\(dy\) < 8\) setSheet\(lastTab\.current\)/.test(hud), "swipe up / tap the handle opens");
ok(/\[data-testid="phone-drawer"\]'\);/.test(sm), "Esc with the drawer open closes it (Settings does not open)");
ok(/new URLSearchParams\(location\.search\)\.get\("clean"\) === "1"\) return/.test(hud) && /if \(!phone \|\| !L\) return null;/.test(hud), "?clean=1 / desktop render nothing");
ok(hud.match(/DRAWER_BG = "([^"]+)"/)[1] === eng.match(/const PH_DRAWER_BG='([^']+)'/)[1], "drawer tint == engine body tint");
ok(/html\.ap-phone \[data-testid="settings-btn"\]/.test(hud) && !/phone-settings/.test(hud), "gear hidden on phone; no interim Run-tab Settings button (SITE Sidebar 'Settings' item, #149)");
ok(/html\.ap-phone #exitX \{ top: 12px !important; right: var\(--ph-x-right\)/.test(hud), "one glass ✕ in the top row");
// 3) engine gating: desktop branches unchanged, phone draws pill + the open drawer tab only
const ph = new Function("window", `const HUD_NARROW_W=740;\n${eng.match(/function phoneHud\(w,clean\)\{[^\n]+/)[0]}\nreturn phoneHud;`);
const P = { on: true, sheet: null };
ok(ph({ __phoneHud: P })(390, false) === P && ph({ __phoneHud: P })(1440, false) === null && ph({ __phoneHud: P })(390, true) === null && ph({})(390, false) == null, "phoneHud(): phone only, never CLEAN / desktop");
for (const re of [/if \(PH\) drawPhonePill\(m,ti,PH\); else \{\n  \/\/ top-left: MCAP \+ tier\n  panel\(20,18,380,130\);/, /if \(!PH\)\{\n  panel\(RX,RT,CW,92\);/,
  /else if \(!S\.kothDocked\)\{ panel\(RX,RT\+100,CW,96\);/, /else \{ const FX=20, FY=H, FW=310;/, /if \(S\.controlsDocked\) pushControls\(\); else if \(!PH\) \{ panel\(RX,H-104,310,84\);/,
  /PH\.sheet==='holders'\) drawPhoneHolders\(PH,top,kothTitle\)/, /PH\.sheet==='feed'\) drawPhoneFeed\(PH\)/, /if \(PH\) AMMO_HIT\.forEach\(R=>\{ R\.x=-1e9;/,
  /return P\.sheet==='chart'&&B\?\{x:/, /if\(P\?P\.sheet!=='chart':!C\.on\) return;/, /PD&&PD\.drawer&&PD\.dTop>0\?Math\.min\(ROCKET_Y,PD\.dTop-44\):ROCKET_Y/])
  ok(re.test(eng), "engine: " + re.source.slice(0, 60));
ok(!/drawPhonePresets|drawPhoneMcap/.test(eng), "no canvas preset chips / big mcap card on phones");
ok(/a 'SIM' tag in paper \/ simulated market \(final/.test(eng) && /const sim=source\.isSim\|\|!isLive\(\);/.test(eng) && eng.split("\n").filter((l) => /PLACEHOLDER/.test(l)).every((l) => /PLACEHOLDER copy \(pending lee \+ BRAND\)/.test(l)), "SIM tag (final) on paper / sim; only the post-grad copy is marked PLACEHOLDER (pending lee + BRAND)");
ok(/\{ id: "run", label: "Run" \}/.test(hud) && /data-ph-sheet="run"\] \.ap-bc:has\(> \[data-testid="tw-open"\]\)/.test(hud) && /data-ph-sheet="run"\] \[data-testid="tw-list"\]/.test(hud), "tramps & walls live under Run (no T/W tab)");
// 3b) @tier-label: "X% to NEXT_TIER" from the same log progress as the bar (phone pill + desktop tier bar)
{
  const tiersSrc = rd("lib/flight/tiers.ts");
  const TIERS = [...tiersSrc.matchAll(/\{ name: "([^"]+)", lo: ([\d._e]+), hi: ([\d._e]+)/g)].map((m) => ({ name: m[1], lo: +m[2].replace(/_/g, ""), hi: +m[3].replace(/_/g, "") }));
  ok(TIERS.length >= 18 && TIERS[4].name === "OUTER SPACE", "tiers parsed");
  const blk = eng.slice(eng.indexOf("/* @tier-label ("), eng.indexOf("/* @tier-label-end */"));
  // monospace stub: 0.6em per glyph
  const ctx = { font: "", save() {}, restore() {}, measureText: (t) => ({ width: String(t).length * 0.6 * +(ctx.font.match(/(\d+)px/) || [0, 10])[1] }) };
  let rules = "";
  const TL = new Function("TIERS", "clamp", "ctx", "tierRulesText", "S", blk + "\nreturn {tierProgress,tierLabel,tierLineEnd};")(TIERS, (v, a, b) => Math.max(a, Math.min(b, v)), ctx, () => rules, { graduated: false });
  const lab = (m, ti) => { const p = TL.tierProgress(m, ti); return TL.tierLabel(p.f, p.next); };
  // 34% of the KÁRMÁN LINE band (log) → "34% to OUTER SPACE"
  const k = TIERS[3], m34 = k.lo * Math.pow(TIERS[4].lo / k.lo, 0.345);
  ok(lab(m34, 3) === "34% to OUTER SPACE", `example label (${lab(m34, 3)})`);
  ok(lab(TIERS[13].lo, 13) === "0% to SERAPHIM", "start of a tier → 0%");
  ok(lab(TIERS[14].lo * 0.9999, 13) === "99% to SERAPHIM", "whole percent rounded down: never 100% before the tier is reached");
  ok(lab(94.19e6, 13) === `${Math.floor((Math.log(94.19e6 / 77e6) / Math.log(120e6 / 77e6)) * 100)}% to SERAPHIM`, "same log progress as the bar fill");
  ok(lab(1e3, 0) === "0% to OZONE", "below the floor clamps to 0%");
  const top = TIERS.length - 1; ok(lab(TIERS[top].lo * 1.5, top) === "", "top tier: no label (desktop keeps ★ TOP TIER)");
  for (let i = 0; i < top; i++) { const L = lab(TIERS[i].lo * 1.01, i); ok(L.endsWith(" to " + TIERS[i + 1].name) && TIERS[i + 1].name === TIERS[i + 1].name.toUpperCase(), `tier ${i}: names the next tier in caps`); }
  // desktop: right-aligned at 384 on the TIER line, never over the TIER text / rules text
  ok(/function drawTierBar\(m,ti,leftEnd\)\{\n  const t=TIERS\[ti\], \{f,next:nx\}=tierProgress\(m,ti\);/.test(eng), "desktop bar uses tierProgress");
  ok(/let lb=tierLabel\(f,nx\); if\(lb&&\(leftEnd\|\|0\)\+12>384-ctx\.measureText\(lb\)\.width\) lb=lb\.slice\(0,lb\.indexOf\(' to '\)\);[^\n]*\n    if\(lb\) ctx\.fillText\(lb,384,108\);/.test(eng), "desktop: label at the bar's right end, falls back to the bare % if the TIER line is long");
  ok(/const tierEnd=tierLineEnd\(ti,t\);[^\n]*\n  drawTierBar\(m,ti,tierEnd\);/.test(eng), "desktop passes the TIER line end");
  rules = ""; const e0 = TL.tierLineEnd(13, TIERS[13]); ctx.font = "10px"; const w0 = ctx.measureText("39% to SERAPHIM").width;
  ok(e0 + 12 <= 384 - w0, "desktop: CHERUBIM line + label fit side by side");
  let worst = 0; for (let i = 0; i < top; i++) { ctx.font = "10px"; const w = ctx.measureText("99% to " + TIERS[i + 1].name).width; worst = Math.max(worst, TL.tierLineEnd(i, TIERS[i]) + 12 + w); }
  ok(worst <= 384, `desktop: every tier's line + label fits without rules text (worst ${worst.toFixed(0)} ≤ 384)`);
  rules = "EASY · cap 1% of supply per wallet".slice(0, 28); ok(TL.tierLineEnd(16, TIERS[16]) > 384 - 12 - 6 * "99% to SEVENTH HEAVEN".length, "long rules text triggers the bare-% fallback");
  // phone: one quiet caption centred under the pill; toasts move down to make room; fits 360/390 and the rocket room
  ok(/const lb=P\.drawer\?'':S\.graduated\?GRAD_BADGE:tierLabel\(f,nx\); S\.phoneTierLabel=lb;/.test(eng) && /ctx\.fillText\(phFit\(lb,W-48\),x\+w\/2,y\+h\+13\)/.test(eng), "phone: caption under the pill, fitted to the width, hidden while the drawer is open");
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
  ok(floorTop >= L.pillTop + 46 + 22, `${w}: floor pill starts below the mcap pill + its caption / GRADUATED badge (${floorTop} vs pill ${L.pillTop}–${L.pillTop + 46})`);
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
// desktop: the "Your Run" card never covers the live chart (lee, Oct 30; prod 1366×680: card bottom 448, chart top 376)
{ const blk = eng.slice(eng.indexOf("/* @chart-desk:"), eng.indexOf("/* @chart-desk-end */"));
  const consts = eng.match(/const CHART_PNL_BOTTOM=[^;]+;/)[0];
  const R = new Function("clamp", `${consts}\n${blk}\nreturn chartDeskRect;`)((v, a, b) => Math.max(a, Math.min(b, v)));
  for (const [H, pb] of [[680, 448], [680, 282], [800, 448], [900, 448], [900, 282], [1080, 448]]) { const r = R(H, 196, pb);
    ok(r.y >= pb + 8 && r.h >= 100 && r.h <= 196, `desktop ${H}px tall, card bottom ${pb}: chart y ${r.y} h ${r.h} starts under the card`); }
  ok(R(900, 196, 282).y + R(900, 196, 282).h === 900 - 172, "room to spare: the chart keeps its place right above the trades feed");
  ok(R(900, 196, null).y + R(900, 196, null).h === 728 && R(900, 196, null).y >= 456, "no card bottom published: the old 456 px budget");
  ok(/return chartDeskRect\(H,st\.h,typeof window!=='undefined'\?window\.__pnlBottom:null\); \}/.test(eng), "chartRect (desktop live) uses the card's published bottom");
  ok(wb.includes('"__pnlBottom"'), "worker render: __pnlBottom forwarded with the other globals");
  ok(/w\.__pnlBottom = !isPhone\(\) && r\.height > 0 \? Math\.round\(r\.bottom - top\) : null/.test(pnl) && /new ResizeObserver\(pub\)/.test(pnl), "PnlHud publishes its bottom (desktop only, tracks open / collapse)");
  ok(/matchMedia\?\.\("\(max-height: 767px\)"\)\.matches\) setOpenS\(false\)/.test(pnl), "short desktop: the card starts collapsed (chart keeps its full height)"); }
console.log(`phone-hud: ${n} checks passed`);
