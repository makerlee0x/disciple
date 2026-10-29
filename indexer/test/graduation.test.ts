import { describe, expect, it } from "vitest";
import { graduationPct, steepCurveMcap } from "../src/math.js";
import { coinGraduationPct } from "../src/api.js";

// live retest #4: same formula as web/lib/mcap.ts graduationPct = curve.progressBps() (RPNR on chain: 9179 at $27,465.22)
describe("graduation %", () => {
  it("matches the curve's progressBps on RPNR (v4 coin: $7K/$33K constant-product endpoints)", () => {
    expect(graduationPct(27465.222876627162, 7_000, 33_000)).toBeCloseTo(91.79, 2);
  });
  it("redeploy v5 default: the steep curve #1 ($3,333 → $33,333, m(g) = M0/(1−a·g)² + T·g^30) ⇒ % = g", () => {
    for (const g of [0.05, 0.5, 0.9, 0.99]) expect(graduationPct(steepCurveMcap(g))).toBeCloseTo(g * 100, 3);
    expect(graduationPct(33_333)).toBe(100);
    expect(graduationPct(3_333)).toBe(0);
  });
  it("uses the coin's LaunchTierContext start/graduation mcaps and 100 once graduated", () => {
    const E18 = 10n ** 18n;
    const coin = { start_mcap_usd: (10_000n * E18).toString(), graduation_mcap_usd: (90_000n * E18).toString() };
    expect(coinGraduationPct(coin, 40_000)).toBeCloseTo(((1 - Math.sqrt(1 / 4)) / (1 - Math.sqrt(1 / 9))) * 100, 9);
    const v4 = { start_mcap_usd: (7_000n * E18).toString(), graduation_mcap_usd: (33_000n * E18).toString() };
    expect(coinGraduationPct(v4, 27465.222876627162)).toBeCloseTo(91.79, 2);
    expect(coinGraduationPct({}, steepCurveMcap(0.5))).toBeCloseTo(50, 3);   // no LaunchTierContext ⇒ v5 steep default
    expect(coinGraduationPct({ graduated: 1 }, 1)).toBe(100);
    expect(coinGraduationPct({}, null)).toBeNull();
  });
});
