// Transpile a set of lib/*.ts modules to a temp dir as .mjs (relative imports rewritten) and import them.
// Shared by test:sim, test:audit and test:sim-parity so they all load the SAME sources the app bundles.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../lib");
/** every lib module the simulator pulls in (sim + what it imports) */
export const SIM_MODULES = ["config", "curveMath", "pnl", "flight/tiers", "trampwalls/adapter", "sim/pool", "sim/config", "sim/market", "sim/run", "sim/twAdapter"];
export async function loadLib(mods = SIM_MODULES, prefix = "lib-") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const rel of mods) {
    const src = fs.readFileSync(path.join(lib, rel + ".ts"), "utf8").replace(/from "(\.{1,2}\/[^"]+)"/g, 'from "$1.mjs"');
    const out = path.join(tmp, rel + ".mjs"); fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText);
  }
  const mods2 = {}; for (const rel of mods) mods2[rel] = await import(pathToFileURL(path.join(tmp, rel + ".mjs")).href);
  return { mods: mods2, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}
