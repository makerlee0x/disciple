// Bundles relay/server.ts into relay/dist/server.cjs (one file, no node_modules at runtime).
// Usage (web/): NODE_PATH=../node_modules/.pnpm/node_modules node relay/build.mjs   (esbuild + undici from the pnpm store)
import { createRequire } from "node:module";
const { build } = createRequire(import.meta.url)("esbuild");   // CJS resolve honors NODE_PATH
import path from "node:path";
import { fileURLToPath } from "node:url";
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await build({
  entryPoints: [path.join(web, "relay/server.ts")],
  outfile: path.join(web, "relay/dist/server.cjs"),
  bundle: true, platform: "node", target: "node22", format: "cjs", sourcemap: true, logLevel: "info",
  tsconfig: path.join(web, "tsconfig.json"),
  nodePaths: (process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean),   // undici / esbuild come from pnpm's .pnpm/node_modules
  alias: { "server-only": path.join(web, "relay/serverOnlyStub.js") },
});
