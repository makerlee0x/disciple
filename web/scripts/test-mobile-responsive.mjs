/**
 * Static checks for phone / in-wallet browser responsive chrome.
 * Run: node scripts/test-mobile-responsive.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(dir, "..");
const read = (p) => fs.readFileSync(path.join(web, p), "utf8");
let bad = 0;
const ok = (c, m) => {
  console.log((c ? "ok   " : "FAIL ") + m);
  if (!c) bad++;
};

const layout = read("app/layout.tsx");
ok(/viewportFit:\s*"cover"/.test(layout), "layout viewportFit=cover (safe-area in wallet browsers)");
ok(/width:\s*"device-width"/.test(layout) && /initialScale:\s*1/.test(layout), "layout width=device-width initialScale=1");

const css = read("app/globals.css");
ok(/--ap-safe-top:\s*env\(safe-area-inset-top/.test(css), "CSS --ap-safe-top from env(safe-area-inset-top)");
ok(/--ap-topbar-offset:\s*calc\(var\(--ap-topbar-h\) \+ var\(--ap-safe-top\)\)/.test(css), "topbar offset includes safe-area");
ok(/overflow-x:\s*clip/.test(css), "html/body overflow-x:clip (no sideways scroll in WebViews)");
ok(/\.wb-root\s*\{[\s\S]*?var\(--ap-safe-top\)/.test(css), "wallet .wb-root uses safe-area top");
ok(/\.wb-invite\s*\{[\s\S]*?var\(--ap-safe-bottom\)/.test(css), "invite banner clears home indicator");
ok(/#apReopen\s*\{[\s\S]*?var\(--ap-safe-top\)/.test(css), "menu reopen clears notch");
ok(/ap-phone-launch[\s\S]*?var\(--ap-safe-top\)/.test(css), "phone Launch clears notch");
ok(/max-height:\s*calc\(100dvh/.test(css) || /min\(92dvh/.test(css), "sheets/modals use dvh (mobile browser chrome)");

const wb = read("components/WalletButton.tsx");
ok(/className="wb-root"/.test(wb) && /data-compact=/.test(wb), "WalletButton uses .wb-root (not hardcoded top/right px)");
ok(!/position:\s*"fixed",\s*top:\s*compact/.test(wb), "WalletButton no longer inlines fixed top that fights safe-area");
ok(/addEventListener\("pointerdown"/.test(wb) && !/addEventListener\("mousedown"/.test(wb), "WalletButton outside-close uses pointerdown (wallet WebViews)");

const inv = read("components/invites/InviteBanner.tsx");
ok(/className="wb-invite"/.test(inv), "InviteBanner uses .wb-invite safe-area class");

const bar = read("components/flight/PhoneTradeBar.tsx");
ok(/\.ph-bar\s*\{[^}]*bottom:\s*var\(--ph-bar-bottom, 24px\)/.test(bar) && /const barBottom = Math\.max\(BAR_BOTTOM, \(o\.safeBottom \?\? 0\) \+ 8\);/.test(read("components/flight/PhoneHud.tsx")), "phone trade bar clears home indicator (PhoneHud --ph-bar-bottom)");

const claims = read("app/claims.css");

ok(/body\.side-hidden\s+\[aria-label="wallet"\]/.test(css) && !/body\.side-hidden:not\(\.game\)/.test(css), "game wallet strip max-width leaves room for menu");

const appHome = read("components/home/appHome.module.css");
const hiw = read("app/how-it-works/page.module.css");
ok(/var\(--ap-topbar-offset/.test(appHome), "home heroes use topbar-offset (safe-area)");
ok(/var\(--ap-topbar-offset/.test(hiw), "how-it-works uses topbar-offset");

const hud = read("components/flight/PhoneHud.tsx");
ok(/safeBottom\?\:\s*number/.test(hud) && /visualViewport/.test(hud), "PhoneHud layout lifts for safe-bottom + visualViewport");
ok(/PHONE_W = 760/.test(hud), "PhoneHud PHONE_W=760 matches site chrome");

const eng = read("public/flight/engine.js");
ok(/HUD_NARROW_W=760/.test(eng) && /w<=HUD_NARROW_W/.test(eng), "engine HUD_NARROW_W=760 (≤)");

const tb = read("components/TradeBridge.tsx");
ok(/bottom:\s*"calc\(14px \+ var\(--ap-safe-bottom\)\)"/.test(tb), "desktop trade bar clears home indicator");

const tw = read("components/trampwalls/TrampWallPanel.tsx");
ok(/sample && .*SAMPLE/.test(tw) || /· SAMPLE/.test(tw), "mock Tramp/Wall labeled SAMPLE");

const coin = read("app/coin/[address]/page.tsx");
ok(/(data-testid|testId)="coin-lost"/.test(coin) && /isAddress\(address\)/.test(coin), "invalid coin address shows lost state");

const home = read("components/home/HomeHero.tsx");
ok(/home-poll-err/.test(home) && /setPollErr/.test(home), "home poll failure surfaces a banner");

ok(/\.pf-toast\s*\{[^}]*var\(--ap-safe-bottom\)/.test(css), "profile toast clears home indicator");

if (bad) {
  console.error(`\n${bad} check(s) failed`);
  process.exit(1);
}
console.log("\nall mobile responsive checks passed");
