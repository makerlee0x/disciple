/** Unit tests: per-account op queue, relayer lock/retry, chain-ordered mcap, balance line.  pnpm test:trade-order */
import assert from "node:assert/strict";
import { serializeBy, queued } from "../lib/aa/opQueue";
import { withRelayer, isNonceError } from "../lib/server/relayer";
import { mcapOrderer } from "../lib/events";
import { balanceLine } from "../lib/balanceLine";
let n = 0; const t = async (name: string, f: () => Promise<void> | void) => { await f(); n++; console.log("ok  ", name); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await t("serializeBy: same account never overlaps, keeps order, survives failures", async () => {
  let active = 0, peak = 0; const log: number[] = [];
  const job = (i: number, ms: number, fail = false) => serializeBy("0xAbC", async () => { active++; peak = Math.max(peak, active); await sleep(ms); log.push(i); active--; if (fail) throw new Error("boom"); return i; });
  const rs = await Promise.allSettled([job(0, 30), job(1, 5, true), job(2, 1), job(3, 10)]);
  assert.equal(peak, 1); assert.deepEqual(log, [0, 1, 2, 3]);
  assert.deepEqual(rs.map((r) => r.status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  await sleep(1); assert.equal(queued("0xabc"), false);
});
await t("serializeBy: different accounts run in parallel", async () => {
  let active = 0, peak = 0; const job = (k: string) => serializeBy(k, async () => { active++; peak = Math.max(peak, active); await sleep(20); active--; });
  await Promise.all([job("0x1"), job("0x2"), job("0x3")]); assert.equal(peak, 3);
});
await t("nonce collision (pre-fix behaviour): parallel sends read the same nonce; queued sends don't", async () => {
  let chainNonce = 0; let pending = false;
  const send = async () => { const mine = chainNonce; await sleep(10); if (pending && mine === chainNonce) { throw new Error("Nonce provided for the transaction is lower than the current nonce of the account."); } pending = true; await sleep(15); chainNonce++; pending = false; return mine; };
  const par = await Promise.allSettled([send(), send(), send()]);
  assert.ok(par.filter((r) => r.status === "rejected").length >= 1, "parallel reproduces the collision");
  chainNonce = 0; const ser = await Promise.all([0, 1, 2].map(() => serializeBy("acct", send)));
  assert.deepEqual(ser, [0, 1, 2]);
});
await t("withRelayer: serial + retries nonce errors, not other errors", async () => {
  assert.ok(isNonceError(new Error("Nonce provided for the transaction is lower than the current nonce of the account.")));
  assert.ok(!isNonceError(new Error("execution reverted")));
  let tries = 0; assert.equal(await withRelayer(async () => { if (++tries < 2) throw new Error("nonce too low"); return "ok"; }), "ok"); assert.equal(tries, 2);
  let other = 0; await assert.rejects(withRelayer(async () => { other++; throw new Error("execution reverted"); })); assert.equal(other, 1);
  let active = 0, peak = 0; await Promise.all([1, 2, 3].map(() => withRelayer(async () => { active++; peak = Math.max(peak, active); await sleep(10); active--; }))); assert.equal(peak, 1);
});
await t("mcapOrderer: a late OLDER buy batch can't undo a newer DUMP; reconcile only moves forward", () => {
  const out: { type: string; mcapUsd?: number; side?: string }[] = [];
  const o = mcapOrderer((e) => out.push(e as never));
  const tr = (block: number, logIndex: number, side: "buy" | "sell", mcapUsd: number) => ({ type: "Trade", side, mcapUsd, block: BigInt(block), logIndex, usd: 10, impactPct: 0, txHash: "0x", token: "0x", trader: "0x", amountIn: 0n, amountOut: 0n }) as never;
  o.trade(tr(100, 1, "buy", 33894));
  o.trade(tr(102, 3, "sell", 33018));      // DUMP lands first
  o.trade(tr(101, 0, "buy", 33749));       // older buy batch resolves late
  assert.equal(out.length, 3); assert.equal(out[2].side, "buy"); assert.equal(out[2].mcapUsd, 33018, "late buy carries the newest mcap");
  assert.equal(o.state(33900, 101n), false, "stale reconcile ignored");
  assert.equal(o.state(33018, 103n), false, "same mcap → no event");
  assert.equal(o.state(32500, 104n), true); assert.equal(out.at(-1)!.type, "State"); assert.equal(out.at(-1)!.mcapUsd, 32500);
  o.trade(tr(104, 2, "sell", 32400)); assert.equal(out.at(-1)!.mcapUsd, 32500, "trade inside an already-reconciled block keeps the newer read");
  o.trade(tr(105, 0, "sell", 32000)); assert.equal(out.at(-1)!.mcapUsd, 32000);
});
await t("balanceLine: held coin first, quote marked as what trades spend, ETH = gas", () => {
  const l = balanceLine([{ symbol: "ETH", amount: 0.0009, role: "gas" }, { symbol: "STRATEGY", amount: 999007, role: "spend" }, { symbol: "mUSDG", amount: 1000 }, { symbol: "SMK", amount: 25483509, role: "held" }]);
  assert.equal(l.text, "25.48M $SMK · 999,007 STRATEGY (pays trades) · 1,000 mUSDG · 0.0009 ETH (gas)");
  assert.match(l.title, /mUSDG: test dollars; not spent/);
});
console.log(`\n${n} passed`);
