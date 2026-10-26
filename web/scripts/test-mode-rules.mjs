// Mode rules v2 on the site: lib/modeRules (the one shared cap constant) must match what the contracts enforce
// (contracts/src/libraries/Constants.sol + Launchpad.firstBoostMaxBps), and /create must read it (Easy default, no
// stale 4% → 12% / 0.25% copy). Offline. Run: node scripts/test-mode-rules.mjs   (npm run test:mode-rules)
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { loadLib } from "./lib/load-ts.mjs";
const dir = path.dirname(fileURLToPath(import.meta.url)), web = path.join(dir, ".."), repo = path.join(web, "..");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const rd = (f) => fs.readFileSync(path.join(web, f), "utf8");
const { mods, cleanup } = await loadLib(["modeRules", "config"], "moderules-");
const R = mods.modeRules, C = mods.config;

console.log("— 1. constants = Constants.sol");
const solPath = path.join(repo, "contracts/src/libraries/Constants.sol");
if (fs.existsSync(solPath)) {
  const sol = fs.readFileSync(solPath, "utf8");
  const k = (name) => { const m = sol.match(new RegExp(`constant ${name}\\s*=\\s*([0-9_]+)`)); if (!m) throw new Error("missing " + name); return Number(m[1].replace(/_/g, "")); };
  ok(R.MODE.TRENCH === k("MODE_TRENCH") && R.MODE.EASY === k("MODE_PVE") && R.MODE.HARD === k("MODE_PVP"), "mode ids 0 Trench / 1 Easy / 2 Hard");
  ok(R.HOLDING_CAP_BPS[1].start === k("PVE_CAP_START_BPS") && R.HOLDING_CAP_BPS[1].end === k("PVE_CAP_END_BPS"), "Easy holding cap 1% → 3.33%");
  ok(R.HOLDING_CAP_BPS[2].start === k("PVP_CAP_START_BPS") && R.HOLDING_CAP_BPS[2].end === k("PVP_CAP_END_BPS"), "Hard holding cap 3.33% → 7.77%");
  ok(R.HOLDING_CAP_BPS[0] === null, "Trench: no mode cap");
  ok(R.FIRST_BOOST_MAX_BPS[1] === k("FIRST_BOOST_MAX_BPS_PVE") && R.FIRST_BOOST_MAX_BPS[2] === k("FIRST_BOOST_MAX_BPS_PVP") && R.FIRST_BOOST_MAX_BPS[0] === null, "First BOOST max: Easy 1.2%, Hard 3.33%, Trench live");
  ok(R.CAP_MCAP_START_USD === k("START_MCAP_USD") && R.CAP_MCAP_END_USD === k("GRADUATION_MCAP_USD"), "cap mcap range $3,333 → $33,333");
} else ok(false, "contracts/src/libraries/Constants.sol not found");
ok(R.CAP_MCAP_START_USD === C.CURVE.startMcap && R.CAP_MCAP_END_USD === C.CURVE.graduationMcap, "mcap range = CURVE config");
ok(R.holdingCapRange(1) === "1% → 3.33%" && R.holdingCapRange(2) === "3.33% → 7.77%" && R.holdingCapRange(0) === null, "range labels");
ok(R.DEFAULT_MODE === R.MODE.EASY && R.MODE_ORDER[0] === R.MODE.EASY, "Easy is the default and listed first");
const easy = R.MODE_COPY[1], hard = R.MODE_COPY[2];
ok(/1%/.test(easy) && /3\.33%/.test(easy) && /3\.33%/.test(hard) && /7\.77%/.test(hard), "mode copy states the real caps");
ok(/1% of supply, rising to 3\.33%/.test(easy) && /3\.33% of supply, rising to 7\.77%/.test(hard) && /^No holding cap/.test(R.MODE_COPY[0]), "BRAND r1 copy with the constant's numbers");
ok(![easy, hard, R.MODE_COPY[0], ...Object.values(R.MODE_SELECTED_COPY), R.MODE_HELPER, R.MODE_TOOLTIP].some((t) => /\b(PVE|PVP|bps|NET|TRENCH WARFARE)\b/.test(t)), "mode copy has no dev jargon");

console.log("— 2. /create + First BOOST read the shared constant");
const page = rd("app/create/page.tsx"), abi = rd("lib/launchAbi.ts"), fb = rd("lib/firstBoost.ts");
ok(/useState<number>\(DEFAULT_MODE\)/.test(page), "/create selects Easy by default");
ok(/from "@\/lib\/modeRules"/.test(page) && /copy: MODE_COPY\[id\]/.test(page) && /MODE_SELECTED_COPY\[gameMode\]/.test(page) && /holdingCapRange\(id\)/.test(page), "/create mode copy + caps come from lib/modeRules");
ok(!/4% → 12%|0\.25%|7\.77% tax|\bPVP\b"|label: "PVE"/.test(page), "no stale v1 rules on /create");
ok(/from "\.\/modeRules"/.test(abi) && /FIRST_BOOST_MAX_BPS\[mode\]/.test(abi) && !/MODE_BUY_CAP_BPS/.test(abi), "First BOOST cap reads FIRST_BOOST_MAX_BPS (no stale 0.25% table)");
ok(/return DEFAULT_MODE;/.test(abi), "DEFAULT_LAUNCH_MODE falls back to Easy");
ok((fb.match(/readCreatorBuyQuote\(.*creatorTaxBps, mode\)/g) || []).length === 3, "First BOOST limits quote with the mode-aware overload");
ok(!/first 7 minutes|PVE rockets/.test(fb), "First BOOST copy: no stale window / PVE jargon");

// effectiveCreatorBuyCapBps semantics = Launchpad.firstBoostMaxBps(mode): mode cap replaces creatorBuyMaxBps
const fn = abi.slice(abi.indexOf("export function effectiveCreatorBuyCapBps"), abi.indexOf("/** launchWithMode"));
const eff = new Function("FIRST_BOOST_MAX_BPS", "modesActive", "LAUNCH_ABI_SHAPE", fn.replace("export function", "return function").replace(/: number|: LaunchAbiShape/g, "").replace(/ as const/g, ""))(R.FIRST_BOOST_MAX_BPS, (s) => s === "modes", "modes");
ok(eff(77, 1, "modes").bps === 120 && eff(77, 2, "modes").bps === 333 && eff(77, 0, "modes").bps === 77, "effective First BOOST cap: Easy 1.2%, Hard 3.33%, Trench = creatorBuyMaxBps");
ok(eff(77, 2, "current").bps === 77, "pre-modes ABI: creatorBuyMaxBps");

cleanup();
console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
