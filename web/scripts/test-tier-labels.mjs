// GAME tier labels (lee, Oct 30): one mcap source, ONE tier name + number everywhere, no "LAUNCH PAD" next to GRADUATED.
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
const H = new Function("S", "TIERS", block("/* @tier-name", "/* @tier-name-end */") + "\nreturn { tierName, tierText };")(S, TIERS);

console.log("— 1. one name + number per sky index");
ok(H.tierText(0) === "TIER 0 · LAUNCH PAD" && H.tierName(0) === "LAUNCH PAD", "on the curve: TIER 0 · LAUNCH PAD (unchanged)");
ok(H.tierText(4) === "TIER 4 · OUTER SPACE", "on the curve: TIER 4 · OUTER SPACE");
S.graduated = true;
ok(H.tierText(0) === "TIER 0" && H.tierName(0) === "", "graduated, price in the tier-0 band: TIER 0 — never 'LAUNCH PAD' next to GRADUATED");
ok(H.tierText(4) === "TIER 4 · OUTER SPACE" && H.tierText(1) === "TIER 1 · OZONE", "graduated: every other tier keeps its name (sky follows price)");
S.graduated = false;

console.log("— 2. the rule is unchanged: the tier follows the CURRENT shown mcap, no graduation floor");
{ const hud = block("function drawHud(){", "ctx.save();");
  ok(/ti=clamp\(Math\.floor\(mcapToAlt\(m\)\),0,TIERS\.length-1\)/.test(hud) && /const m=shownMcap\(\)/.test(hud), "drawHud: ti from shownMcap() (the one mcap the PnL / chart / header mark against)");
  ok(!/graduated[^\n]{0,40}Math\.max\(\s*ti|gradFloor|tierFloor/i.test(eng), "no graduated tier floor anywhere in the engine"); }

console.log("— 3. every surface uses the same helper");
ok(/ctx\.fillText\(tierText\(ti\),36,108\)/.test(eng) && !/`TIER \$\{ti\} · \$\{t\.name\}`/.test(eng), "desktop HUD line = tierText(ti) (no other 'TIER n · NAME' template left)");
ok(/b=tierName\(ti\)\|\|`TIER \$\{ti\}`/.test(block("function drawPhonePill(", "ctx.restore(); }")), "phone pill name = tierName(ti) (TIER 0 when graduated)");
ok(/bn=tierName\(S\.tierShown\)\|\|`TIER \$\{S\.tierShown\}`/.test(eng) && !/glowText\(TIERS\[S\.tierShown\]\.name/.test(eng), "tier banner = tierName (no LAUNCH PAD banner on a graduated coin)");
ok(/S\.graduated\?GRAD_BADGE:tierLabel\(f,nx\)/.test(eng), "phone caption under the pill: the GRADUATED badge on a graduated coin");

console.log("— 4. GRADUATED reads the same in the HUD and the chat");
{ const ts = /export const GRAD_BADGE = "([^"]+)"/.exec(tiersTs), en = /const GRAD_BADGE='([^']+)'/.exec(eng);
  ok(!!ts && !!en && ts[1] === en[1], `lib/flight/tiers GRAD_BADGE === engine GRAD_BADGE ("${ts && ts[1]}")`);
  ok(/import \{ GRAD_BADGE \} from "@\/lib\/flight\/tiers"/.test(chat) && /data-kind="graduate"[^\n]*\{GRAD_BADGE\}<\/div>/.test(chat), "chat graduation row = GRAD_BADGE");
  ok(!/Outer Space/i.test(chat), "chat: no hard-coded 'Outer Space' tier (or a stale mcap) on the graduation row"); }

if (bad) { console.error(`\n${bad} tier-label check(s) FAILED`); process.exit(1); }
console.log("\nall tier-label checks passed");
