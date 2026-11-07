import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from "viem";
import { openDb } from "../src/db";
import { applyLogs, type RawLog } from "../src/ingest";
import { applyDiscipleLogs, DISCIPLE_EVENTS, mcapUsdFromAnchor, poolKeyId, Q128, quoteRawToUsd, tvlQuoteRaw } from "../src/disciple";
import { Api } from "../src/api";
import { loadConfig, type Config, type Stack } from "../src/config";

const A = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Hex;
const HOOK = getAddress("0xcEdc3C312C5B3C4310F0fba0323DDeC797E4aA88");
const STRATEGY = getAddress("0x168661C52E5922288dFb2b3f323b6Cf90eb21e18");
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const POOL = "0xddbfa6efd15715013f50e7f1cdceaab3b69b0b8e4c9d4b47fcc28e47f6a80e8f" as Hex;
const CREATOR = A(0xc0);
const SENDER = A(0xb0b);
const E18 = 10n ** 18n;
const USDG_WAD = 10n ** 30n; // $1 per 1e18 raw of 6-dec USDG

let li = 0;
function mk(name: string, args: Record<string, any>, address: Hex, block = 10n): RawLog {
  const ev: any = DISCIPLE_EVENTS.find((e: any) => e.name === name)!;
  const topics = encodeEventTopics({ abi: [ev], eventName: name, args } as any);
  const nonIdx = ev.inputs.filter((i: any) => !i.indexed);
  const data = encodeAbiParameters(nonIdx, nonIdx.map((i: any) => args[i.name]));
  return { address, topics: topics as any, data, blockNumber: block, transactionHash: `0x${(++li).toString(16).padStart(64, "0")}` as Hex, logIndex: li };
}
const ts = (b: bigint) => 1_700_000_000 + Number(b);

const stack: Stack = { id: "t", fromBlock: 1n, launchpad: A(1), feeRouter: A(2), hook: A(3) };
function cfg(disciple = true): Config {
  return {
    chainId: 4663, rpcUrl: "http://disciple", stateView: A(9), stacks: [stack], dbPath: ":memory:", port: 0,
    chunk: 100n, pollMs: 0, confirmations: 0, reorgDepth: 64, rpcRps: 0, minChunk: 1n,
    disciple: disciple ? {
      hook: HOOK, poolManager: getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951"),
      v4Quoter: getAddress("0x8dc178efb8111bb0973dd9d722ebeff267c98f94"),
      fromBlock: 106431488n, rpcUrl: "http://disciple",
      quoteUsdWad: { [USDG.toLowerCase()]: USDG_WAD.toString() },
    } : undefined,
  };
}

describe("DiscipleHook pool id and TVL math", () => {
  it("STRATEGY/USDG key (fee 0, tickSpacing 1, live hook) hashes to the published pool id", () => {
    expect(poolKeyId(STRATEGY, USDG, 0, 1, HOOK)).toBe(POOL);
    // hook fee pips are not the v4 fee — using them changes the id
    expect(poolKeyId(STRATEGY, USDG, 10000, 1, HOOK)).not.toBe(POOL);
  });

  it("TVL is quoteReserve + coin marked at anchorX128, never a liquidity argument", () => {
    const coin = 44814216947137264326696n;
    const quote = 104414801n;
    const anchor = 676691368068158081113397n;
    expect(tvlQuoteRaw(coin, quote, anchor)).toBe(193533123n);
    expect(quoteRawToUsd(193533123n, USDG_WAD)).toBeCloseTo(193.533123, 6);
    expect(tvlQuoteRaw(4n, 10n, 0n)).toBe(20n);
    expect(mcapUsdFromAnchor(1n, Q128, USDG_WAD)).toBeCloseTo(1e-6, 8); // 1 coin raw * 1 quote raw, 6-dec USDG
  });
});

