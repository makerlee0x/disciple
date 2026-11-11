// game/coin-labels — ticker in the position tag, no "your bag" on holders, TRADE HISTORY header,
// readable LEGACY tag, coin header written as TICKER/QUOTE.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url)), web = path.join(dir, "..");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const rd = (...p) => fs.readFileSync(path.join(web, ...p), "utf8");
const eng = rd("public/flight/engine.js");
const ci = rd("components/pairart/CoinIdentity.tsx");
const gc = rd("components/gamechat/GameChat.tsx");
const css = rd("app/globals.css");
const i18n = rd("lib/game/i18n.ts");
const ph = rd("components/flight/PhoneHud.tsx");

ok(/ctx\.fillText\('TRADE HISTORY',FX\+16,FY-138\)/.test(eng) && !/TRADES · LOCAL \(~SEEN\)/.test(eng), "desktop trades card header is exactly TRADE HISTORY");
ok(/●<\/span> TRADE HISTORY/.test(ph) && !/LIVE TRADES/.test(ph) && !/LOCAL TIME · ~RECEIVED/.test(eng) && !/ctx\.fillText\('TRADE HISTORY',x0/.test(eng), "phone feed header is exactly TRADE HISTORY (PhoneHud; no second engine label in the same band)");
ok(eng.includes("fmtTok(v.size)") && eng.includes("coinTicker()") && !eng.includes("fmtTok(v.size)} tok") && !/ tok`/.test(eng.split("drawPnlTag")[1].split("function fmtMoney")[0]), "position tag shows the ticker (e.g. 3.7K GTNEAR), not tok");
ok(!/your bag:/.test(gc), "holders card no longer prints your bag: $…");
ok(/const sub = ticker && quote \? `\$\{ticker\}\/\$\{quote\}` : ticker/.test(ci) && /const quote = String\(pairSym/.test(ci) && !/`\$\$\{tk\}`/.test(ci) && !/\.join\(" · "\)/.test(ci), "coin header sub is TICKER/QUOTE (GTNEAR/STRATEGY), no $ and no middle dot");
ok(/\.coin-id-txt \.coin-id-legacy/.test(css) && /color: #0B0C0E; background: #C9CED6/.test(css), "LEGACY tag keeps ink #0B0C0E on #C9CED6 with specificity above .coin-id-txt span");
ok(!/TRADE HISTORY|your bag|GTNEAR\/STRATEGY/.test(i18n), "no new i18n keys; existing key structure unchanged (these labels were not i18n keys)");

if (bad) { console.error(bad + " coin-label check(s) FAILED"); process.exit(1); }
console.log("coin-label checks passed");
