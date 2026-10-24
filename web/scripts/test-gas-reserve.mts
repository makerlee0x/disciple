// gasReservePerOp / peekGasReservePerOp (GAME cash reservation): sync, USDG base units. Pure, no network.  pnpm test:gas-reserve
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { PaymasterCapCache, derivedGasReserve, allowanceMaxFee, configRate, fallbackUsdgDecimals, peekReserve, reserveOrDerived, TRADE_GAS_LIMIT, GRAD_GAS_LIMIT, CONFIG_GAS_PRICE_WEI, GAS_PRICE_TTL_MS } from "../lib/aa/gasReserve";
import { tokenCost } from "../lib/aa/paymaster";
import { clientFees } from "../lib/aa/gasPolicy";
import { Mav2Account, FEES } from "../lib/aa/mav2";

const PM = "0x00000000000000000000000000000000000000b1" as Address, USDG = "0x00000000000000000000000000000000000000b2" as Address;
const SENDER = "0x00000000000000000000000000000000000000ee" as Address;
const E18 = BigInt(10) ** BigInt(18), GWEI = BigInt(1e9);
const usd = (raw: bigint, dec = 18) => Number(raw) / 10 ** dec;

test("cold derivation: gas limit × allowance maxFee(gasPrice) × rate, rounded up; no flat 10 USDG anywhere", () => {
  assert.equal(TRADE_GAS_LIMIT, BigInt(2_410_000)); assert.equal(GRAD_GAS_LIMIT, BigInt(6_000_000));
  const gp = GWEI / BigInt(100);   // 0.01 gwei = RH testnet eth_gasPrice on Oct 24 2026
  assert.equal(allowanceMaxFee(gp), clientFees(gp).maxFeePerGas * BigInt(2), "same formula as paymasterCore.allowanceQuote");
  const rate = configRate(18);
  assert.equal(derivedGasReserve({ gasPriceWei: gp, decimals: 18 }), tokenCost(TRADE_GAS_LIMIT * allowanceMaxFee(gp), rate));
  const trade = usd(derivedGasReserve({ gasPriceWei: gp, decimals: 18 })), grad = usd(derivedGasReserve({ kind: "gradBuy", gasPriceWei: gp, decimals: 18 }));
  assert.ok(trade > 0.3 && trade < 0.45, `trade ${trade}`); assert.ok(grad > 0.8 && grad < 1, `grad ${grad}`);
  // no RPC data at all ⇒ config gas price (0.0207 gwei) + config ETH/USD: the documented floor, still < $1 for a trade
  const floor = usd(derivedGasReserve({ decimals: 18 }));
  assert.equal(CONFIG_GAS_PRICE_WEI, BigInt(20_700_000)); assert.ok(floor > 0.6 && floor < 0.8, `floor ${floor}`);
  assert.equal(usd(derivedGasReserve({ decimals: 6 }), 6).toFixed(2), floor.toFixed(2), "decimals-aware");
  // rate: the paymaster's signed rate wins over config; cap clamps (the contract refuses more)
  assert.equal(derivedGasReserve({ gasPriceWei: gp, rate: rate * BigInt(2), decimals: 18 }), tokenCost(TRADE_GAS_LIMIT * allowanceMaxFee(gp), rate * BigInt(2)));
  assert.equal(derivedGasReserve({ gasPriceWei: gp, decimals: 18, cap: BigInt(5) }), BigInt(5));
  assert.equal(fallbackUsdgDecimals(46630), 18); assert.equal(fallbackUsdgDecimals(1), 6);
});

