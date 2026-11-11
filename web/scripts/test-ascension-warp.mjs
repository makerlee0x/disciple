// game/ascension-warp-effect — warp-speed visual only on an ascension buy (existing graduates / gradNeed flag).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const eng = readFileSync(join(web, "public/flight/engine.js"), "utf8");
const tb = readFileSync(join(web, "components/TradeBridge.tsx"), "utf8");
const rt = readFileSync(join(web, "lib/flight/rapidTap.ts"), "utf8");
let failed = 0;
const ok = (c, msg) => { if (c) console.log("ok  ", msg); else { failed++; console.log("FAIL", msg); } };

ok(/function isAscensionBuy\(side,usd,from,proj\)/.test(eng), "isAscensionBuy uses the existing graduation flags");
ok(/S\.gradNeedUsd!=null&&usd\+1e-9>=S\.gradNeedUsd/.test(eng), "exact $ to graduate (disciple:gradneed / S.gradNeedUsd) counts");
ok(/lo>0&&lo<GRADUATION_MCAP&&hi>=GRADUATION_MCAP/.test(eng), "projected mark crossing GRADUATION_MCAP also counts");
ok(/side!=='buy'\|\|S\.graduated/.test(eng), "sells and already-ascended coins never warp");
ok(/function warpFxOn\(\)\{ return \(S\.pending\|\|\[\]\)\.some\(p=>p\.state==='pending'&&p\.gradBuy\); \}/.test(eng), "effect only while an ascension buy is still pending");
ok(/gradBuy:isAscensionBuy\(side,S\.tradeUsd,from,proj\)/.test(eng), "pending row carries the visual flag; submit path otherwise unchanged");
ok(/function drawWarpSpeed\(\)/.test(eng) && /drawWarpSpeed\(\);/.test(eng), "warp is drawn");
ok(/drawSpeedLines\(\)/.test(eng) && eng.includes("ctx.strokeStyle=b.up?'rgba(235,240,255,.9)':'rgba(255,220,235,.85)'"), "reuses drawSpeedLines stroke colors");
ok(/hash\(i\*19\.17\)/.test(eng) && !/function drawWarpSpeed[\s\S]*?Math\.random/.test(eng.split("function drawWarpSpeed")[1].split("function drawTickTrail")[0]), "warp streaks use hash(), not Math.random (keeps sim RNG)");
ok(!/buyBoost\s*=/.test(eng.split("function drawWarpSpeed")[1].split("function drawTickTrail")[0]), "warp does not fire fill thrust / buyBoost");

// source.submitTrade is still the only send; TradeBridge shoot / runTrade untouched
ok(/source\.submitTrade\(side,S\.tradeUsd,o\)/.test(eng), "submitTrade call unchanged");
ok(/gasKindFor\(side, usd, gradRef\.current/.test(tb) && /hint\.graduates/.test(rt), "existing graduates / gradBuy flag is still what gasKindFor uses (untouched)");
ok(tb.includes('new CustomEvent("disciple:shoot"') && !tb.includes("drawWarpSpeed") && !tb.includes("isAscensionBuy"), "TradeBridge trade-sending code is untouched");

// runtime: the predicate, isolated
const m = eng.match(/function isAscensionBuy\(side,usd,from,proj\)\{[\s\S]*?\n\}/);
ok(!!m, "can extract isAscensionBuy");
if (m) {
  const fn = new Function("S", "GRADUATION_MCAP", m[0] + "; return isAscensionBuy;");
  const S = { graduated: false, gradNeedUsd: 40, confirmed: { mcap: 30000 } };
  const call = (side, usd, from, proj, extra) => fn({ ...S, ...extra }, 33333)(side, usd, from, proj);
  ok(call("buy", 40, 30000, 34000) === true, "buy at exact gradNeedUsd is an ascension buy");
  ok(call("buy", 39, 30000, 32000) === false, "buy short of the need, not crossing the mcap, is not");
  ok(call("sell", 200, 30000, 20000) === false, "a sell is never an ascension buy");
  ok(call("buy", 200, 30000, 40000, { graduated: true }) === false, "already ascended: no warp");
  ok(call("buy", 10, 33000, 34000, { gradNeedUsd: null }) === true, "no exact need, but projected mcap crosses graduation");
  ok(call("buy", 10, 40000, 41000, { graduated: false, gradNeedUsd: null }) === false, "already above graduation mcap without the flag: no");
}

if (failed) { console.error(failed + " ascension-warp check(s) FAILED"); process.exit(1); }
console.log("ascension-warp checks passed");
