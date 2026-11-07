/**
 * DiscipleHook adapter. AscensionHook still uses Trade + StateView.getSlot0/getLiquidity (src/api.ts).
 * This path indexes Created / Swapped / Deposited / Withdrawn and reads TVL from poolState
 * (and the hook's ERC-6909 claims on PoolManager). slot0 and getLiquidity are not reserves:
 * the hook initializes price 1 and refuses v4 liquidity; inventory is ERC-6909 claims.
 */
import { decodeEventLog, encodeAbiParameters, getAddress, keccak256, parseAbi, type Address, type Hex } from "viem";
import { bumpDataVersion, type DB } from "./db.js";
import type { RawLog } from "./ingest.js";

export const DISCIPLE_STACK = "disciple";
export const Q128 = 1n << 128n;

export const DISCIPLE_EVENTS = parseAbi([
  "event Created(bytes32 indexed id, address indexed coin, address quote, address indexed creator, uint32 remoteEid, uint24 fee)",
  "event Swapped(bytes32 indexed id, address indexed sender, bool buy, uint256 coinAmt, uint256 quoteAmt)",
  "event Deposited(bytes32 indexed id, address indexed owner, uint256 lot, uint256 shares, uint256 x, uint256 y)",
  "event Withdrawn(bytes32 indexed id, address indexed owner, uint256 lot, uint256 x, uint256 y)",
]);

export const DISCIPLE_READS = parseAbi([
  "function poolState(bytes32 id) view returns (address coin, address quote, bool live, bool local, bool graduated, bool creatorOn, uint256 coinReserve, uint256 quoteReserve, uint256 anchorX128, uint256 ageOrBlock, uint256 tank, uint256 srcTvl, uint256 principal, uint256 compounded, uint256 lots)",
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
]);

const lc = (a: string) => a.toLowerCase();
const s = (x: unknown) => (typeof x === "bigint" ? x.toString() : String(x));

/** v4 pool id. fee is the PoolKey fee (0 on DiscipleHook), not the hook's pips fee. */
export function poolKeyId(currency0: Address, currency1: Address, fee: number, tickSpacing: number, hooks: Address): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [getAddress(currency0), getAddress(currency1), fee, tickSpacing, getAddress(hooks)],
  ));
}

export type PoolView = {
  coin: Address; quote: Address; live: boolean;
  coinReserve: bigint; quoteReserve: bigint; anchorX128: bigint;
};

/** Accept viem's tuple (array or named object). */
export function asPoolView(v: any): PoolView {
  const coin = (v.coin ?? v[0]) as Address;
  const quote = (v.quote ?? v[1]) as Address;
  const live = Boolean(v.live ?? v[2]);
  const coinReserve = BigInt(v.coinReserve ?? v[6]);
  const quoteReserve = BigInt(v.quoteReserve ?? v[7]);
  const anchorX128 = BigInt(v.anchorX128 ?? v[8]);
  return { coin, quote, live, coinReserve, quoteReserve, anchorX128 };
}

/**
 * Quote-raw TVL from poolState only. Coin side is marked at anchorX128 (quote raw per coin raw).
 * With no anchor yet, both sides are marked at the reserve ratio (2 × quote reserve).
 */
export function tvlQuoteRaw(coinReserve: bigint, quoteReserve: bigint, anchorX128: bigint): bigint {
  if (anchorX128 > 0n) return quoteReserve + (coinReserve * anchorX128) / Q128;
  if (coinReserve > 0n) return quoteReserve * 2n;
  return quoteReserve;
}

/** USD from quote raw. quoteUsdWad = USD WAD per 1e18 raw quote (USDG $1 at 6 decimals → 1e30). null when unknown. */
export function quoteRawToUsd(raw: bigint, quoteUsdWad: bigint | null | undefined): number | null {
  if (quoteUsdWad == null || quoteUsdWad <= 0n) return null;
  return Number((raw * quoteUsdWad) / 10n ** 18n) / 1e18;
}

export type DiscipleTvl = {
  source: "poolState";
  coin: string; quote: string; live: boolean;
  coinReserve: string; quoteReserve: string; anchorX128: string;
  tvlQuoteRaw: string;
  liquidityUsd: number | null;
  /** Hook-wide ERC-6909 claims (sum across pools of this hook). matchReserves is per-pool only when this hook's claims equal this pool. */
  claims: { coin: string; quote: string; matchReserves: boolean } | null;
};

type Reader = { readContract(args: any): Promise<any> };

