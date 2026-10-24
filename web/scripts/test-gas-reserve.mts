// gasReservePerOp / peekGasReservePerOp (GAME cash reservation): sync, USDG base units. Pure, no RPC.  pnpm test:gas-reserve
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { FALLBACK_MAX_COST_USDG, PaymasterCapCache, fallbackGasReserve, fallbackUsdgDecimals, peekReserve, reserveOrFallback } from "../lib/aa/gasReserve";
import { Mav2Account } from "../lib/aa/mav2";

const PM = "0x00000000000000000000000000000000000000b1" as Address, USDG = "0x00000000000000000000000000000000000000b2" as Address;
const SENDER = "0x00000000000000000000000000000000000000ee" as Address;
const E18 = BigInt(10) ** BigInt(18);

test("pure tiers: self-pay 0n; allowance ?? cap ?? null; fallback = 10 USDG at the decimals", () => {
  assert.equal(peekReserve({ usdgGas: false, cap: BigInt(5) }), BigInt(0));
  assert.equal(peekReserve({ usdgGas: true }), null);
  assert.equal(peekReserve({ usdgGas: true, cap: BigInt(9) }), BigInt(9));
  assert.equal(peekReserve({ usdgGas: true, cap: BigInt(9), allowanceMaxTokenCost: BigInt(3) }), BigInt(3));
  assert.equal(FALLBACK_MAX_COST_USDG, 10);
  assert.equal(fallbackGasReserve(18), BigInt(10) * E18); assert.equal(fallbackGasReserve(6), BigInt(10_000_000));
  assert.equal(fallbackUsdgDecimals(46630), 18); assert.equal(fallbackUsdgDecimals(1), 6);
  assert.equal(reserveOrFallback(null, 6), BigInt(10_000_000)); assert.equal(reserveOrFallback(BigInt(0), 6), BigInt(0));
});

function fakePc(cap: bigint, decimals: number) {
  let reads = 0;
  const pc = { readContract: async ({ functionName }: { functionName: string }) => { reads++; return functionName === "maxCostCap" ? cap : decimals; } };
  return { pc, reads: () => reads };
}

test("PaymasterCapCache: one deduped read; failure leaves it cold for the next warm", async () => {
  const c = new PaymasterCapCache(), f = fakePc(BigInt(7) * E18, 18);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await Promise.all([c.warm(f.pc as any, PM, USDG), c.warm(f.pc as any, PM, USDG)]);
  assert.deepEqual(c.peek(), { cap: BigInt(7) * E18, decimals: 18 }); assert.equal(f.reads(), 2);
  const bad = new PaymasterCapCache();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await bad.warm({ readContract: async () => { throw new Error("rpc down"); } } as any, PM, USDG);
  assert.equal(bad.peek(), undefined);
});

function account(o: { usdgGas: boolean; cap?: bigint; decimals?: number; chainId?: number }) {
  const chain = { id: o.chainId ?? 46630, name: "t", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:1"] } } };
  const f = fakePc(o.cap ?? BigInt(0), o.decimals ?? 18);
  const a = new Mav2Account({ chain: chain as never, pc: f.pc as never, bundlerUrl: "http://b.test", usdgGas: o.usdgGas ? { paymaster: PM, usdg: USDG, url: "http://pm.test/api/paymaster", session: true } : undefined }, { address: SENDER } as never);
  (a as unknown as { owned: () => Promise<unknown> }).owned = async () => ({ account: { address: SENDER } });
  return a;
}
const allowance = (maxTokenCost: bigint, validUntil: number) => ({ paymaster: PM, paymasterData: "0x", paymasterVerificationGasLimit: "0x1", paymasterPostOpGasLimit: "0x1",
  disciple: { kind: "allowance", sender: SENDER, usdg: USDG, rate: "0x1", maxTokenCost: `0x${maxTokenCost.toString(16)}`, debt: "0x0", validUntil, validAfter: 0, maxFeePerGas: "0x1", usdgDecimals: 18 } });

test("Mav2Account cold ⇒ peek null, gasReservePerOp = fallback (sync); warm ⇒ maxCostCap; allowance ⇒ its maxTokenCost", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ jsonrpc: "2.0", id: 1, error: { message: "not yet" } })) as typeof fetch;   // allowance refresh: none
  try {
    const a = account({ usdgGas: true, cap: BigInt(4) * E18, decimals: 18 });
    assert.equal(a.peekGasReservePerOp(), null);
    assert.equal(a.gasReservePerOp(), BigInt(10) * E18);
    await a.warmGasReserve();
    assert.equal(a.peekGasReservePerOp(), BigInt(4) * E18); assert.equal(a.gasReservePerOp(), BigInt(4) * E18);
    a.allowances!.set(allowance(BigInt(123), Math.floor(Date.now() / 1000) + 3600) as never);
    assert.equal(a.peekGasReservePerOp(), BigInt(123)); assert.equal(a.gasReservePerOp(), BigInt(123));
    const m = account({ usdgGas: true, chainId: 1 });   // mainnet-style cold: 6-dec fallback
    assert.equal(m.gasReservePerOp(), BigInt(10_000_000));
  } finally { globalThis.fetch = orig; }
});

test("Mav2Account self-pay (no USDG gas) ⇒ 0n both, no reads", async () => {
  const a = account({ usdgGas: false });
  assert.equal(a.peekGasReservePerOp(), BigInt(0)); assert.equal(a.gasReservePerOp(), BigInt(0));
  await a.warmGasReserve(); assert.equal(a.caps.peek(), undefined);
});
