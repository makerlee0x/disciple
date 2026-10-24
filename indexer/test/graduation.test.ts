import { describe, expect, it } from "vitest";
import { graduationPct } from "../src/math.js";
import { coinGraduationPct } from "../src/api.js";

// live retest #4: same formula as web/lib/mcap.ts graduationPct = curve.progressBps() (RPNR on chain: 9179 at $27,465.22)
describe("graduation %", () => {
  it("matches the curve's progressBps on RPNR", () => {
    expect(graduationPct(27465.222876627162)).toBeCloseTo(91.79, 2);
  });
  it("uses the coin's LaunchTierContext start/graduation mcaps and 100 once graduated", () => {
    const E18 = 10n ** 18n;
    const coin = { start_mcap_usd: (10_000n * E18).toString(), graduation_mcap_usd: (90_000n * E18).toString() };
    expect(coinGraduationPct(coin, 40_000)).toBeCloseTo(((1 - Math.sqrt(1 / 4)) / (1 - Math.sqrt(1 / 9))) * 100, 9);
    expect(coinGraduationPct({}, 27465.222876627162)).toBeCloseTo(91.79, 2);
    expect(coinGraduationPct({ graduated: 1 }, 1)).toBe(100);
    expect(coinGraduationPct({}, null)).toBeNull();
  });
});
