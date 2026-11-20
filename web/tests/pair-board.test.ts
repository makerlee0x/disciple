import { describe, expect, it } from "vitest";
import { pairBoard, rankPairs, PAIR_SAFE, type PairCoin } from "@/lib/home/pairBoard";
import type { Fill } from "@/lib/trades";

const P = (symbol: string, i: number): PairCoin => ({ symbol, name: symbol, address: `0x${String(i).padStart(40, "0")}`, decimals: 18, icon: `/whitelist/${symbol}.png` });
const pairs = ["A", "B", "C"].map(P);
const fill = (coin: string, trader: string, usd: number, ts: number, extra: Partial<Fill> = {}) =>
  ({ id: `${coin}${trader}${ts}`, tx: "", logIndex: 0, block: 0, ts, coin, trader, side: "buy", venue: "curve", tokens: 1, usd, priceUsd: 1, mcapUsd: 1, ...extra }) as Fill;

describe("pairBoard", () => {
  const launches = [
    { token: "0xr1", quote: pairs[0].address, block: 10 },
    { token: "0xr2", quote: pairs[0].address, block: 50 },
    { token: "0xr3", quote: pairs[1].address, block: 60 },
    { token: "0xr4", quote: "0xnotapair", block: 60 },
  ];
  const fills = [
    fill("0xr1", "0xw1", 100, 1000),
    fill("0xr2", "0xw1", 50, 2000, { usdIn: 60 }),
    fill("0xr3", "0xw2", 500, 2000),
    fill("0xr3", "0xw3", 10, 500),
    fill("0xr4", "0xw9", 9999, 2000),
  ];
  const burns = [{ token: "0xr3", quoteRaw: (BigInt(5) * BigInt(10) ** BigInt(18)).toString(), block: 70 }];

  it("sums each pair's rockets, $ volume (router $ first), unique traders and burns at today's price; every pair gets a row", () => {
    const rows = pairBoard(pairs, launches, fills, burns, { [pairs[1].address]: 2 });
    expect(rows.map((r) => r.symbol)).toEqual(["A", "B", "C"]);
    expect(rows[0]).toMatchObject({ rockets: 2, volumeUsd: 160, traders: 1, burned: 0 });
    expect(rows[1]).toMatchObject({ rockets: 1, volumeUsd: 510, traders: 2, burned: 5, burnedUsd: 10 });
    expect(rows[2]).toMatchObject({ rockets: 0, volumeUsd: 0, traders: 0 });
  });

  it("the window drops older launches, fills and burns", () => {
    const rows = pairBoard(pairs, launches, fills, burns, {}, 40, 1500);
    expect(rows[0]).toMatchObject({ rockets: 1, volumeUsd: 60, traders: 1 });
    expect(rows[1]).toMatchObject({ rockets: 1, volumeUsd: 500, traders: 1, burned: 5 });
  });

  it("ranks by the chosen number, ties by volume then list order", () => {
    const rows = pairBoard(pairs, launches, fills, burns, {});
    expect(rankPairs(rows, "volume").map((r) => [r.symbol, r.rank])).toEqual([["B", 1], ["A", 2], ["C", 3]]);
    expect(rankPairs(rows, "rockets")[0].symbol).toBe("A");
    expect(rankPairs(rows, "burned")[0].symbol).toBe("B");
  });

  it("12 pairs: 10 safe, 2 under the line", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => P(`C${i}`, i + 1));
    const ranked = rankPairs(pairBoard(twelve, [], [], [], {}), "volume");
    expect(ranked.filter((r) => r.rank > PAIR_SAFE).map((r) => r.symbol)).toEqual(["C10", "C11"]);
  });
});

describe("combined score", () => {
  it("best pair on every number scores 1000; weights follow PAIR_SCORE_WEIGHTS", () => {
    const two = ["X", "Y"].map(P);
    const launches = [{ token: "0xa", quote: two[0].address, block: 1 }, { token: "0xb", quote: two[1].address, block: 1 }, { token: "0xc", quote: two[1].address, block: 1 }];
    const fills = [fill("0xa", "0xw1", 100, 1), fill("0xb", "0xw2", 50, 1)];
    const rows = pairBoard(two, launches, fills, [], {});
    // X: full volume (40) + half the rockets (7.5) + full traders (15) = 62.5 → 625; Y: 20 + 15 + 15 = 50 → 500
    expect(rows.map((r) => r.score)).toEqual([625, 500]);
    expect(rankPairs(rows, "score")[0].symbol).toBe("X");
  });
});
