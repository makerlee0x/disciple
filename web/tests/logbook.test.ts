import { describe, expect, it } from "vitest";
import { logbookEntry, logRecord, type LogCoin, type LogFill } from "@/lib/logbook";

const H = 3600_000, NOW = 200 * H, ME = "0xme", HOST = "0xhost";
let n = 0;
const f = (trader: string, side: "buy" | "sell", tokens: number, usd: number, ts: number, mcapUsd: number, impactBps?: number): LogFill =>
  ({ ts, block: ++n, logIndex: 0, trader, side, tokens, usd, mcapUsd, priceUsd: usd / tokens, impactBps });
const coin = (o: Partial<LogCoin> = {}): LogCoin => ({ token: "0xc", name: "Halo Drive", ticker: "HALO", creator: HOST, graduated: false, ...o });

describe("logbook entry", () => {
  it("never boosted: no entry", () => {
    expect(logbookEntry({ wallet: ME, coin: coin(), fills: [f("0xa", "buy", 1, 10, H, 5000)], now: NOW })).toBeNull();
  });
  it("aboard for orbit, first crew, a bomb held, crew aboard, zones in the story", () => {
    const fills = [
      f(HOST, "buy", 10, 10, H, 4000),
      f("0xa", "buy", 10, 10, 2 * H, 4500),
      f(ME, "buy", 10, 20, 3 * H, 5000),
      f("0xcrew", "buy", 10, 20, 4 * H, 9000),
      f("0xa", "sell", 5, 30, 5 * H, 8000, 700),
      f("0xb", "buy", 100, 400, 6 * H, 20_000),
      f("0xd", "buy", 100, 900, 7 * H, 36_000),
    ];
    const r = logbookEntry({ wallet: ME, coin: coin({ graduated: true, mcapUsd: 40_000 }), fills, crew: new Set(["0xcrew"]), now: NOW })!;
    expect(r.entry).toMatchObject({ status: "aboard", boardedZone: "LAUNCH PAD", pilotNo: 2, firstCrew: true, bombsHeld: 1, orbitAboard: true, crewAboard: 1, nowZone: "IN ORBIT" });
    expect(r.entry.news?.kind).toBe("orbit_aboard");
    expect(r.entry.peakZone).toBe("OUTER SPACE");
    expect(r.story.map((x) => x.kind)).toEqual(["boarded", "crew_joined", "bomb_held", "zone", "zone", "orbit"]);
    expect(r.entry.paperUsd).toBeCloseTo(90, 5); // 10 tokens × the last price ($9)
  });
  it("left green, then the rocket climbed: news after you left; a dump inside 10 min means the bomb wasn't held", () => {
    const fills = [
      f(ME, "buy", 10, 20, H, 13_000),
      f("0xa", "sell", 5, 30, 2 * H, 12_000, 600),
      f(ME, "sell", 10, 40, 2 * H + 60_000, 14_000),
      f("0xb", "buy", 100, 900, 50 * H, 30_000),
    ];
    const r = logbookEntry({ wallet: ME, coin: coin(), fills, now: NOW })!;
    expect(r.entry).toMatchObject({ status: "green", bankedUsd: 20, bombsHeld: 0, leftAt: 2 * H + 60_000, aboardMs: H + 60_000, paperUsd: null });
    expect(r.entry.news).toMatchObject({ kind: "zone_after", zone: "KÁRMÁN LINE" });
    expect(logRecord([r.entry])).toMatchObject({ rockets: 1, green: 1, red: 0, news: 1 });
  });
});
