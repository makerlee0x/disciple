/** UsdgTrade → Fill.usdIn/usdOut matching (pure). Run: pnpm test:usdg-fill */
import assert from "node:assert/strict";
import { usdgAmounts, usdgIndex, usdgKey } from "../lib/trades";
let n = 0; const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const A = "0xd9fdF29fBAB9Be7cA1F6A3A07e0c36D65170AEf5", T = "0xC47F8EDF14F2D907D467C55F86BDE1C8B6DB65B3", TX = "0xABC";
t("buy → usdIn from amountIn (18dp)", () => assert.deepEqual(usdgAmounts({ trader: A, token: T, isBuy: true, amountIn: 20n * 10n ** 18n, amountOut: 1n }, 18), { usdIn: 20 }));
t("sell → usdOut from amountOut", () => assert.deepEqual(usdgAmounts({ trader: A, token: T, isBuy: false, amountIn: 1n, amountOut: 7562410831387107309n }, 18), { usdOut: Number(7562410831387107309n) / 1e18 }));
t("6-dec USDG: 20 USDG = 20_000_000 raw → $20", () => assert.deepEqual(usdgAmounts({ trader: A, token: T, isBuy: true, amountIn: 20_000_000n, amountOut: 1n }, 6), { usdIn: 20 }));
t("6-dec sell → usdOut 7.56241", () => assert.deepEqual(usdgAmounts({ trader: A, token: T, isBuy: false, amountIn: 1n, amountOut: 7_562_410n }, 6), { usdOut: 7.56241 }));
t("no router trade → nothing", () => assert.deepEqual(usdgAmounts(undefined, 18), {}));
t("index keys are case-insensitive, side-specific, FIFO", () => {
  const m = usdgIndex([
    { tx: TX, args: { trader: A, token: T, isBuy: true, amountIn: 1n, amountOut: 0n } },
    { tx: TX, args: { trader: A, token: T, isBuy: true, amountIn: 2n, amountOut: 0n } },
    { tx: TX, args: { trader: A, token: T, isBuy: false, amountIn: 0n, amountOut: 3n } },
  ]);
  const q = m.get(usdgKey("0xabc", T.toLowerCase(), true))!;
  assert.equal(q.shift()!.amountIn, 1n); assert.equal(q.shift()!.amountIn, 2n);
  assert.equal(m.get(usdgKey(TX, T, false))!.length, 1);
});
console.log(`${n} passed`);