test("warm: the REAL maxTokenCost as is — never min(cached, derived), so a gas spike never under-reserves", () => {
  const a = { maxTokenCost: BigInt(9) * E18 / BigInt(10), rate: configRate(18), debt: BigInt(0), maxFeePerGas: GWEI };   // spike: 1 gwei maxFee
  const derived = derivedGasReserve({ gasPriceWei: GWEI / BigInt(100), decimals: 18 });
  assert.ok(a.maxTokenCost > derived);
  assert.equal(peekReserve({ usdgGas: true, allowance: a }), a.maxTokenCost, "warm ≥ what the op approves");
  assert.equal(reserveOrDerived(peekReserve({ usdgGas: true, allowance: a }), { decimals: 18 }), a.maxTokenCost);
  // grad buy (per-op quote, above the envelope): GRAD_GAS_CAPS.total × max(allowance fee, op fee) × rate + debt
  const debt = BigInt(7);
  assert.equal(peekReserve({ usdgGas: true, kind: "gradBuy", allowance: { ...a, debt } }), tokenCost(GRAD_GAS_LIMIT * GWEI, a.rate) + debt);
  assert.equal(peekReserve({ usdgGas: true, kind: "gradBuy", allowance: a, opMaxFee: GWEI * BigInt(2) }), tokenCost(GRAD_GAS_LIMIT * GWEI * BigInt(2), a.rate));
  assert.equal(peekReserve({ usdgGas: true, kind: "gradBuy", allowance: a, cap: BigInt(3) }), BigInt(3));
  // self-pay ⇒ 0n; cold ⇒ null
  assert.equal(peekReserve({ usdgGas: false, allowance: a }), BigInt(0)); assert.equal(peekReserve({ usdgGas: true }), null);
});

function fakePc(cap: bigint, decimals: number, gasPrice = GWEI / BigInt(100)) {
  let reads = 0, gps = 0;
  const pc = { readContract: async ({ functionName }: { functionName: string }) => { reads++; return functionName === "maxCostCap" ? cap : decimals; }, getGasPrice: async () => { gps++; return gasPrice; } };
  return { pc, reads: () => reads, gps: () => gps };
}

test("PaymasterCapCache: one deduped cap read; gas price re-read after its TTL; failures leave the old value", async () => {
  const clock = { t: 1_000 }, c = new PaymasterCapCache(() => clock.t), f = fakePc(BigInt(7) * E18, 18);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await Promise.all([c.warm(f.pc as any, PM, USDG), c.warm(f.pc as any, PM, USDG)]);
  assert.deepEqual(c.peek(), { cap: BigInt(7) * E18, decimals: 18 }); assert.equal(f.reads(), 2);
  await c.warmGasPrice(f.pc); await c.warmGasPrice(f.pc); assert.equal(f.gps(), 1); assert.equal(c.gasPrice(), GWEI / BigInt(100));
  clock.t += GAS_PRICE_TTL_MS + 1; await c.warmGasPrice(f.pc); assert.equal(f.gps(), 2);
  clock.t += GAS_PRICE_TTL_MS + 1; await c.warmGasPrice({ getGasPrice: async () => { throw new Error("rpc down"); } }); assert.equal(c.gasPrice(), GWEI / BigInt(100));
  const bad = new PaymasterCapCache();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await bad.warm({ readContract: async () => { throw new Error("rpc down"); } } as any, PM, USDG);
  assert.equal(bad.peek(), undefined);
});

