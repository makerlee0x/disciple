import { describe, expect, it } from "vitest";
import { hangarValueUsd } from "@/lib/portfolio";

describe("hangarValueUsd (Hangar value card + account pill)", () => {
  it("is Cash + rockets at price now + Turbo cash", () => {
    // maker 2026-11-20: $1.31 cash + $9.40 rockets + $5.92 Turbo cash = $16.63, not $7.24
    const v = hangarValueUsd(1.31, [{ tokens: 1000, priceNow: 0.0062 }, { tokens: 400, priceNow: 0.008 }], 5.92);
    expect(v).toBeCloseTo(16.63, 6);
  });
  it("skips empty holdings and defaults Turbo cash to 0", () => {
    expect(hangarValueUsd(2, [{ tokens: 0, priceNow: 5 }])).toBe(2);
  });
});