/** Live reserves. Never calls getSlot0 / getLiquidity. */
export async function readDiscipleTvl(
  client: Reader, hook: Address, poolManager: Address, poolId: Hex, quoteUsdWad?: bigint | null,
): Promise<DiscipleTvl> {
  const view = asPoolView(await client.readContract({
    address: hook, abi: DISCIPLE_READS, functionName: "poolState", args: [poolId],
  }));
  const idOf = (token: string) => BigInt(token);
  let claims: DiscipleTvl["claims"] = null;
  try {
    const [coinBal, quoteBal] = await Promise.all([
      client.readContract({ address: poolManager, abi: DISCIPLE_READS, functionName: "balanceOf", args: [hook, idOf(view.coin)] }) as Promise<bigint>,
      client.readContract({ address: poolManager, abi: DISCIPLE_READS, functionName: "balanceOf", args: [hook, idOf(view.quote)] }) as Promise<bigint>,
    ]);
    claims = {
      coin: coinBal.toString(), quote: quoteBal.toString(),
      matchReserves: coinBal === view.coinReserve && quoteBal === view.quoteReserve,
    };
  } catch { /* claims are a cross-check; poolState is the per-pool figure */ }
  const tvl = tvlQuoteRaw(view.coinReserve, view.quoteReserve, view.anchorX128);
  return {
    source: "poolState",
    coin: lc(view.coin), quote: lc(view.quote), live: view.live,
    coinReserve: view.coinReserve.toString(), quoteReserve: view.quoteReserve.toString(), anchorX128: view.anchorX128.toString(),
    tvlQuoteRaw: tvl.toString(),
    liquidityUsd: quoteRawToUsd(tvl, quoteUsdWad),
    claims,
  };
}

/** Mcap (USD, float) from poolState anchor × supply × quote price. Not slot0. */
export function mcapUsdFromAnchor(supplyRaw: bigint, anchorX128: bigint, quoteUsdWad: bigint): number {
  if (supplyRaw <= 0n || anchorX128 <= 0n || quoteUsdWad <= 0n) return 0;
  const mcapQuote = (supplyRaw * anchorX128) / Q128;
  return quoteRawToUsd(mcapQuote, quoteUsdWad) ?? 0;
}

/** Apply DiscipleHook logs. Logs from any other address are ignored. Idempotent. */
export function applyDiscipleLogs(db: DB, hook: string, logs: RawLog[], tsOf: (b: bigint) => number) {
  const want = lc(hook);
  const tx = db.transaction(() => {
    for (const l of logs) {
      if (lc(l.address) !== want) continue;
      let ev: { eventName: string; args: any };
      try {
        ev = decodeEventLog({ abi: DISCIPLE_EVENTS, data: l.data, topics: l.topics as any, strict: true }) as any;
      } catch { continue; }
      const a = ev.args;
      const block = Number(l.blockNumber);
      const ts = tsOf(l.blockNumber!);
      const id = `${l.transactionHash}:${l.logIndex}`;
      const pool = lc(a.id as string);
      switch (ev.eventName) {
        case "Created": {
          const coin = lc(a.coin), quote = lc(a.quote);
          const c0 = coin < quote ? coin : quote;
          const c1 = coin < quote ? quote : coin;
          const n = (db.prepare("SELECT COUNT(*) n FROM disciple_pools WHERE currency0=? AND currency1=?").get(c0, c1) as any).n as number;
          db.prepare(
            `INSERT OR IGNORE INTO disciple_pools
             (id, hook, coin, quote, currency0, currency1, creator, remote_eid, hook_fee, v4_fee, tick_spacing, created_block, created_at, created_tx)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(pool, want, coin, quote, c0, c1, lc(a.creator), Number(a.remoteEid), Number(a.fee), 0, n + 1, block, ts, l.transactionHash);
          break;
        }
        case "Swapped":
          db.prepare(
            `INSERT OR IGNORE INTO disciple_swaps (id, pool_id, sender, is_buy, coin_amt, quote_amt, block, ts, tx) VALUES (?,?,?,?,?,?,?,?,?)`,
          ).run(id, pool, lc(a.sender), a.buy ? 1 : 0, s(a.coinAmt), s(a.quoteAmt), block, ts, l.transactionHash);
          break;
        case "Deposited":
        case "Withdrawn":
          db.prepare(
            `INSERT OR IGNORE INTO disciple_liquidity (id, pool_id, kind, owner, lot, shares, coin_amt, quote_amt, block, ts, tx) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(id, pool, ev.eventName === "Deposited" ? "deposited" : "withdrawn", lc(a.owner), s(a.lot),
            a.shares !== undefined ? s(a.shares) : null, s(a.x), s(a.y), block, ts, l.transactionHash);
          break;
      }
    }
  });
  tx();
  bumpDataVersion(db);
}
