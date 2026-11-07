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
ok(/@media \(max-width: 480px\)[\s\S]*?\.wb-testnet\s*\{\s*display:\s*none/.test(css), "≤480px hides Test network tag to free strip");

const wb = read("components/WalletButton.tsx");
ok(/className="wb-root"/.test(wb) && /data-compact=/.test(wb), "WalletButton uses .wb-root (not hardcoded top/right px)");
ok(!/position:\s*"fixed",\s*top:\s*compact/.test(wb), "WalletButton no longer inlines fixed top that fights safe-area");

const inv = read("components/invites/InviteBanner.tsx");
ok(/className="wb-invite"/.test(inv), "InviteBanner uses .wb-invite safe-area class");

if (bad) {
  console.error(`\n${bad} check(s) failed`);
  process.exit(1);
}
console.log("\nall mobile responsive checks passed");
