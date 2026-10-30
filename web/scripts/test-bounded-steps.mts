// Bounded server/pre-send steps (fix/bound-server-steps-ascended): a hung nonce KV EVAL, grad-gas estimateGas or
// ensurePveLogin each finish within their bound with a clear outcome instead of stalling.
// Run: npx tsx --conditions=react-server --test scripts/test-bounded-steps.mts
import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { SharedNonceCursor, type NonceStore } from "../lib/server/relayerNonce";
import { Mav2Account, GRAD_GAS_BUDGET_MS } from "../lib/aa/mav2";
import { GRAD_STATIC_GAS } from "../lib/aa/fastPath";
import { ensurePveLogin, PveError, PVE_LOGIN_BUDGET_MS, PVE_SLOW_MSG, _resetPveCache } from "../lib/pve";
import { deployment } from "../lib/chains";

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

test("hung grad-gas estimateGas falls back to the fixed grad gas within the bound", async () => {
  assert.ok(GRAD_GAS_BUDGET_MS >= 1500 && GRAD_GAS_BUDGET_MS <= 3000);
  const fake = { o: { pc: { estimateGas: () => hang<bigint>() } } };
  const gradGas = (Mav2Account.prototype as unknown as { gradGas: (s: Address, c: unknown[]) => Promise<unknown> }).gradGas;
  const t0 = Date.now();
  const g = await gradGas.call(fake, ME, [{ to: ME, data: "0x" }]);
  const dt = Date.now() - t0;
  assert.deepEqual(g, GRAD_STATIC_GAS);
  assert.ok(dt < GRAD_GAS_BUDGET_MS + 300, `took ${dt} ms`);
});

test("hung ensurePveLogin fails within the bound with the clear message", { skip: deployment().loginGate === "0x0000000000000000000000000000000000000000" ? "no loginGate in this deployment" : false }, async () => {
  assert.ok(PVE_LOGIN_BUDGET_MS >= 1500 && PVE_LOGIN_BUDGET_MS <= 3000);
  _resetPveCache();
  const pc = { readContract: () => hang<bigint>() } as never;
  const t0 = Date.now();
  await assert.rejects(ensurePveLogin(pc, ME, { token: async () => "t" }), (e: unknown) => e instanceof PveError && e.code === "Network" && e.message === PVE_SLOW_MSG);
  assert.ok(Date.now() - t0 < PVE_LOGIN_BUDGET_MS + 300);
  // hung attest fetch too
  _resetPveCache();
  await assert.rejects(ensurePveLogin({ readContract: async () => BigInt(0) } as never, ME, { token: async () => "t", fetchFn: (() => hang<Response>()) as typeof fetch, budgetMs: 200 }), (e: unknown) => e instanceof PveError && e.message === PVE_SLOW_MSG);
});

test("player-facing trade wording says ASCENDED, not graduated", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["lib/protocol-viem.ts", "lib/firstBoost.ts", "lib/trampwalls/onchain.ts"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.ok(!/"[^"]*\b(has graduated|graduates\.|after graduation)[^"]*"/.test(src), f);
  }
});
