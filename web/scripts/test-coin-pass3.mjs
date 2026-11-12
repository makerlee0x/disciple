// Coin screen pass 3 (lee, Oct 30): YOUR POSITION card, one ASCENDED, chart navigation (now the DOM DEX chart), card layout (engine side), the
// Chat / Holders tab overlap, rocket height = f(price) only (no drift / snap-back), live own-sell bombs.
// Static + pure-slice checks (no browser): node scripts/test-coin-pass3.mjs
import { readFileSync } from "node:fs";
const rd = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let n = 0, bad = 0;
const ok = (c, m) => { n++; if (c) console.log("ok  ", m); else { bad++; console.log("FAIL", m); } };
const eng = rd("public/flight/engine.js"), code = eng.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:'"\\])\/\/[^\n]*/g, "$1");
const slice = (a, b) => { const i = eng.indexOf(a), j = eng.indexOf(b, i); if (i < 0 || j < 0) throw new Error("marker " + a); return eng.slice(i, j); };

// ───────────── 1. YOUR POSITION ─────────────
console.log("— 1. YOUR POSITION card");
{ const hud = rd("components/PnlHud.tsx"), i18n = rd("lib/game/i18n.ts"), pnl = rd("lib/pnl.ts");
  ok(/t\("pnl\.yourPosition"\)/.test(hud) && !/pnl\.yourRun/.test(hud + i18n), "title = pnl.yourPosition (pnl.yourRun gone everywhere)");
  ok(/"pnl\.yourPosition": "YOUR POSITION"/.test(i18n) && (i18n.match(/"pnl\.yourPosition":/g) || []).length === 5, "i18n: YOUR POSITION in all 5 locales");
  const body = hud.slice(hud.indexOf("{open && ("));
  ok(!/t\("pnl\.mcap"\)/.test(body), "no MCAP row in the card");
  ok(/data-testid="pnl-holdings-tokens">\{fmtTokens\(v\.size\)\}/.test(body) && /<Num value=\{v\.valueUsd\} fmt=\{fmtMoney\} \/>/.test(body), "HOLDINGS = token amount · $ value");
  ok(/t\("pnl\.avgEntry"\)|avgEntry/.test(body) && /realized/i.test(body) && /v\.uPnl/.test(hud), "AVG ENTRY, REALIZED and the PnL kept");
  const src = pnl.slice(pnl.indexOf("export function fmtTokens")); const fn = new Function(src.slice(0, src.indexOf("\n}") + 2).replace("export ", "").replace(/\(v: number\): string/, "(v)") + "\nreturn fmtTokens;")();
  ok(fn(0) === "0" && fn(-1) === "0" && fn(NaN) === "0" && fn(0.004) === "<0.01" && fn(12.345) === "12.35" && fn(1500) === "1.50K" && fn(2.5e6) === "2.50M" && fn(3e9) === "3.00B", `fmtTokens: 0 / <0.01 / 12.35 / 1.50K / 2.50M / 3.00B`); }