describe("DiscipleHook ingest", () => {
  function seed() {
    const db = openDb(":memory:");
    applyDiscipleLogs(db, HOOK, [
      mk("Created", { id: POOL, coin: STRATEGY, quote: USDG, creator: CREATOR, remoteEid: 0, fee: 10000 }, HOOK, 10n),
      mk("Swapped", { id: POOL, sender: SENDER, buy: true, coinAmt: 5n * E18, quoteAmt: 1_000_000n }, HOOK, 11n),
      mk("Deposited", { id: POOL, owner: CREATOR, lot: 1n, shares: 2n, x: 3n * E18, y: 4_000_000n }, HOOK, 12n),
      mk("Withdrawn", { id: POOL, owner: CREATOR, lot: 1n, x: 1n * E18, y: 1_000_000n }, HOOK, 13n),
      // spoofed hook
      mk("Swapped", { id: POOL, sender: SENDER, buy: false, coinAmt: 1n, quoteAmt: 1n }, A(0xbad), 14n),
    ], ts);
    return db;
  }

  it("indexes Created / Swapped / Deposited / Withdrawn from the hook only", async () => {
    const db = seed();
    const pool = db.prepare("SELECT * FROM disciple_pools").get() as any;
    expect(pool).toMatchObject({
      id: POOL, hook: HOOK.toLowerCase(), coin: STRATEGY.toLowerCase(), quote: USDG.toLowerCase(),
      v4_fee: 0, tick_spacing: 1, hook_fee: 10000, creator: CREATOR,
    });
    expect(db.prepare("SELECT COUNT(*) n FROM disciple_swaps").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT kind FROM disciple_liquidity ORDER BY block").all()).toEqual([{ kind: "deposited" }, { kind: "withdrawn" }]);
    const api = new Api(db, null, cfg());
    const [row] = await api.route("GET", new URL("http://x/disciple/pools")).then((x) => x[1] as any[]);
    expect(row.swaps).toBe(1);
    expect(row.v4Fee).toBe(0);
    const detail = (await api.route("GET", new URL(`http://x/disciple/pools/${POOL}`)))[1] as any;
    expect(detail.tvl).toBeNull(); // no RPC client
    expect((await api.route("GET", new URL(`http://x/disciple/pools/${POOL}/swaps`)))[1]).toHaveLength(1);
  });

  it("second pool of the same pair gets tickSpacing 2; Ascension applyLogs ignores these events", () => {
    const db = openDb(":memory:");
    const other = `0x${"ab".repeat(32)}` as Hex;
    applyDiscipleLogs(db, HOOK, [
      mk("Created", { id: POOL, coin: STRATEGY, quote: USDG, creator: CREATOR, remoteEid: 0, fee: 10000 }, HOOK),
      mk("Created", { id: other, coin: STRATEGY, quote: USDG, creator: CREATOR, remoteEid: 0, fee: 5000 }, HOOK, 11n),
    ], ts);
    const rows = db.prepare("SELECT id, tick_spacing s FROM disciple_pools ORDER BY created_block").all() as any[];
    expect(rows.map((r) => r.s)).toEqual([1, 2]);
    applyLogs(db, stack, [
      mk("Created", { id: POOL, coin: STRATEGY, quote: USDG, creator: CREATOR, remoteEid: 0, fee: 10000 }, HOOK),
    ], ts);
    expect((db.prepare("SELECT COUNT(*) n FROM coins").get() as any).n).toBe(0);
  });

  it("live TVL for a graduated coin on this pool comes from poolState, not getLiquidity", async () => {
    const db = seed();
    const token = A(0x100);
    db.prepare(
      `INSERT INTO coins (token, stack, curve, creator, quote, name, ticker, launched_block, launched_at, graduated, pool_id, total_supply, quote_price_usd)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(token, "t", A(0x101), CREATOR, USDG.toLowerCase(), "C", "C", 1, 1, 1, POOL, (1000n * E18).toString(), USDG_WAD.toString());
    const calls: string[] = [];
    const coinReserve = 1000n * E18;
    const quoteReserve = 2_000_000n; // 2 USDG
    const anchor = Q128; // 1 quote raw per 1 coin raw
    const client = {
      readContract: async ({ functionName, args }: any) => {
        calls.push(functionName);
        if (functionName === "getLiquidity" || functionName === "getSlot0") throw new Error("v4 liquidity is not TVL");
        if (functionName === "poolState") return [STRATEGY, USDG, true, false, false, false, coinReserve, quoteReserve, anchor, 0n, 0n, 0n, 0n, 0n, 1n];
        if (functionName === "balanceOf") return args[1] === BigInt(STRATEGY) ? coinReserve : quoteReserve;
        throw new Error(functionName);
      },
    };
    const api = new Api(db, client as any, cfg());
    const live = (await api.coinDetail(token))!.live;
    expect(calls).not.toContain("getLiquidity");
    expect(calls).not.toContain("getSlot0");
    expect(live.mcapSource).toBe("disciple-pool");
    expect(live.disciple?.source).toBe("poolState");
    expect(live.disciple?.claims?.matchReserves).toBe(true);
    // anchor 1:1 raw ⇒ coin side = 1000e18 quote raw, plus 2e6 quote = that sum; USDG wad prices it
    const expectRaw = tvlQuoteRaw(coinReserve, quoteReserve, anchor);
    expect(live.disciple?.tvlQuoteRaw).toBe(expectRaw.toString());
    expect(live.liquidityUsd).toBeCloseTo(quoteRawToUsd(expectRaw, USDG_WAD)!, 6);
    const detail = (await api.route("GET", new URL(`http://x/disciple/pools/${POOL}`)))[1] as any;
    expect(detail.tvl.tvlQuoteRaw).toBe(expectRaw.toString());
    expect(detail.quoter.toLowerCase()).toBe("0x8dc178efb8111bb0973dd9d722ebeff267c98f94");
  });
});

describe("disciple config mode", () => {
  it("stays off on the Launchpad deployment json", () => {
    expect(loadConfig({} as any).disciple).toBeUndefined();
  });
  it("turns on from the 4663 catalog, or from DISCIPLE_HOOK beside the Launchpad stacks", () => {
    const p = new URL("../../contracts/deployments/rh-4663-disciple-hook.json", import.meta.url).pathname;
    const cat = loadConfig({ DEPLOYMENT_JSON: p } as any);
    expect(cat.stacks).toHaveLength(0);
    expect(cat.chainId).toBe(4663);
    expect(cat.disciple).toMatchObject({ hook: HOOK, fromBlock: 106431488n });
    expect(cat.disciple!.quoteUsdWad[USDG.toLowerCase()]).toBe(USDG_WAD.toString());
    expect(cat.disciple!.v4Quoter!.toLowerCase()).toBe("0x8dc178efb8111bb0973dd9d722ebeff267c98f94");
    const beside = loadConfig({ DISCIPLE_HOOK: HOOK, DISCIPLE_FROM_BLOCK: "106431488", DISCIPLE_RPC_URL: "http://rh" } as any);
    expect(beside.stacks.length).toBeGreaterThan(0);
    expect(beside.disciple?.hook).toBe(HOOK);
    expect(beside.disciple?.rpcUrl).toBe("http://rh");
    expect(beside.stacks[0].hook).not.toBe(HOOK); // AscensionHook path is untouched
    // Known live RH hook defaults fromBlock when DISCIPLE_FROM_BLOCK is omitted (never 0).
    const known = loadConfig({ DISCIPLE_HOOK: HOOK, DISCIPLE_RPC_URL: "http://rh" } as any);
    expect(known.disciple?.fromBlock).toBe(106431488n);
    // Unknown hook without fromBlock stays off (would otherwise scan from genesis).
    expect(loadConfig({ DISCIPLE_HOOK: A(9), DISCIPLE_RPC_URL: "http://rh" } as any).disciple).toBeUndefined();
  });
});
