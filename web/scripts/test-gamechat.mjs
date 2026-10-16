// In-game chat overlay helpers (lib/gamechat/format.ts): deterministic name colours, bomb tiers = docs/bombs.md,
// burst grouping of small trade events, 200-row cap, emote parsing (known codes only, no HTML).
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const dir = path.dirname(fileURLToPath(import.meta.url)), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gc-"));
const src = fs.readFileSync(path.join(dir, "../lib/gamechat/format.ts"), "utf8");
fs.writeFileSync(path.join(tmp, "f.mjs"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText);
const F = await import(pathToFileURL(path.join(tmp, "f.mjs")).href);
let fail = 0; const bad = (m) => { fail++; console.error("FAIL " + m); };
const a = "0xabc0000000000000000000000000000000000001";
if (F.nameColor(a) !== F.nameColor(a.toUpperCase().replace("0X", "0x"))) bad("colour not case-insensitive");
const cols = new Set(Array.from({ length: 50 }, (_, i) => F.nameColor("0x" + i.toString(16).padStart(40, "0")))); if (cols.size < 35) bad(`colours collide (${cols.size}/50)`);
const doc = fs.readFileSync(path.join(dir, "../../docs/bombs.md"), "utf8");
for (const t of F.BOMB_TIERS) { const m = doc.match(new RegExp(`\\|\\s*${t.name}\\s*\\|[^|]*\\|\\s*(?:≥\\s*)?(\\d+)`)); if (!m || +m[1] !== t.min) bad(`${t.name} threshold ${t.min} ≠ docs/bombs.md ${m && m[1]}`); }
const cases = [[199, null], [200, "GRENADE"], [-499, "GRENADE"], [-500, "BUNKER"], [1200, "CRUISE"], [-2500, "NUKE"], [-4999, "NUKE"], [-5000, "ATOM"]];
for (const [b, n] of cases) { const t = F.bombTier(b); if ((t ? t.name : null) !== n) bad(`bombTier(${b}) = ${t && t.name}, want ${n}`); }
const ev = (i, side, bps, ts, usd = 10) => ({ id: String(i).padStart(6, "0"), coin: "c", kind: "event", from: null, text: "", ts, meta: { event: side, usd, impactBps: side === "buy" ? bps : -bps } });
let rows = F.appendRows([], [ev(1, "buy", 10, 0), ev(2, "buy", 10, 500), ev(3, "buy", 10, 900), ev(4, "sell", 10, 1000), ev(5, "sell", 3000, 1100), ev(6, "sell", 10, 1200), ev(7, "buy", 10, 9000)]);
const shape = rows.map((r) => (r.group ? `${r.group.side}×${r.group.n}` : r.msg.meta.event + (F.bombTier(r.msg.meta.impactBps) ? "!" : ""))).join(" ");
if (shape !== "buy×3 sell sell! sell buy") bad(`grouping: ${shape}`); else console.log(`grouping: ${shape} (3 small buys folded; NUKE stays standalone; gap > 2.5 s splits)`);
if (rows[0].group.usd !== 30) bad("group usd");
rows = F.appendRows([], Array.from({ length: 500 }, (_, i) => ({ id: String(i).padStart(6, "0"), coin: "c", kind: "user", from: { addr: a }, text: "x", ts: i })));
if (rows.length !== 200 || rows[199].msg.id !== "000499") bad("row cap");
const parts = F.parseEmotes("gm :halo: <b>x</b> :nope: :rocket:", (c) => ["halo", "rocket"].includes(c));
if (JSON.stringify(parts.map((p) => p.t === "emote" ? p.code : p.v)) !== JSON.stringify(["gm ", "halo", " <b>x</b> :nope: ", "rocket"])) bad("parseEmotes " + JSON.stringify(parts));
fs.rmSync(tmp, { recursive: true, force: true });
if (fail) process.exit(1); else console.log("PASS");