// ───────────── 2. header card ─────────────
console.log("— 2. header card: ASCENDED once, no Uniswap, no mode text");
{ ok(/const GRAD_BADGE='ASCENDED';/.test(eng) && /export const GRAD_BADGE = "ASCENDED";/.test(rd("lib/flight/tiers.ts")), "GRAD_BADGE = 'ASCENDED' (engine + lib/flight/tiers)");
  ok(!/trading on Uniswap/.test(code) && !/trading on Uniswap/.test(rd("lib/flight/tiers.ts").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")), "no 'trading on Uniswap' text drawn");
  ok(!/drawGradBadgeDesk/.test(code), "no second ASCENDED badge under the tier line");
  const hud = slice("function drawHud(){", "// progress to next tier");
  ok(/ctx\.fillText\(tierText\(ti\),36,108\);/.test(hud) && !/tierRulesText\(\)/.test(hud.replace(/\/\/[^\n]*/g, "")), "TIER line = tier text only (no 'TRENCH · no cap' / mode / cap)");
  // tierText: ascended ⇒ 'ASCENDED · NAME' — the word once
  const tt = new Function("S", "tierName", "ASCENDED", eng.match(/function tierText\(ti\)\{[^\n]*\}/)[0] + "\nreturn tierText;");
  const once = (s) => (s.match(/ASCENDED/g) || []).length;
  ok(once(tt({ graduated: true }, () => "OUTER SPACE", "ASCENDED")(4)) === 1 && once(tt({ graduated: false }, () => "OUTER SPACE", "ASCENDED")(4)) === 0, "tier line: ASCENDED exactly once when ascended, never otherwise"); }

// ───────────── 3. chart navigation → the DOM DEX chart (Oct 30) ─────────────
console.log("— 3. chart: hand-rolled pan / zoom retired; the DOM DEX chart (lightweight-charts) owns navigation");
{ ok(!/CHART_NAV_MIN|chartPanEnd|chartZoomView|function chartHit|chartResetView|'⟲ LIVE'|C\.vEnd/.test(code), "engine @chartnav pan / zoom / LIVE code removed");
  ok(!/GRID_COLS|'ABCDEFGH'/.test(code) && !/fillText\(String\(j\+1\)/.test(code), "no A–H / 1–5 spreadsheet grid labels");
  ok(/function domChart\(\)\{ return !CLEAN&&typeof window!=='undefined'&&!!window\.__domChart; \}/.test(eng), "engine gate: window.__domChart (never in CLEAN replays)");
  ok(/if\(domChart\(\)\)\{ delete CARD_RECTS\.chart; return \{x:-1e4,y:-1e4,w:st\.w,h:st\.h,off:1\}; \}/.test(eng) && /chartSample\(\); if\(domChart\(\)\) return;/.test(eng), "DOM chart mounted ⇒ canvas chart not drawn / hit / published (history fetch still seeds the feed)");
  ok(/if\(domChart\(\)\)\{ try\{ dispatchEvent\(new CustomEvent\('disciple:chartmap'/.test(eng), "M toggles the DOM chart card");
  ok(/"__domChart"/.test(rd("lib/flight/workerBridge.ts")), "worker render mirrors window.__domChart");
  const dc = rd("components/flight/DexChart.tsx");
  ok(/w\.__domChart = true/.test(dc) && /addEventListener\("disciple:chartmap"/.test(dc), "DexChart sets the gate and listens for M"); }

// ───────────── 4. cards (engine side; persistence: scripts/test-card-layout.mts) ─────────────
console.log("— 4. movable cards (engine)");
{ const blk = slice("function cardOff(r,c,W,H){", "/* @cards-math-end */"), cardOff = new Function(blk + "\nreturn cardOff;")();
  const r = { x: 20, y: H0(), w: 310, h: 140 }; function H0() { return 600; }
  ok(JSON.stringify(cardOff(r, { dx: 50, dy: -30 }, 1366, 768)) === '{"dx":50,"dy":-30}', "inside the viewport: the raw offset");
  ok(JSON.stringify(cardOff(r, { dx: 5000, dy: 5000 }, 1366, 768)) === JSON.stringify({ dx: 1366 - 310 - 20, dy: 768 - 140 - 600 }), "dragged past the right / bottom edge ⇒ clamped inside");
  ok(JSON.stringify(cardOff(r, { dx: -999, dy: -999 }, 1366, 768)) === JSON.stringify({ dx: -20, dy: -600 }), "past the left / top edge ⇒ clamped at 0,0");
  ok(cardOff({ x: 20, y: 18, w: 380, h: 190 }, { dx: 300, dy: 0 }, 300, 768).dx === -20, "card wider than the window pins to the left");
  for (const id of ["header", "trades", "controls"]) ok(new RegExp(`cardBegin\\('${id}',`).test(eng), `canvas card '${id}' drawn through cardBegin (offset / min / close)`);
  ok(/data-card="chart"/.test(rd("components/flight/DexChart.tsx")) && /chart: '\[data-card="chart"\]'/.test(rd("components/flight/CardChrome.tsx")), "chart card: the DOM DexChart (data-card=chart) located by CardChrome");
  ok(/drawChartMap\(\); cardPublish\(\);/.test(eng) && /dispatchEvent\(new CustomEvent\('disciple:cardrects'/.test(eng), "engine publishes the drawn card rects (on change)");
  ok(/addEventListener\('disciple:cardlayout'/.test(eng) && /"disciple:cardlayout"/.test(rd("lib/flight/workerBridge.ts")) && /"__cardLayout"/.test(rd("lib/flight/workerBridge.ts")), "layout reaches the engine live (event, worker-forwarded) and at boot (global)");
  ok(/function cardState\(id\)\{ if\(CLEAN\|\|phoneHud\(W,CLEAN\)\) return null;/.test(eng), "phone / clean replay: no layout (drawers unchanged)");
  ok(!/cardBegin\('ammo'/.test(eng), "buy / sell ammo panel is not moved (FLOW's warning paths untouched)"); }

// ───────────── 5. Chat / Holders tabs ─────────────
console.log("— 5. only the active tab renders");
{ const gc = rd("components/gamechat/GameChat.tsx");
  ok(/\{tab === "holders" && <HoldersView h=\{holders\} \/>\}/.test(gc) && /display: tab === "chat" \? "contents" : "none"/.test(gc), "dock: HOLDERS list only on its tab, chat list hidden otherwise");
  ok(/h\?\.title \|\| "TOP HOLDERS · loading…"/.test(gc) && !/KING OF THE HILL · top boosters"\}/.test(gc), "loading holders: 'TOP HOLDERS · loading…' (not the legacy KING OF THE HILL title)");
  ok(/\{!h \? null : h\.items \?/.test(gc), "no 'no boosters yet' flash before the first holders push");
  ok(/w\.__chatDockOpen = !!\(api && open\)/.test(gc) && /"__chatDockOpen"/.test(rd("lib/flight/workerBridge.ts")), "dock open state published as a global (worker-mirrored)");
  // engine: the canvas TOP HOLDERS box never draws under an open dock, even before disciple:chatdock arrives
  const kd = new Function("S", "window", eng.match(/function kothDockedNow\(\)\{[^\n]*\}/)[0] + "\nreturn kothDockedNow;");
  ok(kd({ kothDocked: false }, { __chatDockOpen: true })() === true && kd({ kothDocked: true }, {})() === true && kd({ kothDocked: false }, {})() === false, "kothDockedNow: event OR window flag");
  ok(!/cardBegin\('holders'/.test(eng) && /\n  pushHolders\(top,kothTitle\);/.test(eng), "no canvas TOP HOLDERS card (lee Oct 31); holders always pushed to the chat HOLDERS tab");
  ok(/lastHolders\.current === 0 \|\| quiet > 3000/.test(gc) && /\}, 400\);/.test(gc), "re-announce every 400 ms until the first holders push (was 3 s)"); }

// ───────────── 6. rocket height = f(price) ─────────────
console.log("— 6. rocket motion: no drift, no snap-back");
{ const cam = slice("/*CAMERA-BEGIN*/", "/*CAMERA-END*/");
  const C = new Function(cam + "\nreturn {altSpring,cameraFollow,rocketScreenY};")();
  const PX = 600, H = 800, ANCH = 480, dt = 1 / 60;
  const sim = (st, target, secs, rec) => { for (let i = 0; i < secs / dt; i++) { C.altSpring(st, target, dt, 10, 1); C.cameraFollow(st, PX, dt); const ry = C.rocketScreenY(ANCH, (st.displayAlt - st.camPx / PX) * PX, H); rec && rec(st, ry); } return st; };
  // pure function of price after settle: the same price ⇒ the same altitude, whatever the path
  { const a = sim({ displayAlt: 2 }, 3, 3), b = sim(sim({ displayAlt: 5 }, 1, 2), 3, 3);
    ok(a.displayAlt === 3 && b.displayAlt === 3 && a.camPx === b.camPx, "after settle: altitude = f(price) exactly (path-independent, no drift)"); }
  // buy: rises to the confirmed price and never sinks below it (no overshoot, no hop decaying back)
  { let maxAlt = -1, minAfterPeak = Infinity, peaked = false; const st = { displayAlt: 2 };
    sim(st, 2.4, 4, (s) => { if (s.displayAlt > maxAlt) maxAlt = s.displayAlt; if (s.displayAlt >= 2.4 - 1e-9) peaked = true; if (peaked) minAfterPeak = Math.min(minAfterPeak, s.displayAlt); });
    ok(maxAlt <= 2.4 + 1e-12 && peaked && minAfterPeak >= 2.4 - 1e-12, `buy: rises to the confirmed price, never above and never sinks back (max ${maxAlt.toFixed(6)})`); }
  // full sell: drops to the new price, never floats back up
  { const st = { displayAlt: 3 }; let prev = 3, up = 0; sim(st, 1.2, 4, (s) => { if (s.displayAlt > prev + 1e-12) up++; prev = s.displayAlt; });
    ok(up === 0 && st.displayAlt === 1.2, "full sell: monotonic down to the new price, no float-back"); }
  // camera locked ⇒ the rocket sits at the anchor (no on-screen rise-then-sink as a lagging camera catches up)
  { const st = { displayAlt: 2 }; let maxOff = 0; sim(st, 2.6, 3, (s, ry) => { maxOff = Math.max(maxOff, Math.abs(ry - ANCH)); });
    ok(maxOff < 1e-9, `rocket screen y stays on the anchor through a price move (max off ${maxOff.toExponential(1)} px)`); }
  // flat price ⇒ nothing moves (stop buying: no glitch down)
  { const st = sim({ displayAlt: 2.5 }, 2.5, 1); const a0 = st.displayAlt, c0 = st.camPx; sim(st, 2.5, 5);
    ok(st.displayAlt === a0 && st.camPx === c0 && st.altVel === 0, "flat price: altitude and camera perfectly still"); }
  const step = slice("const SPRING_W=10, SPRING_Z=1.0;", "// idle bob");
  ok(/altSpring\(S, target, dt, SPRING_W, SPRING_Z\);/.test(step) && /cameraFollow\(S, PX_PER_ALT, dt\);/.test(step) && !/stepCamera\(S/.test(step), "simStep: spring + locked camera (no stepCamera chase)");
  ok(/S\.ry=rocketScreenY\(S\.anch,\(S\.displayAlt-S\.camAlt\)\*PX_PER_ALT,H\) \+ 40\*\(S\.dive\|\|0\);/.test(step) && !/buyBoost|wBoost/.test(step.match(/S\.ry=[^\n]*/)[0]), "no buy / W screen hop (they decayed back = the sink)");
  const ds = slice("class DiscipleSource {", "\n}\n");
  ok(!/this\.dv=setInterval/.test(ds), "paper offset holds: no decay timer floating the price back"); }

// ───────────── 7. live own-sell bombs ─────────────
console.log("— 7. bombs on live own sells");
{ const blk = slice("function rcptSellImpactPct(d,usd){", "/* @bombimpact-end */");
  const mk = (source) => new Function("source", blk + "\nreturn rcptSellImpactPct;")(source);
  const curve = { impact: (usd, side) => side === "sell" ? 1 - Math.min(0.9, usd / 3500) : 1 + usd / 3500 };   // stand-in curve
  ok(mk(curve)({ txHash: "0xabc", side: "sell", usd: 2500 }, 2500) > 50, "receipt without impactPct ⇒ the source's impact (≈71% ⇒ ATOM range)");
  ok(mk(curve)({ impactPct: -6 }, 2500) === 6, "receipt impactPct wins when present (abs)");
  ok(mk(null)({}, 100) === 0 && mk({ impact: () => { throw new Error("x"); } })({}, 100) === 0 && mk({ impact: () => NaN })({}, 100) === 0, "no source / throwing / NaN impact ⇒ 0 (a puff, never a crash)");
  const tiers = new Function(slice("const BOMB_PCT=", "/* Single seam") + "\nreturn bombTierOf;")();
  ok(tiers(mk(curve)({}, 2500)) >= 4 && tiers(mk(curve)({}, 20)) === 0, "big own sell ⇒ a real bomb tier; dust ⇒ puff");
  // the old path: estimateImpactPct alone returned 0 for a DISCIPLE source (no pool L) — the regression
  const est = new Function("source", eng.match(/function estimateImpactPct\(trade\)\{[\s\S]*?\n\}/)[0] + "\nreturn estimateImpactPct;")(curve);
  ok(est({ side: "sell", usd: 2500 }) === 0, "root cause reproduced: estimateImpactPct(receipt) = 0 without source.L");
  ok(/noteSell\(\{side:'sell',usd,impactPct:rcptSellImpactPct\(d,usd\),trader:null,mine:true,fullStack:fs\}\)/.test(eng), "onFillReceipt feeds noteSell the receipt impact");
  ok(!/impactPct:d\.impactPct/.test(code), "no receipt path passes the (missing) d.impactPct straight through"); }

console.log(bad ? `${bad}/${n} FAILED` : `coin-pass3: ${n} checks passed`);
if (bad) process.exit(1);
