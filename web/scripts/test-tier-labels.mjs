// GAME tier labels (lee, Oct 30): one mcap source, ONE tier NAME everywhere (never a number), the current tier always shown,
// ascended (graduated) coins too: "ASCENDED · LAUNCH PAD" (pass 2 undoes #204's hiding of LAUNCH PAD on graduated coins).
// Rule kept (lee, Oct 26, verbatim: "No, keep the tier following price"): a graduated coin's sky tier follows its CURRENT
// price, no floor. The engine's @tier-name helpers run for real; wiring (desktop HUD, phone pill, banner, chat) is source-checked.
//   Run: node scripts/test-tier-labels.mjs
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(web, p), "utf8");
const eng = rd("public/flight/engine.js"), chat = rd("components/gamechat/GameChat.tsx"), tiersTs = rd("lib/flight/tiers.ts");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const block = (a, b) => { const i = eng.indexOf(a), j = eng.indexOf(b, i); if (!(i >= 0 && j > i)) throw new Error("engine block " + a); return eng.slice(i, j); };
const TIERS = JSON.parse(/const FLIGHT_TIERS=(\[.*?\]);/.exec(eng)[1]);
const S = { graduated: false };
const H = new Function("S", "TIERS", "ASCENDED", block("/* @tier-name", "/* @tier-name-end */") + "\nreturn { tierName, tierText };")(S, TIERS, /const ASCENDED='([^']+)'/.exec(eng)[1]);

console.log("— 1. one tier NAME per sky index, never a number; ascended coins keep their current tier name");
ok(H.tierText(0) === "LAUNCH PAD" && H.tierName(0) === "LAUNCH PAD", "on the curve: LAUNCH PAD (no 'TIER 0')");
ok(H.tierText(4) === "OUTER SPACE", "on the curve: OUTER SPACE");
ok(TIERS.every((t, i) => H.tierText(i) === t.name && !/\d/.test(H.tierText(i))), "every tier: the ladder name only, no digits");
S.graduated = true;
ok(H.tierText(0) === "ASCENDED · LAUNCH PAD" && H.tierName(0) === "LAUNCH PAD", "ascended, price in the LAUNCH PAD band: ASCENDED · LAUNCH PAD");
ok(H.tierText(4) === "ASCENDED · OUTER SPACE" && H.tierText(1) === "ASCENDED · OZONE", "ascended: every tier shows its name (sky follows price)");
S.graduated = false;
ok(!/`TIER \$\{/.test(eng) && !/TIER \d/.test(eng.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")), "engine: no 'TIER n' label template left");

console.log("— 2. the rule is unchanged: the tier follows the CURRENT shown mcap, no graduation floor");
{ const hud = block("function drawHud(){", "ctx.save();");
  ok(/ti=clamp\(Math\.floor\(mcapToAlt\(m\)\),0,TIERS\.length-1\)/.test(hud) && /const m=shownMcap\(\)/.test(hud), "drawHud: ti from shownMcap() (the one mcap the PnL / chart / header mark against)");
  ok(!/graduated[^\n]{0,40}Math\.max\(\s*ti|gradFloor|tierFloor/i.test(eng), "no graduated tier floor anywhere in the engine"); }

console.log("— 3. every surface uses the same helper");
ok(/ctx\.fillText\(tierText\(ti\),36,108\)/.test(eng) && !/`TIER \$\{ti\} · \$\{t\.name\}`/.test(eng), "desktop HUD line = tierText(ti) (no other 'TIER n · NAME' template left)");
ok(/b=tierName\(ti\),/.test(block("function drawPhonePill(", "ctx.restore(); }")), "phone pill = $MCAP · tier name (ascended coins too)");
ok(/bn=tierName\(S\.tierShown\);/.test(eng) && !/glowText\(TIERS\[S\.tierShown\]\.name/.test(eng), "tier banner = tierName (the current tier name, ascended coins too)");
ok(/const tl=tierLabel\(m,nx\), lb=P\.drawer\?'':S\.graduated\?\(tl\?`\$\{ASCENDED\} · \$\{tl\}`:ASCENDED\):tl; S\.phoneTierLabel=lb;/.test(eng) && !/S\.graduated\?GRAD_BADGE:tierLabel/.test(eng), "phone caption under the pill: '+X% to NEXT' on every coin; ascended: 'ASCENDED · +X% to NEXT'");

console.log("— 4. ASCENDED reads the same in the HUD and the chat");
{ const ts = /export const GRAD_BADGE = "([^"]+)"/.exec(tiersTs), en = /const GRAD_BADGE='([^']+)'/.exec(eng);
  ok(!!ts && !!en && ts[1] === en[1], `lib/flight/tiers GRAD_BADGE === engine GRAD_BADGE ("${ts && ts[1]}")`);
  ok(!!ts && /^ASCENDED\b/.test(ts[1]) && !/GRADUAT/i.test(ts[1]), "badge says ASCENDED, not GRADUATED");
  ok(/import \{ GRAD_BADGE \} from "@\/lib\/flight\/tiers"/.test(chat) && /data-kind="graduate"[^\n]*\{GRAD_BADGE\}<\/div>/.test(chat), "chat graduation row = GRAD_BADGE");
  ok(!/Outer Space/i.test(chat), "chat: no hard-coded 'Outer Space' tier (or a stale mcap) on the graduation row"); }

if (bad) { console.error(`\n${bad} tier-label check(s) FAILED`); process.exit(1); }
console.log("\nall tier-label checks passed");
