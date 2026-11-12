// game/rockets-empty-instant — Your rockets shows the right empty state without a wrong flash.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rocketsListView, walletPending } from "../lib/claims/rocketsListView.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(web, "components/claims/CreatorDashboard.tsx"), "utf8");
let failed = 0;
const ok = (c, msg) => { if (c) console.log("ok  ", msg); else { failed++; console.log("FAIL", msg); } };

ok(src.includes('from "@/lib/claims/rocketsListView"'), "dashboard uses the shared view helper");
ok(!/if \(!me \|\| !ready\) return/.test(src), "list fetch no longer waits for the caps probe");
ok(/restoreSmart\(\)/.test(src) && /privyReady\(\)/.test(src), "wallet is settled from restore + Privy ready, not first-paint null");
ok(/data-testid="rockets-signin"/.test(src) && /data-testid="rockets-loading"/.test(src) && /data-testid="rockets-empty"/.test(src), "signin / loading / empty are distinct");
ok(/Sign in to see your rockets/.test(src) && /No rockets yet/.test(src), "existing empty copy is unchanged");
ok(!/useWalletAddr/.test(src), "no longer treats first-paint null from useWalletAddr as signed out");

ok(rocketsListView("none", null, false) === "signin", "signed out / no wallet: instant sign-in, not loading or No rockets yet");
ok(rocketsListView("unknown", null, false) === "loading", "wallet still resolving: loading, not Sign in and not No rockets yet");
ok(rocketsListView("in", null, false) === "loading", "signed in, fetch in flight: loading, not No rockets yet");
ok(rocketsListView("in", [], false) === "empty", "signed in, fetch returned []: No rockets yet");
ok(rocketsListView("in", [{ token: "0x" }], false) === "list", "signed in with rockets: the list");
ok(rocketsListView("none", null, true) === "loading", "demo with no rows yet: loading");
ok(rocketsListView("none", [], true) === "empty", "demo empty: No rockets yet");
ok(walletPending(null, false, false, true) === true, "Privy not ready: still pending (do not assume signed out)");
ok(walletPending(null, true, false, true) === false, "Privy ready, not signed in, restore done: settled signed out");
ok(walletPending(null, true, true, true) === true, "Privy signed in but no address yet: pending");
ok(walletPending("0xabc", true, false, false) === false, "already have an address: not pending");
ok(walletPending(null, true, false, false) === true, "restore still running: pending");

if (failed) { console.error(failed + " rockets-empty-instant check(s) FAILED"); process.exit(1); }
console.log("rockets-empty-instant checks passed");
