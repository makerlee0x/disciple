import "server-only";
/**
 * Live DiscipleHook TVL on Robinhood Chain 4663. poolState is the per-pool reserve.
 * PoolManager.balanceOf(hook, currency id) is the hook's ERC-6909 claim (all pools of that token).
 */
import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { DISCIPLE_HOOK, DISCIPLE_POOL, DISCIPLE_POOL_MANAGER, DISCIPLE_RPC, isDisciplePoolId } from "@/lib/disciple/catalog";
import { reservesFromPoolState, tvlFromPoolState } from "@/lib/disciple/tvl";

const READS = [
  {
    type: "function", name: "poolState", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "coin", type: "address" }, { name: "quote", type: "address" },
      { name: "live", type: "bool" }, { name: "local", type: "bool" },
      { name: "graduated", type: "bool" }, { name: "creatorOn", type: "bool" },
      { name: "coinReserve", type: "uint256" }, { name: "quoteReserve", type: "uint256" },
      { name: "anchorX128", type: "uint256" }, { name: "ageOrBlock", type: "uint256" },
      { name: "tank", type: "uint256" }, { name: "srcTvl", type: "uint256" },
      { name: "principal", type: "uint256" }, { name: "compounded", type: "uint256" },
      { name: "lots", type: "uint256" },
    ],
  },
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "id", type: "uint256" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

let pc: PublicClient | null = null;
function client(): PublicClient {
  return pc ??= createPublicClient({ transport: http(process.env.DISCIPLE_RPC_URL || process.env.NEXT_PUBLIC_RH_RPC_URL || DISCIPLE_RPC) });
}

export type DiscipleTvlJson = {
  source: "poolState";
  poolId: string;
  hook: string;
  coin: string;
  quote: string;
  live: boolean;
  coinReserve: string;
  quoteReserve: string;
  anchorX128: string;
  tvlQuoteRaw: string;
  liquidityUsd: number | null;
  claims: { coin: string; quote: string; matchReserves: boolean } | null;
};

/** null when `poolId` is not the live DiscipleHook pool (AscensionHook pool ids are not read here). */
export async function readDiscipleTvl(poolId: string): Promise<DiscipleTvlJson | null> {
  if (!isDisciplePoolId(poolId)) return null;
  const id = poolId.toLowerCase() as Hex;
  const raw = await client().readContract({
    address: DISCIPLE_HOOK, abi: READS, functionName: "poolState", args: [id],
  });
  const view = reservesFromPoolState(raw);
  const { coinReserve, quoteReserve, anchorX128 } = view;
  let claims: DiscipleTvlJson["claims"] = null;
  try {
    const [coinBal, quoteBal] = await Promise.all([
      client().readContract({ address: DISCIPLE_POOL_MANAGER, abi: READS, functionName: "balanceOf", args: [DISCIPLE_HOOK, BigInt(view.coin)] }),
      client().readContract({ address: DISCIPLE_POOL_MANAGER, abi: READS, functionName: "balanceOf", args: [DISCIPLE_HOOK, BigInt(view.quote)] }),
    ]);
    claims = {
      coin: coinBal.toString(), quote: quoteBal.toString(),
      matchReserves: coinBal === coinReserve && quoteBal === quoteReserve,
    };
  } catch { /* poolState still stands */ }
  const tvl = tvlFromPoolState({ coinReserve, quoteReserve, anchorX128, quoteUsdWad: DISCIPLE_POOL.quotePriceUsdWad });
  return {
    source: "poolState", poolId: DISCIPLE_POOL.id, hook: DISCIPLE_HOOK,
    coin: String(view.coin).toLowerCase(), quote: String(view.quote).toLowerCase(), live: Boolean(view.live),
    coinReserve: coinReserve.toString(), quoteReserve: quoteReserve.toString(), anchorX128: anchorX128.toString(),
    tvlQuoteRaw: tvl.tvlQuoteRaw.toString(), liquidityUsd: tvl.liquidityUsd, claims,
  };
}
