import "server-only";
/**
 * Coin stats for the coin page strip (lib/coinStats): live mcap / price (lib/mcap), 24H volume + change from the indexed
 * fills (lib/server/trades), holders = every non-protocol wallet with a balance (lib/server/holders), liquidity = $ in the
 * curve (pre-grad) or in the coin's locked v4 position + floor bands (post-grad), valued at the launch quote price like the
 * mcap. Each part fails soft (null) so one bad read never blanks the strip. Cached per instance for a few seconds (and
 * shared-cached by the route), never in KV (Upstash budget).
 */
import type { Address, PublicClient } from "viem";
import { bondingCurveAbi, launchpadAbi, lockedLPAbi } from "@/lib/abi";
import { deployment, ZERO } from "@/lib/chains";
import { dayWindow, positionAmounts, type CoinStats } from "@/lib/coinStats";
import { coinBasis, readCoinMcap } from "@/lib/mcap";
import { tokenIsCurrency0 } from "@/lib/trades";
import { serverPc } from "./chat/identity";
import { holdersOf } from "./holders";
import { tradesOf } from "./trades";

const TTL_MS = 8_000;
const memo = new Map<string, { at: number; p: Promise<CoinStats> }>();

async function liquidityUsd(pc: PublicClient, token: Address, curve: Address, graduated: boolean, priceWad: bigint, priceUsd: number): Promise<number | null> {
  const b = await coinBasis(pc, token, curve);
  const q$ = (raw: number) => (raw * Number(b.launchQuoteUsd)) / 1e36, t$ = (raw: number) => (raw / 1e18) * priceUsd;
  if (!graduated) {
    const r = (await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quoteReserve" })) as bigint;
    return q$(Number(r));
  }
  const lp = deployment().lockedLP;
  if (!lp || lp === ZERO) return null;
  const [pos, ticks, bands] = await Promise.all([
    pc.readContract({ address: lp, abi: lockedLPAbi, functionName: "positions", args: [token] }) as Promise<readonly unknown[]>,
    pc.readContract({ address: lp, abi: lockedLPAbi, functionName: "positionTicks", args: [token] }) as Promise<readonly unknown[]>,
    (pc.readContract({ address: lp, abi: lockedLPAbi, functionName: "floorBands", args: [token] }) as Promise<readonly { quoteAmount: bigint; tokenAmount: bigint }[]>).catch(() => []),
  ]);
  const L = Number(pos[6] as bigint), c0 = tokenIsCurrency0(token, b.quote);
  const p = Number(priceWad) / 1e18;   // quote raw per token raw
  const sp = Math.sqrt(c0 ? p : p > 0 ? 1 / p : 0);
  const { a0, a1 } = positionAmounts(L, Number(ticks[0]), Number(ticks[1]), sp);
  let usd = c0 ? t$(a0) + q$(a1) : q$(a0) + t$(a1);
  for (const f of bands) usd += q$(Number(f.quoteAmount)) + t$(Number(f.tokenAmount));
  return usd;
}

async function read(c: Address): Promise<CoinStats> {
  const pc = serverPc() as unknown as PublicClient;
  const curve = (await pc.readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "curveOf", args: [c] })) as Address;
  if (!curve || curve === ZERO) throw new Error("unknown coin");
  const now = Date.now();
  const [mk, fills, holders] = await Promise.all([
    readCoinMcap(pc, c, curve).catch(() => null),
    tradesOf(c, null, 5000, "desc").catch(() => []),
    holdersOf(c, 1e9).then((r) => r.holders.filter((h) => h.kind === "holder").length).catch(() => null),
  ]);
  const day = dayWindow(fills, now, mk?.mcapUsd);
  const liq = mk ? await liquidityUsd(pc, c, curve, mk.graduated, mk.priceWad, mk.priceUsd).catch((e) => { console.warn("[coinstats] liquidity", (e as Error).message); return null; }) : null;
  return { coin: c, mcapUsd: mk?.mcapUsd ?? null, priceUsd: mk?.priceUsd ?? null, ...day, liquidityUsd: liq, holders, at: now };
}

export function coinStats(coin: Address): Promise<CoinStats> {
  const c = coin.toLowerCase() as Address, hit = memo.get(c);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;
  const p = read(c);
  memo.set(c, { at: Date.now(), p });
  p.catch(() => memo.delete(c));
  if (memo.size > 500) memo.delete(memo.keys().next().value as string);
  return p;
}
