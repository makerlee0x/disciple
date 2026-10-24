// Space-themed default usernames (lib/defaultUsername.ts): deterministic per address (case-insensitive), from the
// frozen word lists, claimed usernames always override, and the chat fallback (lib/gamechat/format shortAddr) uses it.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const dir = path.dirname(fileURLToPath(import.meta.url)), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "du-"));
fs.mkdirSync(path.join(tmp, "gamechat")); fs.mkdirSync(path.join(tmp, "flight"));
for (const rel of ["config", "flight/bombTier", "defaultUsername", "gamechat/format"]) {
  const src = fs.readFileSync(path.join(dir, "../lib", rel + ".ts"), "utf8").replace(/from "(\.{1,2}\/[^"]+)"/g, 'from "$1.mjs"');
  fs.writeFileSync(path.join(tmp, rel + ".mjs"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText);
}
const D = await import(pathToFileURL(path.join(tmp, "defaultUsername.mjs")).href);
const F = await import(pathToFileURL(path.join(tmp, "gamechat/format.mjs")).href);
let fail = 0; const bad = (m) => { fail++; console.error("FAIL " + m); };
const T = D.CALLSIGN_TITLES, N = D.CALLSIGN_NOUNS;

// word lists: sizes, unique, single family-friendly Title Case words, not tier/bomb names
if (new Set(T).size !== T.length || new Set(N).size !== N.length) bad("duplicate words in lists");
for (const w of [...T, ...N]) if (!/^[A-Z][a-z]+$/.test(w)) bad(`word not a single Title Case word: ${w}`);
const banned = /^(nuke|atom|bunker|cruise|grenade|dump|moon|ozone|uranus|limbo|seraphim|cherubim|aether|halo|rug|scam|kill|dead|drunk|sexy)$/i;
for (const w of [...T, ...N]) if (banned.test(w)) bad(`word clashes with a game term / not family-friendly: ${w}`);
console.log(`lists: ${T.length} titles × ${N.length} nouns = ${T.length * N.length} combos`);

// frozen: pin a few outputs so a list edit (which re-rolls everyone) is a deliberate test change
const pin = { "0x0000000000000000000000000000000000000000": "Major Vortex", "0xabc0000000000000000000000000000000000001": "Major Rocket" };
for (const [addr, want] of Object.entries(pin)) if (D.defaultUsername(addr) !== want) bad(`frozen lists changed: ${addr} → ${D.defaultUsername(addr)}, was ${want} (editing the lists re-rolls every player's name)`);
const a = "0xAbC0000000000000000000000000000000000001", A = a.toLowerCase();
const n1 = D.defaultUsername(a);
if (!n1 || n1 !== D.defaultUsername(A) || n1 !== D.defaultUsername("  " + a.toUpperCase().replace("0X", "0x") + " ")) bad("not deterministic / case-insensitive");
for (let i = 0; i < 5; i++) if (D.defaultUsername(a) !== n1) bad("unstable across calls");
const [t, ...rest] = n1.split(" ");
if (!T.includes(t) || rest.length !== 1 || !N.includes(rest[0])) bad(`shape: ${n1}`);
console.log(`${A} → ${n1}; zero address → ${pin["0x0000000000000000000000000000000000000000"]}`);

// spread: sequential-ish addresses (shared prefixes) should hit most titles / nouns and rarely collide
const names = Array.from({ length: 2000 }, (_, i) => D.defaultUsername("0x" + (i * 2654435761 >>> 0).toString(16).padStart(40, "0")));
const ts_ = new Set(names.map((s) => s.split(" ")[0])), ns = new Set(names.map((s) => s.split(" ")[1])), uniq = new Set(names);
if (ts_.size !== T.length) bad(`titles used ${ts_.size}/${T.length}`);
if (ns.size !== N.length) bad(`nouns used ${ns.size}/${N.length}`);
if (uniq.size < 1100) bad(`too many collisions: ${uniq.size}/2000 unique`);
const seq = new Set(Array.from({ length: 64 }, (_, i) => D.defaultUsername("0x" + i.toString(16).padStart(40, "0"))));
if (seq.size < 55) bad(`adjacent addresses collide: ${seq.size}/64`);
console.log(`spread: 2000 addrs → ${uniq.size} distinct names, ${ts_.size} titles, ${ns.size} nouns; 64 adjacent → ${seq.size}`);

// fallbacks
if (D.defaultUsername("") !== "" || D.defaultUsername(null) !== "" || D.defaultUsername(undefined) !== "") bad("empty input should give ''");
if (D.displayName("maker", a) !== "maker") bad("claimed username must win");
if (D.displayName("@maker", a, { at: true }) !== "@maker") bad("@ username");
if (D.displayName("", a) !== n1 || D.displayName(null, a) !== n1 || D.displayName("  ", a) !== n1) bad("missing username → default");
if (D.displayName(null, a, { at: true }) !== n1) bad("defaults never get an @");
if (D.displayName(null, null, { fallback: "?" }) !== "?") bad("no username + no address → fallback");
if (D.displayName(null, null) !== "") bad("no fallback → ''");
if (/^@|_/.test(n1) || /^[a-z0-9_]{3,20}$/.test(n1)) bad("default must not look like a claimed username");
if (!D.isAddressLike(a) || D.isAddressLike("0x123") || D.isAddressLike("maker")) bad("isAddressLike");

// chat (GameChat renders from.name || shortAddr(from.addr)): address → same default; non-address unchanged
if (F.shortAddr(a) !== n1) bad(`chat fallback ${F.shortAddr(a)} ≠ ${n1}`);
if (F.shortAddr("") !== "?" || F.shortAddr("abc") !== "abc" || F.shortAddr("0x1234567890abcdef") !== "0x1234…cdef") bad("chat non-address fallback changed");

fs.rmSync(tmp, { recursive: true, force: true });
if (fail) { console.error(`${fail} failure(s)`); process.exit(1); }
console.log("default usernames: ok");
