// In-game chat overlay helpers (lib/gamechat/format.ts): deterministic name colours, bomb tiers = docs/bombs.md,
// burst grouping of small trade events, 200-row cap, emote parsing (known codes only, no HTML).
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const dir = path.dirname(fileURLToPath(import.meta.url)), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gc-"));
// format.ts imports ../config + ../flight/bombTier: transpile the three into tmp/{gamechat,flight}/ with .mjs specifiers
fs.mkdirSync(path.join(tmp, "gamechat")); fs.mkdirSync(path.join(tmp, "flight"));
for (const rel of ["config", "flight/bombTier", "gamechat/format"]) {
  const src = fs.readFileSync(path.join(dir, "../lib", rel + ".ts"), "utf8").replace(/from "(\.{1,2}\/[^"]+)"/g, 'from "$1.mjs"');
  fs.writeFileSync(path.join(tmp, rel + ".mjs"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText);
}
const F = await import(pathToFileURL(path.join(tmp, "gamechat/format.mjs")).href);
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
// Chat tier == engine tier for the same trade: evaluate engine.js's own BOMB_PCT / BOMB_TIERS / bombTierOf /
// estimateImpactPct (extracted verbatim) and compare with lib/flight/bombTier via format.bombTier on the same input.
{
  const E = fs.readFileSync(path.join(dir, "../public/flight/engine.js"), "utf8");
  const grab = (re, what) => { const m = E.match(re); if (!m) { bad(`engine.js: ${what} not found`); return ""; } return m[0]; };
  const code = [grab(/const BOMB_PCT=\{[^}]*\};/, "BOMB_PCT"), grab(/const BOMB_TIERS=\[[\s\S]*?\n\];/, "BOMB_TIERS"),
    grab(/function bombTierOf\(pct\)\{[\s\S]*?return i; \}/, "bombTierOf"), grab(/function estimateImpactPct\(trade\)\{[\s\S]*?\n\}/, "estimateImpactPct")].join("\n");
  const eng = new Function("source", code + "\nreturn { BOMB_TIERS, bombTierOf, estimateImpactPct };")({});   // source: no v3 sim (chat has none)
  const B = await import(pathToFileURL(path.join(tmp, "flight/bombTier.mjs")).href), C = await import(pathToFileURL(path.join(tmp, "config.mjs")).href);
  if (JSON.stringify(eng.BOMB_TIERS.map((t) => [t.k, t.min])) !== JSON.stringify(C.BOMB_TIERS.map((t) => [t.k, t.min]))) bad("engine BOMB_TIERS ≠ lib/config BOMB_TIERS");
  const trades = [];
  for (const pct of [0, 1.99, 2, 4.9, 5, 11.99, 12, 24.9, 25, 49.99, 50, 80]) {
    trades.push({ side: "sell", usd: 50, impactPct: -pct }, { side: "sell", usd: 50, prePrice: 1e-6, postPrice: 1e-6 * (1 - pct / 100) }, { side: "sell", usd: 50, impactBps: -Math.round(pct * 100), impactPct: undefined });
  }
  trades.push({ side: "sell", usd: 5000, prePrice: 2e-6, postPrice: 1.97e-6 }, { side: "sell", usd: 3, impactPct: 30 });   // big $ / tiny impact, tiny $ / big impact
  let n = 0;
  for (const t of trades) {
    const engPct = Number.isFinite(t.impactBps) && !(t.prePrice > 0) ? Math.abs(t.impactBps) / 100 : eng.estimateImpactPct(t);   // chain impactBps → engine impactPct (replay.js: impactBps/100)
    const ei = eng.bombTierOf(engPct), bi = B.bombTierIndex(B.impactPctOf(t)), ct = F.bombTier(t), ci = ct ? ct.idx : 0;
    if (ei !== bi || ei !== ci) bad(`tier mismatch for ${JSON.stringify(t)}: engine ${ei}, lib ${bi}, chat ${ci}`); else n++;
  }
  if (F.bombTier(-3000) !== F.BOMB_TIERS.find((t) => t.name === "NUKE") || F.bombTier({ usd: 9999 }) !== null) bad("bombTier: bare bps / no-impact handling");
  if (F.bombTier({ prePrice: 2e-6, postPrice: 1e-6, impactBps: -300 }).name !== "ATOM") bad("pre/post price must win over impactBps (engine precedence)");
  console.log(`chat tier == engine tier: ${n}/${trades.length} trades (impactPct · pre/post price · impactBps; big-$ low-impact stays small)`);
}
fs.rmSync(tmp, { recursive: true, force: true });
if (fail) process.exit(1); else console.log("PASS");
