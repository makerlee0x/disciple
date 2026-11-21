/**
 * Build step (mobile plan 2026-11-13, speed fix 2): the game engines are readable source that tests read as text, so they
 * stay as they are. This writes a minified copy of each, which production pages load instead (next.config.mjs picks the copy
 * only when it is newer than the source):
 *   public/flight/engine.js     → engine.min.js (~172 KB, ~64 KB gzipped vs ~117 KB), the coin page flight
 *   public/turbo/duel/engine.js → engine.min.js (perf pass 2026-11-21), Turbo Duel, Climb and the X player
 * Top-level names are kept: each engine is a classic script (window.__flight / window.DuelEngine, hooks the page reads).
 * Run by `pnpm build`; `--check` exits 1 if a copy is missing or older than its source.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const { minify } = createRequire(import.meta.url)("next/dist/build/swc");   // Next's own SWC minifier: no extra dependency
import { fileURLToPath } from "node:url";
const ENGINES = ["flight/engine", "turbo/duel/engine"].map((p) => ({
  name: p,
  src: fileURLToPath(new URL(`../public/${p}.js`, import.meta.url)),
  out: fileURLToPath(new URL(`../public/${p}.min.js`, import.meta.url)),
}));
if (process.argv.includes("--check")) {
  let bad = 0;
  for (const e of ENGINES) {
    let ok = false; try { ok = statSync(e.out).mtimeMs >= statSync(e.src).mtimeMs; } catch { /* missing */ }
    console.log(ok ? `public/${e.name}.min.js is current` : `public/${e.name}.min.js is missing or stale: run node scripts/minify-engine.mjs`);
    if (!ok) bad++;
  }
  process.exit(bad ? 1 : 0);
}
for (const e of ENGINES) {
  const r = await minify(readFileSync(e.src, "utf8"), { compress: { ecma: 2020 }, mangle: { topLevel: false }, module: false, format: { comments: false } });
  writeFileSync(e.out, r.code);
  console.log(`wrote public/${e.name}.min.js`, Math.round(statSync(e.out).size / 1024), "KB");
}
