// AUDIT: the flight ?icon decal is gated to the moderated store (lib/flight/iconGate.ts → lib/coinImages isStoreSrc).
// Non-store URLs fall back (null → brandedRocket plain rocket); /api/image/<64-hex sha> passes. Also with a base path.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), "../lib");
async function load(basePath) {
  process.env.NEXT_PUBLIC_BASE_PATH = basePath;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "icongate-")); fs.mkdirSync(path.join(tmp, "flight"));
  for (const rel of ["base-path", "coinImages", "flight/iconGate"]) {
    const src = fs.readFileSync(path.join(lib, rel + ".ts"), "utf8").replace(/from "(\.{1,2}\/[^"]+)"/g, 'from "$1.mjs"');
    fs.writeFileSync(path.join(tmp, rel + ".mjs"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText);
  }
  return import(pathToFileURL(path.join(tmp, "flight/iconGate.mjs")).href);
}
const sha = "a".repeat(32) + "0123456789abcdef".repeat(2);
let fail = 0; const check = (g, v, want, label) => { const got = g(v); const ok = got === want; if (!ok) fail++; console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(v)} → ${JSON.stringify(got)}`); };
{ const { gateFlightIcon: g } = await load("");
  check(g, `/api/image/${sha}`, `/api/image/${sha}`, "store sha passes");
  for (const [v, l] of [["https://evil.example/x.png", "external https"], ["http://localhost:3000/api/image/" + sha, "absolute URL to store (not relative)"],
    ["data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "data: URL"], ["blob:https://x/1", "blob: URL"], ["/assets/tier4.png", "other relative path"],
    ["/api/img?url=https://evil.example/x.png", "proxy path"], [`/api/image/${sha}/../../x`, "store path traversal"], [`/api/image/${sha.toUpperCase()}`, "uppercase sha"],
    [`/api/image/${sha.slice(1)}`, "63-hex"], [`/api/image/${sha}?x=1`, "store + query"], ["//evil.example/api/image/" + sha, "protocol-relative"],
    ["javascript:alert(1)", "javascript:"], ["", "empty"], [null, "null"], [undefined, "undefined"]]) check(g, v, null, `${l} falls back`);
}
{ const { gateFlightIcon: g } = await load("/disciple");
  check(g, `/disciple/api/image/${sha}`, `/disciple/api/image/${sha}`, "base path: store sha passes");
  check(g, `/api/image/${sha}`, `/api/image/${sha}`, "base path: unprefixed store sha passes");
  check(g, `/other/api/image/${sha}`, null, "base path: other prefix falls back");
}
if (fail) { console.error(`FAIL ${fail}`); process.exit(1); } console.log("PASS");