function account(o: { usdgGas: boolean; cap?: bigint; decimals?: number; chainId?: number; gasPrice?: bigint }) {
  const chain = { id: o.chainId ?? 46630, name: "t", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:1"] } } };
  const f = fakePc(o.cap ?? BigInt(1000) * E18, o.decimals ?? 18, o.gasPrice);
  const a = new Mav2Account({ chain: chain as never, pc: f.pc as never, bundlerUrl: "http://b.test", usdgGas: o.usdgGas ? { paymaster: PM, usdg: USDG, url: "http://pm.test/api/paymaster", session: true } : undefined }, { address: SENDER } as never);
  (a as unknown as { owned: () => Promise<unknown> }).owned = async () => ({ account: { address: SENDER } });
  return { a, f };
}
const allowance = (maxTokenCost: bigint, validUntil: number, rate: bigint, maxFee = BigInt(1)) => ({ paymaster: PM, paymasterData: "0x", paymasterVerificationGasLimit: "0x1", paymasterPostOpGasLimit: "0x1",
  disciple: { kind: "allowance", sender: SENDER, usdg: USDG, rate: `0x${rate.toString(16)}`, maxTokenCost: `0x${maxTokenCost.toString(16)}`, debt: "0x0", validUntil, validAfter: 0, maxFeePerGas: `0x${maxFee.toString(16)}`, usdgDecimals: 18 } });

test("Mav2Account: cold (config) ⇒ warm at session start (live gas price) ⇒ fresh allowance = its real maxTokenCost", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ jsonrpc: "2.0", id: 1, error: { message: "not yet" } })) as typeof fetch;   // allowance refresh: none
  try {
    const { a } = account({ usdgGas: true, decimals: 18, gasPrice: GWEI / BigInt(100) });
    assert.equal(a.peekGasReservePerOp(), null);
    assert.equal(a.gasReservePerOp(), derivedGasReserve({ decimals: 18 }), "nothing read yet ⇒ config floor (0.0207 gwei)");
    await a.warmGasReserve();
    assert.equal(a.peekGasReservePerOp(), null, "maxCostCap alone is a ceiling, not a warm value");
    assert.equal(a.gasReservePerOp(), derivedGasReserve({ gasPriceWei: GWEI / BigInt(100), decimals: 18 }), "live gas price");
    assert.ok(usd(a.gasReservePerOp()) < 0.5);
    const rate = configRate(18) * BigInt(3) / BigInt(2), spike = BigInt(123) * E18 / BigInt(100);   // 1.23 USDG: above any derived value
    a.allowances!.set(allowance(spike, Math.floor(Date.now() / 1000) + 3600, rate) as never);
    assert.equal(a.peekGasReservePerOp(), spike); assert.equal(a.gasReservePerOp(), spike, "warm real value, not min'd down");
    const opFee = FEES.peek()?.maxFeePerGas ?? BigInt(0), fee = opFee > BigInt(1) ? opFee : BigInt(1);   // max(allowance maxFee 1 wei, op fee)
    assert.equal(a.gasReservePerOp("gradBuy"), tokenCost(GRAD_GAS_LIMIT * fee, rate), "grad: caps × max fee × signed rate");
    // allowance expired ⇒ cold again, derived with the paymaster's last signed rate
    a.allowances!.set(allowance(spike, Math.floor(Date.now() / 1000) - 10, rate) as never);
    assert.equal(a.peekGasReservePerOp(), null);
    assert.equal(a.gasReservePerOp(), derivedGasReserve({ gasPriceWei: GWEI / BigInt(100), rate, decimals: 18 }));
    const { a: m } = account({ usdgGas: true, chainId: 1 });   // mainnet-style cold: 6-dec, config floor
    assert.equal(m.gasReservePerOp(), derivedGasReserve({ decimals: 6 }));
  } finally { globalThis.fetch = orig; }
});

test("Mav2Account self-pay (no USDG gas) ⇒ 0n both, no reads", async () => {
  const { a, f } = account({ usdgGas: false });
  assert.equal(a.peekGasReservePerOp(), BigInt(0)); assert.equal(a.gasReservePerOp("gradBuy"), BigInt(0));
  await a.warmGasReserve(); assert.equal(a.caps.peek(), undefined); assert.equal(f.gps(), 0);
});

test("lib/wallet exports gasReservePerOp / peekGasReservePerOp (GAME imports them from @/lib/wallet)", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../lib/wallet.ts", import.meta.url), "utf8");
  assert.match(src, /export function gasReservePerOp\(kind: GasOpKind = "trade"\): bigint/);
  assert.match(src, /export function peekGasReservePerOp\(kind: GasOpKind = "trade"\): bigint \| null/);
});
