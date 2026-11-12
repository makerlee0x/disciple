// /api/trades order: kv zrange asc (default) vs rev (+ offset paging), tradesOf/route limit clamp + order=desc (newest N, still oldest→newest).
// Unit part: transpiles lib/server/kv.ts (local store). Optional e2e: BASE_URL=http://localhost:3000 COIN=0x… (a coin with > LIMIT fills).
// Run: node scripts/test-trades-order.mjs
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trades-order-"));
let fail = 0; const ok = (c, m) => { if (!c) { fail++; console.log("FAIL " + m); } };
// kv.ts → ESM without "server-only"
const src = fs.readFileSync(path.join(root, "lib/server/kv.ts"), "utf8").replace('import "server-only";', "");
fs.writeFileSync(path.join(tmp, "kv.mjs"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText);
process.env.KV_LOCAL_FILE = path.join(tmp, "kv.json"); delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.KV_REST_API_URL;
const { kv } = await import(pathToFileURL(path.join(tmp, "kv.mjs")).href);
const s = kv(); ok(s.kind === "local", "local kv");
await s.zadd("z", Array.from({ length: 10 }, (_, i) => ({ score: 1000 + i, member: "m" + i })));
ok(JSON.stringify(await s.zrange("z", 3)) === '["m0","m1","m2"]', "default asc = oldest N");
ok(JSON.stringify(await s.zrange("z", 3, true)) === '["m9","m8","m7"]', "rev = newest N first");
// paging (Oct 30, coin chart full history): offset skips from the chosen end
ok(JSON.stringify(await s.zrange("z", 3, false, 3)) === '["m3","m4","m5"]', "asc offset 3 = the next page");
ok(JSON.stringify(await s.zrange("z", 5, false, 8)) === '["m8","m9"]' && JSON.stringify(await s.zrange("z", 3, false, 20)) === "[]", "last page short, past the end empty");
ok(JSON.stringify(await s.zrange("z", 2, true, 2)) === '["m7","m6"]', "rev offset");
// tradesOf contract (source check: clamp + REV + order param wired through the route; sort keeps oldest→newest)
const tr = fs.readFileSync(path.join(root, "lib/server/trades.ts"), "utf8"), rt = fs.readFileSync(path.join(root, "app/api/trades/route.ts"), "utf8");
const kvs = fs.readFileSync(path.join(root, "lib/server/kv.ts"), "utf8");
ok(/TRADES_MAX_LIMIT = 5000/.test(tr) && /Math\.min\(TRADES_MAX_LIMIT/.test(tr), "tradesOf clamps limit to 5000");
ok(/zrange\(k, n, order === "desc", Math\.max\(0, Math\.floor\(offset\) \|\| 0\)\)/.test(tr) && /\.sort\(byOrder\)/.test(tr), "tradesOf desc → rev, result sorted oldest→newest");
ok(/"ZRANGE", k, o, o \+ limit - 1, "REV"/.test(kvs), "upstash uses ZRANGE … REV (from offset o)");
ok(rt.includes(`get("order") === "desc"`) && /tradesOf\(coin, wallet, limit, order, offset\)/.test(rt), "route passes order + offset (coin + wallet queries)");
const eng = fs.readFileSync(path.join(root, "public/flight/engine.js"), "utf8"); ok(/order=desc/.test(eng), "engine backfill uses order=desc");
// optional e2e against a running server
if (process.env.BASE_URL && process.env.COIN) {
  const L = +(process.env.LIMIT || 5), q = (o) => fetch(`${process.env.BASE_URL}/api/trades?coin=${process.env.COIN}&limit=${L}${o}`).then((r) => r.json());
  const [asc, desc, all, big] = await Promise.all([q(""), q("&order=desc"), fetch(`${process.env.BASE_URL}/api/trades?coin=${process.env.COIN}&limit=5000`).then((r) => r.json()), fetch(`${process.env.BASE_URL}/api/trades?coin=${process.env.COIN}&limit=999999`).then((r) => r.json())]);
  const f = all.fills, inc = (a) => a.every((x, i) => !i || a[i - 1].block <= x.block);
  ok(asc.fills.length === L && asc.fills[0].id === f[0].id, "e2e asc = oldest");
  ok(desc.fills.length === L && desc.fills.at(-1).id === f.at(-1).id && desc.fills[0].id === f[f.length - L].id && inc(desc.fills), "e2e desc = newest, oldest→newest");
  ok(Object.keys(desc).join() === Object.keys(asc).join(), "e2e same response shape");
  ok(big.fills.length <= 5000, "e2e limit clamped");
  console.log(`e2e: ${f.length} fills, asc[0]=${asc.fills[0].id} desc[-1]=${desc.fills.at(-1).id}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `FAIL · ${fail} checks` : "PASS · trades order"); process.exit(fail ? 1 : 0);
