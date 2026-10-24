// GAME exit confirm (game/exit-confirm): "Leave the mission?" before leaving a flight. Offline:
//   1. lib/game/exitGuard decisions (which clicks / Back presses leave the flight; guard history state; focus wrap)
//   2. copy lives in lib/game/i18n (exitc.*), English only, other locales fall back (NEEDS_REVIEW), no exclamation marks
//   3. component wiring: armed only while the flight is live, ✕ + links + Back + beforeunload, Esc / backdrop = Stay,
//      Stay default focus, no key listener while closed (trading hotkeys untouched), SettingsMenu look
//   Run: node scripts/test-exit-confirm.mjs   (npm run test:exit-confirm)
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { loadLib } from "./lib/load-ts.mjs";
const dir = path.dirname(fileURLToPath(import.meta.url)), web = path.join(dir, "..");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const rd = (f) => fs.readFileSync(path.join(web, f), "utf8");
const { mods, cleanup } = await loadLib(["game/exitGuard"], "exitc-");
const G = mods["game/exitGuard"];
const HERE = "https://disciple-pearl.vercel.app/coin/0xabc0000000000000000000000000000000000001?cs=SETH";
const click = (o = {}) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...o });
const abs = (p) => new URL(p, HERE).href;

console.log("— 1. guard decisions");
ok(G.leavesFlight(HERE, abs("/")), "✕ → / leaves the flight");
ok(G.leavesFlight(HERE, abs("/leaderboard")) && G.leavesFlight(HERE, abs("/coin/0xdef")), "rail link / another coin leaves the flight");
ok(!G.leavesFlight(HERE, abs("?cs=SETH&grass=1")) && !G.leavesFlight(HERE, abs("#chat")), "same path (query / hash) stays in the flight");
ok(!G.leavesFlight(HERE, HERE.replace("?", "/?")), "trailing slash is the same page");
ok(G.leavesFlight(HERE, "https://x.com/disciple"), "external site in the same tab leaves");
ok(!G.leavesFlight(HERE, "mailto:a@b.c") && !G.leavesFlight(HERE, "javascript:void 0"), "mailto: / javascript: are not a page change");
ok(G.interceptClick(click(), { href: abs("/") }, HERE) === abs("/"), "plain left click on ✕ → confirm");
for (const k of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) ok(G.interceptClick(click({ [k]: true }), { href: abs("/") }, HERE) === null, `${k}+click (new tab/window) is not intercepted`);
ok(G.interceptClick(click({ button: 1 }), { href: abs("/") }, HERE) === null, "middle click is not intercepted");
ok(G.interceptClick(click({ defaultPrevented: true }), { href: abs("/") }, HERE) === null, "a click some handler already took is left alone");
ok(G.interceptClick(click(), { href: abs("/"), target: "_blank" }, HERE) === null, "target=_blank is not intercepted");
ok(G.interceptClick(click(), { href: abs("/"), target: "_self" }, HERE) === abs("/"), "target=_self is intercepted");
ok(G.interceptClick(click(), { href: abs("/x.png"), download: true }, HERE) === null, "download links are not intercepted");
ok(G.interceptClick(click(), { href: abs("/"), optOut: true }, HERE) === null, `${G.OPT_OUT_ATTR} opts a link out`);
ok(G.interceptClick(click(), null, HERE) === null, "click outside any link → nothing");
ok(G.interceptClick(click(), { href: abs("?grass=1") }, HERE) === null, "in-flight query link → nothing");
ok(G.backNeedsConfirm({ __NA: true }, HERE, HERE), "Back pops the guard entry (same URL, no guard mark) → confirm");
ok(!G.backNeedsConfirm({ [G.GUARD_KEY]: 1 }, HERE, HERE), "Forward onto the guard entry → no dialog");
ok(!G.backNeedsConfirm(null, abs("/"), HERE), "popstate that already left the flight route → no dialog");
const s = G.guardState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: [1] });
ok(s.__NA === true && Array.isArray(s.__PRIVATE_NEXTJS_INTERNALS_TREE) && s[G.GUARD_KEY] === 1, "guard entry keeps Next's history fields (its pushState passes it through) + the mark");
ok(G.guardState(null)[G.GUARD_KEY] === 1, "guard entry from an empty state");
ok(G.nextFocus(0, false) === 1 && G.nextFocus(1, false) === 0 && G.nextFocus(0, true) === 1 && G.nextFocus(1, true) === 0, "Tab / Shift+Tab wrap Stay ↔ Leave");
console.log("— 1b. secondary line variants");
const K = (m, p) => G.secondaryKeys(m, p).join(",");
ok(K("live") === "exitc.note.live" && K("live", { buy: 0, sell: 0 }) === "exitc.note.live", "live, nothing pending → coins line only");
ok(K("sim") === "exitc.note.sim" && K("sim", { buy: 2, sell: 1 }) === "exitc.note.sim", "sim / practice → practice line only (no on-chain line)");
ok(K("live", { buy: 1, sell: 0 }) === "exitc.note.live,exitc.note.boost", "live + pending BOOST → + BOOST line");
ok(K("live", { buy: 0, sell: 1 }) === "exitc.note.live,exitc.note.dump", "live + pending DUMP → + DUMP line");
ok(K("live", { buy: 1, sell: 1 }) === "exitc.note.live,exitc.note.boost,exitc.note.dump", "both pending → both lines");
ok(K("live", null) === "exitc.note.live", "pending side unknown → no on-chain line");
cleanup();

