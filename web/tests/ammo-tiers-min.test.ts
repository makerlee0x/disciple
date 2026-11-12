import { describe, expect, it } from "vitest";
import { AMMO_TIERS } from "../lib/flight/ammoTiers";

describe("ammo tiers vs the $3 minimum buy (lee, Nov 9 2026)", () => {
  it("SPARK and KINDLE presets are never under $3", () => {
    for (const id of ["spark", "kindle"]) {
      const t = AMMO_TIERS.find((x) => x.id === id)!;
      for (const u of t.usd) expect(u).toBeGreaterThanOrEqual(3);
    }
    expect(AMMO_TIERS.find((x) => x.id === "spark")!.usd).toEqual([3, 3, 3, 3, 5, 20]);
    expect(AMMO_TIERS.find((x) => x.id === "kindle")!.usd).toEqual([3, 3, 5, 10, 25, 100]);
  });
});
