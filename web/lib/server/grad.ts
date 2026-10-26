import "server-only";
/**
 * A coin's graduation state from chain (lib/protocol GradState), for GET /api/coin/grad → the engine payload.
 * graduated = BondingCurve.graduated(); poolId / graduatedAt from the curve's GraduatedToV4 log (+ its block timestamp).
 * Once graduated it can never change ⇒ cached forever in KV `grad:<coin>` (and in memory). Not-yet-graduated answers are
 * not cached (the route sends a short s-maxage instead).
 */
import type { Address } from "viem";
import { bondingCurveAbi, launchpadAbi } from "@/lib/abi";
import { deployment, ZERO } from "@/lib/chains";
import { parseGrad } from "@/lib/grad";
import { NOT_GRADUATED, type GradState } from "@/lib/protocol";
import { serverPc } from "./chat/identity";
import { kv } from "./kv";

const mem = new Map<string, GradState>();
const CHUNK = BigInt(2_000_000);

/** Throws "unknown coin" for tokens Launchpad doesn't know. */
export async function gradInfo(coin: Address): Promise<GradState> {
  const c = coin.toLowerCase();
  const hit = mem.get(c);
  if (hit) return hit;
  const cached = parseGrad(await kv().get(`grad:${c}`).then((v) => (v ? JSON.parse(v) : null)).catch(() => null));
  if (cached?.graduated && cached.poolId && cached.graduatedAt) { mem.set(c, cached); return cached; }

  const pc = serverPc(), d = deployment();
  const curve = String(await pc.readContract({ address: d.launchpad, abi: launchpadAbi, functionName: "curveOf", args: [c as Address] }).catch(() => ZERO)).toLowerCase() as Address;
  if (curve === ZERO.toLowerCase()) throw new Error("unknown coin");
  const graduated = Boolean(await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "graduated" }));
  if (!graduated) return { ...NOT_GRADUATED };

  const g: GradState = { graduated: true, poolId: cached?.poolId ?? null, graduatedAt: cached?.graduatedAt ?? null };
  try {
    const latest = await pc.getBlockNumber();
    type GL = { args: { poolId?: `0x${string}` }; blockNumber: bigint | null };
    const read = (from: bigint, to: bigint) => pc.getContractEvents({ address: curve, abi: bondingCurveAbi, eventName: "GraduatedToV4", fromBlock: from, toBlock: to }) as unknown as Promise<GL[]>;
    let logs: GL[] = [];
    try { logs = await read(d.fromBlock, latest); }
    catch { // node refused the wide range: walk back from the tip (graduation is usually recent)
      for (let to = latest; to >= d.fromBlock && !logs.length; to -= CHUNK) logs = await read(to - CHUNK + BigInt(1) > d.fromBlock ? to - CHUNK + BigInt(1) : d.fromBlock, to);
    }
    const l = logs[0];
    if (l) {
      g.poolId = (l.args.poolId?.toLowerCase() as `0x${string}`) ?? null;
      if (l.blockNumber != null) g.graduatedAt = Number((await pc.getBlock({ blockNumber: l.blockNumber })).timestamp);
    }
  } catch (e) { console.warn("[grad] GraduatedToV4 lookup failed", (e as Error).message); }
  if (g.poolId && g.graduatedAt) { mem.set(c, g); await kv().set(`grad:${c}`, JSON.stringify(g)).catch(() => {}); }
  return g;
}
