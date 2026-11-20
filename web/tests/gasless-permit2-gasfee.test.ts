/** With NEXT_PUBLIC_GASLESS_GAS_FEE set (the flat network fee, maker 2026-11-19), the site's Trade witness is byte for byte
 *  the one DiscipleRouter.sol checks (7 fields, maxGasFee last). */
import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => { process.env.NEXT_PUBLIC_GASLESS_GAS_FEE = "0.01"; });
import { readFileSync } from "node:fs";
import { GAS_FEE_LIVE, TRADE_TYPE, TRADE_WITNESS_TYPE } from "../lib/trade/gaslessPermit2";

describe("Permit2 Trade witness with the gas fee on", () => {
  it("matches DiscipleRouter.sol", () => {
    expect(GAS_FEE_LIVE).toBe(true);
    const sol = readFileSync(new URL("../../contracts/src/DiscipleRouter.sol", import.meta.url), "utf8");
    const witness = /TRADE_WITNESS_TYPE\s*=\s*"([^"]*)"\s*"([^"]*)"/.exec(sol);
    expect(witness).not.toBeNull();
    expect(TRADE_WITNESS_TYPE).toBe(witness![1] + witness![2]);
    expect(sol).toContain(`"${TRADE_TYPE}"`);
  });
});
