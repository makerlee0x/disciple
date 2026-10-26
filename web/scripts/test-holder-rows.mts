/** Holders list system rows (GAME VFIVE graduation test): one row per label, no dust. Run: npm run test:holder-rows */
import assert from "node:assert/strict";
import { normalizeApiHolders } from "../lib/flight/holders";
const E = BigInt(10) ** BigInt(18);
const j = { holders: [
  { address: "0x8366a39cc670b4001a1121b8f6a443a643e40951", balance: (BigInt(525148730) * E / BigInt(1000)).toString(), pct: 52.515, usd: 2306.96, label: "pool", kind: "pool" },
  { address: "0x0035c9927d8a6bd668b2993ab2977f5a5333e16a", balance: (BigInt(474837815) * E / BigInt(1000)).toString(), pct: 47.484, usd: 2085.95, label: null, kind: "holder" },
  { address: "0xa5aaddd75f1bc3b8fb3ecc8845eab0cfa5faed8c", balance: "90140857706242000000", pct: 0.001, usd: 0.04, label: "locker", kind: "locker" },
  { address: "0x61efff9f0dbdd818317858074bcf80e4dcc39646", balance: "44397735885164000000", pct: 0.0, usd: 0.02, label: "locker", kind: "locker" },
  { address: "0x000000000000000000000000000000000000dead", balance: "2878360", pct: 0, usd: 0, label: null, kind: "burn" },
] };
for (const price of [0.0000044, 0]) {
  const n = normalizeApiHolders(j, { totalSupplyRaw: BigInt(1_000_000_000) * E, priceUsd: price })!;
  console.log(price, n.rows.map((r) => `${r.label ?? "player"} ${r.usd.toFixed(2)} ${r.pct.toFixed(3)}%`).join(" | "));
  assert.equal(n.rows.filter((r) => r.label === "locker").length, 0);
  assert.equal(n.rows.filter((r) => r.label === "pool").length, 1);
}
// two real lockers that matter ⇒ one summed row
const k = normalizeApiHolders({ holders: [
  { address: "0x" + "1".repeat(40), balance: (BigInt(100) * E).toString(), usd: 50, pct: 10, kind: "locker" },
  { address: "0x" + "2".repeat(40), balance: (BigInt(50) * E).toString(), usd: 25, pct: 5, kind: "locker" },
  { address: "0x" + "3".repeat(40), balance: (BigInt(10) * E).toString(), usd: 5, pct: 1, kind: "holder" } ] }, { totalSupplyRaw: BigInt(1000) * E, priceUsd: 0.5 })!;
console.log(k.rows.map((r) => `${r.label ?? "player"} ${r.usd} ${r.pct}%`).join(" | "));
assert.equal(k.rows.filter((r) => r.label === "locker").length, 1); assert.equal(k.rows[0].usd, 75);
console.log("ok");
