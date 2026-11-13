// Bounded server/pre-send steps (fix/bound-server-steps-ascended): a hung nonce KV EVAL or grad-gas estimateGas
// each finish within their bound with a clear outcome instead of stalling.
// Run: npx tsx --conditions=react-server --test scripts/test-bounded-steps.mts
import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { SharedNonceCursor, type NonceStore } from "../lib/server/relayerNonce";
import { Mav2Account, GRAD_GAS_BUDGET_MS } from "../lib/aa/mav2";
import { GRAD_STATIC_GAS } from "../lib/aa/fastPath";

const hang = <T,>() => new Promise<T>(() => {});
const ME = "0x4444444444444444444444444444444444444444" as Address;

test("hung nonce KV EVAL (alloc) falls back to the local cursor within ~1.5 s", async () => {
  const store = { alloc: () => hang<number>(), release: () => hang<number>(), claim: () => hang<boolean>() } as unknown as NonceStore;
  const c = new SharedNonceCursor(store, async () => 7, { log: () => {} });
  const t0 = Date.now();
  const n = await c.take();
  const dt = Date.now() - t0;
  assert.equal(n, 7);
  assert.ok(dt >= 1400 && dt < 2000, `took ${dt} ms`);
  assert.equal(c.stats.fallbacks, 1);
});

test("hung USDG graduation estimate falls back within its bound", async () => {
  const a = new Mav2Account({ chain: { id: 46630 } as never, pc: { estimateGas: () => hang<bigint>() } as never, bundlerUrl: "http://127.0.0.1:1" }, { address: ME } as never);
  const t = Date.now();
  assert.deepEqual(await (a as any).gradGas(ME, []), GRAD_STATIC_GAS);
  assert.ok(Date.now() - t < GRAD_GAS_BUDGET_MS + 400);
});

test("player-facing trade wording says ASCENDED, not graduated", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["lib/protocol-viem.ts", "lib/firstBoost.ts", "lib/trampwalls/onchain.ts"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.ok(!/"[^"]*\b(has graduated|graduates\.|after graduation)[^"]*"/.test(src), f);
  }
});
