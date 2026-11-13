/**
 * Build step (mobile plan 2026-11-13, speed fix 2): public/flight/engine.js is ~307 KB of readable source that tests read
 * as text, so it stays as it is. This writes a minified copy, public/flight/engine.min.js (~172 KB, ~64 KB gzipped vs ~117 KB),
 * which production pages load instead (lib/flight/engineUrl.ts). Top-level names are kept: the engine is a classic script (window.__flight, hooks the page reads).
 * Run by `pnpm build`; `--check` exits 1 if the copy is missing or older than the source.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const { minify } = createRequire(import.meta.url)("next/dist/build/swc");   // Next's own SWC minifier: no extra dependency
import { fileURLToPath } from "node:url";
const src = fileURLToPath(new URL("../public/flight/engine.js", import.meta.url));
const out = fileURLToPath(new URL("../public/flight/engine.min.js", import.meta.url));
if (process.argv.includes("--check")) {
  let ok = false; try { ok = statSync(out).mtimeMs >= statSync(src).mtimeMs; } catch { /* missing */ }
  console.log(ok ? "engine.min.js is current" : "engine.min.js is missing or stale: run node scripts/minify-engine.mjs");
  process.exit(ok ? 0 : 1);
}
const r = await minify(readFileSync(src, "utf8"), { compress: { ecma: 2020 }, mangle: { topLevel: false }, module: false, format: { comments: false } });
writeFileSync(out, r.code);
console.log("wrote public/flight/engine.min.js", Math.round(statSync(out).size / 1024), "KB");
