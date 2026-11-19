/** maker 2026-11-19: anon launches should count for trophies, without a public trophy pointing at the hidden coin. */
import { describe, expect, it } from "vitest";
import { V1_RULES } from "@/lib/achievements";
import { evaluateWallet } from "@/lib/achievementsEval";
import { coinEvents, hideHosted, type CoinMeta } from "@/lib/server/achievements";

const ME = "0x1111111111111111111111111111111111111111";
const LAUNCHER = "0x526784706e5ef369412abe65213ed65256182c6b";
const COIN = "0x88e0000000000000000000000000000000030be0";
const meta: CoinMeta = { creator: LAUNCHER, anon: true, curve: "0xc0", launch: { tx: "0xaa", block: 10, logIndex: 1, ts: 1_000 }, grad: { tx: "0xbb", block: 20, logIndex: 2, ts: 2_000 } };
const metas = new Map([[COIN, meta]]);

describe("hidden launch trophies", () => {
  it("don't count without the host's proof", () => {
    const r = evaluateWallet(ME, coinEvents(metas), V1_RULES);
    expect(r.unlocks.map((u) => u.id)).not.toContain("pad_ignition");
  });
  it("count for the credited host, and carry no coin, tx or launch time", () => {
    const r = evaluateWallet(ME, coinEvents(metas, { wallet: ME, coins: new Set([COIN]) }), V1_RULES);
    const ids = r.unlocks.map((u) => u.id);
    expect(ids).toContain("pad_ignition");
    expect(ids).toContain("graduated_dev");
    const shown = r.unlocks.map((u) => hideHosted(u, new Map([[COIN, 9_999]])));
    for (const u of shown.filter((x) => x.id === "pad_ignition" || x.id === "graduated_dev")) {
      expect(u.coin).toBeUndefined(); expect(u.tx).toBe(""); expect(u.block).toBe(0); expect(u.ts).toBe(9_999);
    }
  });
  it("someone else can't ride on another host's credit", () => {
    const r = evaluateWallet("0x2222222222222222222222222222222222222222", coinEvents(metas, { wallet: ME, coins: new Set([COIN]) }), V1_RULES);
    expect(r.unlocks.map((u) => u.id)).not.toContain("pad_ignition");
  });
});
