// 6-dec USDG: per-coin quote decimals (coins.quote_decimals) and quote sums scaled by them, never a blanket 1e18.
import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { openDb } from "../src/db";
import { Api } from "../src/api";
import { fillQuoteDecimals, parseQuoteDecimals } from "../src/decimals";
import type { Config, Stack } from "../src/config";

const A = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Hex;
const stack: Stack = { id: "t", fromBlock: 0n, launchpad: A(1), feeRouter: A(2), hook: A(3) };
const cfg: Config = { chainId: 1, rpcUrl: "", stateView: A(9), stacks: [stack], dbPath: ":memory:", port: 0, chunk: 1000n, pollMs: 0, confirmations: 0, reorgDepth: 64, rpcRps: 0, minChunk: 10n };
const USDG6 = A(0x600), STRAT18 = A(0x1800), C6 = A(0x10), C18 = A(0x11), K = A(0xee);

function seed() {
  const db = openDb(":memory:");
  const coin = db.prepare("INSERT INTO coins (token, stack, curve, creator, quote, name, ticker) VALUES (?,?,?,?,?,?,?)");
  coin.run(C6, "t", A(0x20), A(0xa1), USDG6, "Six", "SIX");
  coin.run(C18, "t", A(0x21), A(0xa1), STRAT18, "Eighteen", "EIT");
  const fe = db.prepare("INSERT INTO fee_events (id, stack, kind, token, account, quote, a, b, block, ts, tx) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  fe.run("1", "t", "SnipeFeeRouted", C6, A(0), USDG6, String(5_000_000n), String(2_500_000n), 1, 1, "0x1");          // $5 / $2.5 of 6-dec USDG
  fe.run("2", "t", "SnipeFeeRouted", C18, A(0), STRAT18, String(7n * 10n ** 18n), String(10n ** 18n), 1, 1, "0x2");  // 7 / 1 STRATEGY
  db.prepare("INSERT INTO orders (stack, id, kind, owner, token) VALUES ('t', 1, 'tramp', ?, ?)").run(A(0xb0), C6);
  db.prepare("INSERT INTO keeper_tips VALUES ('k1','t',1,?,?,?,1,1,'0x3')").run(K, String(250_000n), "0");                // $0.25 USDG tip
  return db;
}

describe("quote decimals (6-dec USDG)", () => {
  it("parses QUOTE_DECIMALS", () => {
    expect(parseQuoteDecimals(`${USDG6}:6, ${STRAT18}=18, junk, 0x12:99`)).toEqual({ [USDG6]: 6, [STRAT18]: 18 });
    expect(parseQuoteDecimals(undefined)).toEqual({});
  });

  it("fills coins.quote_decimals from config first, else decimals() on-chain; unreadable stays NULL", async () => {
    const db = seed();
    const reads: string[] = [];
    const n = await fillQuoteDecimals(db, async (t) => { reads.push(t); if (t === STRAT18) return 18; throw new Error("rpc down"); }, { [USDG6]: 6 });
    expect(n).toBe(2);
    expect(reads).toEqual([STRAT18]);                                    // USDG came from config: no RPC
    const dec = Object.fromEntries((db.prepare("SELECT token, quote_decimals d FROM coins").all() as any[]).map((r) => [r.token, r.d]));
    expect(dec).toEqual({ [C6]: 6, [C18]: 18 });

    const db2 = seed();
    expect(await fillQuoteDecimals(db2, async () => { throw new Error("rpc down"); })).toBe(0);
    expect((db2.prepare("SELECT COUNT(*) n FROM coins WHERE quote_decimals IS NULL").get() as any).n).toBe(2); // never guessed as 18
  });

  it("scales /rewards and keeper tips by each coin's quote decimals", async () => {
    const db = seed();
    await fillQuoteDecimals(db, async () => 18, { [USDG6]: 6 });
    const api = new Api(db, null, cfg);
    const [, rw]: any = await api.route("GET", new URL("http://x/rewards"));
    const by = Object.fromEntries(rw.map((r: any) => [r.asset, r]));
    expect(by[USDG6]).toMatchObject({ sum_a: 5, sum_b: 2.5 });
    expect(by[STRAT18]).toMatchObject({ sum_a: 7, sum_b: 1 });
    const [, kp]: any = await api.route("GET", new URL("http://x/leaderboard/keepers"));
    expect(kp[0]).toMatchObject({ user: K, quoteTips: 0.25 });
    expect((api as any).profile(K).keeperTips).toMatchObject({ n: 1, quote: 0.25 });
  });

  it("18-dec testnet mUSDG keeps today's numbers", async () => {
    const db = seed();
    db.prepare("UPDATE fee_events SET a=?, b=? WHERE id='1'").run(String(5n * 10n ** 18n), String(25n * 10n ** 17n));
    await fillQuoteDecimals(db, async () => 18);
    const [, rw]: any = await new Api(db, null, cfg).route("GET", new URL("http://x/rewards"));
    expect(rw.find((r: any) => r.asset === USDG6)).toMatchObject({ sum_a: 5, sum_b: 2.5 });
  });
});
