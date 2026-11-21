/**
 * Static githack preview build: temporarily hides app/api (unsupported with output:'export'),
 * runs next build with STATIC_PREVIEW=1, then restores api/.
 */
import { existsSync, renameSync } from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const api = join(root, "app", "api");
const bak = join(root, "app", "_api_static_bak");
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/makerlee0x/disciple/preview";

let moved = false;
// middleware (the iPhone app's "/" rewrite) can't ship in a static export either
const mw = join(root, "middleware.ts"), mwBak = join(root, "_middleware_static_bak.ts");
let mwMoved = false;
if (existsSync(mw)) { renameSync(mw, mwBak); mwMoved = true; }
if (existsSync(api)) {
  if (existsSync(bak)) {
    console.error("app/_api_static_bak already exists — aborting");
    process.exit(1);
  }
  renameSync(api, bak);
  moved = true;
  console.log("Moved app/api → app/_api_static_bak for static export");
}

try {
  const r = spawnSync("pnpm", ["exec", "next", "build"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      STATIC_PREVIEW: "1",
      NEXT_PUBLIC_STATIC_PREVIEW: "1",
      NEXT_PUBLIC_BASE_PATH: basePath,
    },
  });
  process.exitCode = r.status ?? 1;
} finally {
  if (mwMoved && existsSync(mwBak)) renameSync(mwBak, mw);
  if (moved && existsSync(bak)) {
    renameSync(bak, api);
    console.log("Restored app/api");
  }
}
