/**
 * Spendable-gap root cause (Nov 7 report: trade bar "you have $1.98" while CASH showed $2.37).
 * spendableRaw subtracted one op's gas cap (the signed allowance's maxTokenCost, ~0.39 USDG) from WALLET cash, but
 * DisciplePaymaster v5 reserves and charges gas from the hidden prepaid credit only (no token calls; see
 * contracts/src/paymaster/DisciplePaymasterV5.sol). Gas is now held from cash only for the part credit can't cover.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => { process.env.NEXT_PUBLIC_CHAIN_ID = "46630"; return { gas: 390_000n, credit: undefined as bigint | undefined }; });
vi.mock("@/lib/flight/gasReserve", () => ({ gasReservePerOp: () => h.gas, gasCredit: () => h.credit }));
vi.mock("../lib/flight/gasReserve", () => ({ gasReservePerOp: () => h.gas, gasCredit: () => h.credit }));
vi.mock("@/lib/usdg", async original => ({ ...await original<typeof import("../lib/usdg")>(), usdgDecimals: () => 6 }));
import { Reservations, RESERVATIONS } from "../lib/trade/reservations";
import { spendableRaw, canSpend, ownWalletGasRaw, reservePress } from "../lib/flight/rapidTap";

const CASH = 2_372_235n;          // 2.372235 USDG wallet (Nov 7 snapshot)
const CREDIT = 1_655_620n;        // 1.655620 USDG hidden gas credit, reserved 0
beforeEach(() => { RESERVATIONS.clear(); h.credit = undefined; h.gas = 390_000n; });

describe("spendable cash vs hidden gas credit", () => {
  it("reproduces the old gap only when credit is unknown (conservative fallback kept)", () => {
    expect(spendableRaw(CASH)).toBe(CASH - 390_000n);   // 1.982235 ⇒ the "$1.98" the trade bar showed
  });
  it("with v5 credit covering gas, spendable equals the cash a trade can spend", () => {
    h.credit = CREDIT;
    expect(ownWalletGasRaw()).toBe(0n);
    expect(spendableRaw(CASH)).toBe(CASH);
    expect(canSpend(CASH, 2.37)).toBe(true);
    expect(canSpend(CASH, 2.38)).toBe(false);   // never more than the wallet holds: credit is not trade input
  });
  it("pending presses: gas stays off cash until their caps exceed the credit, then only the excess counts", () => {
    h.credit = 1_000_000n;            // covers 2 caps (0.78), not 3 (1.17)
    reservePress("a", "buy", "0x22", 0.2); reservePress("b", "buy", "0x22", 0.2);
    expect(spendableRaw(CASH, false)).toBe(CASH - 400_000n);                       // spends only
    expect(ownWalletGasRaw()).toBe(170_000n);                                     // 3×0.39 − 1.00
    expect(spendableRaw(CASH)).toBe(CASH - 400_000n - 170_000n);
    h.credit = undefined;
    expect(spendableRaw(CASH)).toBe(CASH - 400_000n - 3n * 390_000n);              // unknown ⇒ old math exactly
  });
  it("trade-layer marginal own gas excludes its own reservation (no double count on merge)", () => {
    const r = new Reservations(Date.now, 60_000, false, () => 6); let credit: bigint | undefined = 800_000n;
    r.setGasReserveSource(() => 390_000n); r.setGasCreditSource(() => credit);
    r.reserve("x", { side: "boost", coin: "0x22", usd: 0.2 }); r.reserve("y", { side: "boost", coin: "0x22", usd: 0.2 });
    expect(r.marginalWalletGas(390_000n, "y")).toBe(0n);             // y on top of x: 0.78 ≤ 0.80
    r.reserve("z", { side: "boost", coin: "0x22", usd: 0.2 });
    expect(r.marginalWalletGas(390_000n, "z")).toBe(370_000n);       // z on top of x+y: 1.17 − 0.80
    expect(r.reservedRaw("0xusdg", { usdg: "0xusdg", exceptId: "z" })).toBe(400_000n);  // x+y spends, their gas covered
    credit = undefined;
    expect(r.reservedRaw("0xusdg", { usdg: "0xusdg", exceptId: "z" })).toBe(400_000n + 780_000n);
    expect(r.reservedCash()).toBeCloseTo(0.6 + 1.17, 6);
  });
});
