/**
 * Launchpad sort helpers: Pair group key/label, and the existing volume field used by Top volume.
 * Run: node scripts/test-launchpad-sort.mjs
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(dir, "..");

// Compile the TS helpers with tsx if available, else a tiny inline check via tsx --eval.
const r = spawnSync("npx", ["tsx", "-e", `
import { pairSortKey, pairGroupLabel } from "./lib/launchpad.ts";
const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) process.exitCode = 1; };

ok(pairSortKey({ pair: "STRATEGY" }) === "STRATEGY", "default pair key is STRATEGY");
ok(pairSortKey({ pair: "USDG" }) === "USDG", "USDG pair key");
ok(pairSortKey({ pair: "OTHER" }) === "OTHER", "OTHER pair key");
ok(pairSortKey({ pair: "OTHER", pairSym: "AI" }) === "AI", "pairSym wins over OTHER");
ok(pairSortKey({ pair: "STRATEGY", pairSym: "strategy" }) === "STRATEGY", "pairSym is uppercased");

ok(pairGroupLabel({ pair: "STRATEGY" }) === "Trades against STRATEGY", "STRATEGY group label");
ok(pairGroupLabel({ pair: "USDG" }) === "Trades against USDG", "USDG group label");
ok(pairGroupLabel({ pair: "OTHER" }) === "Trades against another coin", "OTHER without a symbol is plain");
ok(pairGroupLabel({ pair: "OTHER", pairSym: "SPACEHOOD" }) === "Trades against SPACEHOOD", "named pair uses its symbol");

const rows = [
  { pair: "USDG", pairSym: "USDG", live: false, stats: { volume24hUsd: 10 }, born: 1 },
  { pair: "STRATEGY", pairSym: "STRATEGY", live: true, stats: { volume24hUsd: 1 }, born: 3 },
  { pair: "STRATEGY", pairSym: "STRATEGY", live: false, stats: { volume24hUsd: 50 }, born: 2 },
  { pair: "OTHER", pairSym: "AI", live: true, stats: { volume24hUsd: 3 }, born: 4 },
];
const sorted = [...rows].sort((a, b) => pairSortKey(a).localeCompare(pairSortKey(b)) || (a.live === b.live ? 0 : a.live ? -1 : 1) || b.stats.volume24hUsd - a.stats.volume24hUsd || (b.born ?? 0) - (a.born ?? 0));
ok(sorted.map((r) => pairSortKey(r) + (r.live ? "*" : "") + r.stats.volume24hUsd).join(",") === "AI*3,STRATEGY*1,STRATEGY50,USDG10",
  "Pair sort groups by pair, live first inside a group, then volume: " + sorted.map((r) => pairSortKey(r) + (r.live ? "*" : "") + r.stats.volume24hUsd).join(","));
`], { cwd: web, encoding: "utf8" });
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
process.exit(r.status ?? 1);
