// Buy right after a launch / our own sell: "Price moved past your one-tap max slippage" (PreExecHookReverted →
// DiscipleSessionPolicy.MinOutTooLow) with no network faults. Root cause: post-trade reads are pinned to our receipt
// block (lib/trade/readFloor) and eth_call evaluates at THAT block's timestamp; in a coin's first seconds the sniper tax
// (BondingCurve.currentSnipeFeeBps = table[block.timestamp − launchTime]) is an older, higher second's ⇒ minOut far below
// the policy's execution-time floor. Fix: pinned eth_calls carry blockOverrides.time = the estimated execution second.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReadFloor, flooredRequest, EXEC_SEND_MS } from "../lib/trade/readFloor";
import { snipeFeeBpsAt, STEEP_SNIPE } from "../lib/snipe";
import { meetsPolicyFloor } from "../lib/aa/slippage";
import { applySlippage } from "../lib/curveMath";

const TABLE = STEEP_SNIPE.bpsBySec;
/** Chain whose clock runs `off` s from ours (anvil fork: −1.0x). Blocks have whole-second timestamps. */
function chain(off: number, clock: () => number) {
  const blocks = new Map<bigint, number>(); let n = 100n;
  const mine = () => { n++; blocks.set(n, Math.floor(clock() / 1000 + off)); return n; };
  const calls: unknown[][] = [];
  const inner = async ({ method, params }: { method: string; params?: unknown }) => {
    const p = params as unknown[];
    if (method === "eth_getBlockByNumber") { const t = blocks.get(BigInt(p[0] as string)); return t === undefined ? null : { timestamp: "0x" + t.toString(16) }; }
    calls.push(p); return "0x";
  };
  return { mine, inner, calls, ts: (b: bigint) => blocks.get(b)!, now: () => Math.floor(clock() / 1000 + off) };
}
/** tokens out for $5 at `elapsed` s after launch (linear stand-in for the curve: only the sniper tax matters here) */
const out = (elapsed: number) => BigInt(1_000_000 * (10_000 - snipeFeeBpsAt(elapsed, TABLE)));
const SESSION_MAX = 500, CLIENT = 100;   // 5% session policy floor, 1% client slippage (protocol-viem default)
const fills = (quotedAt: number, execAt: number) => {
  const minOut = applySlippage(out(quotedAt), CLIENT);
  return { policy: meetsPolicyFloor(minOut, out(execAt), SESSION_MAX), curve: out(execAt) >= minOut };
};

test("the bug: a quote at the receipt block's second fails the policy floor one second later (99%→25%, 25%→3%)", () => {
  assert.deepEqual(fills(0, 1), { policy: false, curve: true });   // fork: MinOutTooLow(14.6e18, 942e18)
  assert.deepEqual(fills(1, 2), { policy: false, curve: true });   // fork: MinOutTooLow(1095e18, 1216e18)
  assert.deepEqual(fills(1, 1), { policy: true, curve: true });    // quoted for the execution second: fills
  assert.deepEqual(fills(8, 9), { policy: true, curve: true });    // after the 7 s window time does not matter
});

test("pinned eth_call runs at the estimated execution second (blockOverrides.time), never before the pinned block", async () => {
  let t = 1_000_500; const clock = () => t;
  const c = chain(-1.02, clock);
  const f = new ReadFloor(clock, 3000);
  const req = flooredRequest(c.inner, f, { execTime: true, sleep: async () => {} });
  const sent = t; t += 120; const b = c.mine(); t += 80; f.raise(b, sent);   // our sell: sent, mined, receipt
  t += 400;                                                                  // next tap 0.4 s later
  await req({ method: "eth_call", params: [{ to: "0x1", data: "0x" }, "latest"] });
  const [tx, tag, so, bo] = c.calls.pop()!;
  assert.deepEqual([tx, tag, so], [{ to: "0x1", data: "0x" }, "0x" + b.toString(16), {}], "state stays pinned to the receipt block");
  const time = Number(BigInt((bo as { time: string }).time));
  assert.ok(time >= c.ts(b), "never before the pinned block");
  // one receipt bounds the clock offset to (ts − recv, ts + 1 − sent]: the estimate is within a second of the truth
  const exec = Math.floor((t + EXEC_SEND_MS) / 1000 - 1.02);
  assert.ok(Math.abs(time - exec) <= 1, `estimate ${time} vs exec ${exec}`);
});

test("receipts narrow the clock offset: after a few own trades the execution second is exact across phases", async () => {
  for (const off of [-1.02, -0.5, 0.13, 3.7]) {
    let t = 2_000_000 + Math.round(off * 1000) % 1000 + 1000; const clock = () => t;
    const c = chain(off, clock);
    const f = new ReadFloor(clock, 3000);
    const req = flooredRequest(c.inner, f, { execTime: true, sleep: async () => {} });
    let misses = 0;
    for (let i = 0; i < 12; i++) {
      const sent = t; t += 90 + (i * 37) % 120; const b = c.mine(); t += 60 + (i * 53) % 90; f.raise(b, sent);
      t += 50 + (i * 211) % 600;
      await req({ method: "eth_call", params: [{ to: "0x1" }, "latest"] });
      const time = Number(BigInt(((c.calls.pop()!)[3] as { time: string }).time));
      const exec = Math.floor((t + EXEC_SEND_MS) / 1000 + off);
      assert.ok(Math.abs(time - exec) <= 1, "always within a second");
      if (i >= 6 && time !== exec) misses++;
      t += 300;
    }
    assert.equal(misses, 0, `offset ${off}: estimate matches the execution second once calibrated`);
  }
});

test("header unavailable ⇒ the old pinned read (no override); non-eth_call reads and explicit blocks untouched", async () => {
  const f = new ReadFloor(() => 0, 3000);
  const seen: unknown[][] = [];
  const req = flooredRequest(async ({ method, params }) => { if (method === "eth_getBlockByNumber") throw new Error("boom"); seen.push(params as unknown[]); return "0x"; }, f, { execTime: true, sleep: async () => {} });
  f.raise(0x65n, 0);
  await req({ method: "eth_call", params: [{ to: "0x1" }, "latest"] });
  assert.deepEqual(seen.pop(), [{ to: "0x1" }, "0x65"]);
  await req({ method: "eth_getBalance", params: ["0xabc", "latest"] });
  assert.deepEqual(seen.pop(), ["0xabc", "0x65"]);
  await req({ method: "eth_call", params: [{ to: "0x1" }, "0x10"] });
  assert.deepEqual(seen.pop(), [{ to: "0x1" }, "0x10"]);
  // caller's own block overrides are kept as-is
  await req({ method: "eth_call", params: [{ to: "0x1" }, "latest", {}, { time: "0x5" }] });
  assert.deepEqual(seen.pop(), [{ to: "0x1" }, "0x65", {}, { time: "0x5" }]);
});

test("without execTime (opt-in) the floor behaves exactly as before", async () => {
  const f = new ReadFloor(() => 0, 3000); f.raise(0x65n, 0);
  const seen: unknown[][] = [];
  const req = flooredRequest(async ({ params }) => { seen.push(params as unknown[]); return "0x"; }, f);
  await req({ method: "eth_call", params: [{ to: "0x1" }, "latest"] });
  assert.deepEqual(seen, [[{ to: "0x1" }, "0x65"]]);
});