console.log("— 2. copy (lib/game/i18n)");
const i18n = rd("lib/game/i18n.ts");
const en = i18n.slice(i18n.indexOf("const en = {"), i18n.indexOf("} as const;"));
const get = (k) => (en.match(new RegExp(`"${k.replace(".", "\\.")}":\\s*"([^"]*)"`)) || [])[1];
ok(get("exitc.title") === "Leave the mission?", `title: ${get("exitc.title")}`);
ok(get("exitc.body") === "The mission continues, with or without you.", `body: ${get("exitc.body")}`);
ok(get("exitc.stay") === "Stay" && get("exitc.leave") === "Leave", "buttons: Stay / Leave");
ok(get("exitc.note.live") === "Your coins stay. This run's orb points and streak don't.", `live note: ${get("exitc.note.live")}`);
ok(get("exitc.note.sim") === "This practice run will end.", `sim note: ${get("exitc.note.sim")}`);
ok(get("exitc.note.boost") === "Your BOOST still lands on-chain." && get("exitc.note.dump") === "Your DUMP still lands on-chain.", "pending notes: BOOST / DUMP");
ok(["exitc.title", "exitc.body", "exitc.stay", "exitc.leave", "exitc.note.live", "exitc.note.sim", "exitc.note.boost", "exitc.note.dump"].every((k) => !/!/.test(get(k) || "!")), "no exclamation marks");
const rest = i18n.slice(i18n.indexOf("const zh: Dict"), i18n.indexOf("export const DICTS"));
ok(!/"exitc\./.test(rest), "zh / ko / ja / es carry no exitc.* yet (fall back to English via translate())");
ok((rest.match(/NEEDS_REVIEW: exitc\.\*/g) || []).length === 4, "each non-English locale is marked NEEDS_REVIEW for exitc.*");
ok(/ENGLISH_ONLY: readonly I18nKey\[\] = \["exitc\.title", "exitc\.body", "exitc\.stay", "exitc\.leave", "exitc\.note\.live", "exitc\.note\.sim", "exitc\.note\.boost", "exitc\.note\.dump"\]/.test(i18n), "exitc.* listed in ENGLISH_ONLY (translation-coverage check in test:hotkeys skips them)");
ok(/DICTS\[lang\]\?\.\[key\] \?\? en\[key\]/.test(i18n), "translate() falls back to English per key");
const comp = rd("components/flight/ExitConfirm.tsx");
ok(!/(Leave the mission|mission continues|"Stay"|"Leave")/.test(comp.replace(/^\s*\*.*$/gm, "")), "component has no hardcoded copy (one-line swap in i18n)");
ok(["exitc.title", "exitc.body", "exitc.stay", "exitc.leave"].every((k) => comp.includes(`t("${k}")`)), "component renders all four i18n keys");

console.log("— 3. wiring");
const fc = rd("components/FlightCanvas.tsx");
ok(/<ExitConfirm active=\{flightActive\} mode=\{isSimulator \? "sim" : "live"\} \/>/.test(fc), "FlightCanvas mounts <ExitConfirm active={flightActive} mode={sim|live} /> (sim = ?source=sim)");
ok(/secondaryKeys\(mode, trades\)/.test(comp) && /data-testid="exit-confirm-note"/.test(comp) && /fontSize: 11/.test(comp), "component renders the smaller secondary line(s) from secondaryKeys(mode, pending)");
const tb = rd("components/TradeBridge.tsx");
ok(/__disciplePendingTrades/.test(tb) && /TRADE_PENDING_EVENT/.test(tb) && /finally \{ bump\(-1\); \}/.test(tb), "TradeBridge counts in-flight trades per side (+1 on tap, −1 in finally) and fires the pending event");
ok(/addEventListener\(TRADE_PENDING_EVENT/.test(comp) && /window\.__disciplePendingTrades/.test(comp), "ExitConfirm reads pending trades on open and follows the event");
ok(/flightActive = status === "Live" && !err && !isReplay/.test(fc), "armed only while the engine is Live, no error, not a replay");
ok(/id="exitX"/.test(fc) && /href="\/"/.test(fc), "✕ (#exitX) is still a plain link to / (caught by the capture-phase click guard)");
ok(/document\.addEventListener\("click", onClick, true\)/.test(comp) && /e\.preventDefault\(\); e\.stopPropagation\(\);/.test(comp), "document capture-phase click guard runs before next/link");
ok(/addEventListener\("popstate", onPop\)/.test(comp) && /history\.pushState\(guardState\(history\.state\)/.test(comp), "Back: guard history entry + popstate");
const bu = comp.slice(comp.indexOf('"beforeunload"') - 260, comp.indexOf('"beforeunload"') + 80);
ok(/if \(!active\) return;/.test(bu) && /e\.returnValue = ""/.test(comp) && /e\.preventDefault\(\)/.test(bu), "beforeunload: only while active, generic prompt (returnValue \"\")");
ok(/if \(leaving\.current\) return;/.test(comp), "no beforeunload prompt after the player chose Leave");
ok(/router\.push\(u\.pathname \+ u\.search \+ u\.hash\)/.test(comp) && /location\.assign\(p\.href\)/.test(comp) && /history\.back\(\)/.test(comp), "Leave: router.push (same origin) / location.assign (external) / history.back (Back)");
ok(/e\.code === "Escape"\) \{[^}]*stay\(\)/.test(comp), "Esc = Stay");
ok(/onPointerDown=\{\(e\) => \{ if \(e\.target === e\.currentTarget\) stay\(\); \}\}/.test(comp), "backdrop click = Stay");
ok(/ref=\{stayRef\}[^>]*autoFocus/.test(comp) && /stayRef\.current\?\.focus\(\)/.test(comp), "Stay is the default focus");
ok(/role="dialog" aria-modal="true"/.test(comp), "role=dialog + aria-modal: matches SettingsMenu's blocked() selector, so its ESC opener backs off while it is up");

console.log("— 4. trading hotkeys untouched");
const keyAdds = [...comp.matchAll(/addEventListener\("key(down|up)"/g)];
ok(keyAdds.length === 1, `exactly one key listener (got ${keyAdds.length})`);
const openFx = comp.slice(comp.indexOf("const open = !!pending;"), comp.indexOf("if (!pending) return null;"));
ok(/if \(!open\) return;/.test(openFx) && /addEventListener\("keydown", k, true\)/.test(openFx), "…and it is only attached while the dialog is open");
ok(!/(Space|ShiftLeft|ShiftRight|KeyZ|KeyX|KeyC|KeyV|Digit\d|KeyQ|KeyW|KeyE|KeyR|Enter|KeyH|KeyG|KeyO|KeyB)"/.test(comp), "no trading / game hotkey codes referenced");
ok(/a\.blur\?\.\(\)/.test(comp), "after Stay the ✕ / button focus is dropped so Enter (chat) / Space (BOOST) reach the game");
const sm = rd("components/flight/SettingsMenu.tsx");
ok(/\[role="dialog"\]\[aria-modal="true"\]/.test(sm), "SettingsMenu ESC opener skips while a [role=dialog][aria-modal=true] is up");
const eng = rd("public/flight/engine.js");
ok(/addEventListener\('disciple:menu'/.test(eng) && /disciple:menu", \{ detail: \{ open: true \} \}/.test(comp), "engine held keys cleared while open (disciple:menu)");

console.log("— 5. look (SettingsMenu card)");
for (const frag of ["linear-gradient(180deg,rgba(16,14,40,.96),rgba(8,10,26,.95))", "1px solid rgba(255,231,163,.5)", "rgba(4,5,14,.55)", "blur(3px)", "#ffe7a3"])
  ok(sm.includes(frag) && comp.includes(frag), `shares ${frag}`);
ok(/style=\{primary\}/.test(comp) && /style=\{ghost\}/.test(comp) && /background: GOLD/.test(comp) && /background: "transparent"/.test(comp), "Stay = gold primary, Leave = quiet ghost");

console.log(bad ? `\n${bad} FAILED` : "\nall exit-confirm checks passed");
process.exit(bad ? 1 : 0);
