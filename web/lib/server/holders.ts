import "server-only";
/**
 * Holders index (Vercel-friendly, no watcher): per coin, ERC-20 Transfer logs (address-filtered ⇒ the RH RPC serves wide
 * ranges) folded into a balance map in KV with an incremental cursor. Each request catches up [cursor+1, latest] under a
 * time budget; a run lock stops concurrent lambdas from double-applying a range.
 * Keys: holders:bal:<coin> (JSON map addr → raw), holders:cur:<coin> (last applied block), holders:lock:<coin> (10s).
 * Starts at the v4 start block (deployment().fromBlock): the coin's mint is its first Transfer.
 */
import { parseAbiItem, type Address } from "viem";
import { bondingCurveAbi, launchpadAbi, marketLensAbi, tokenAbi } from "@/lib/abi";
import { deployment, hasLens, ZERO } from "@/lib/chains";
import { applyTransfers, rankHolders, type Holder, type HolderLabel } from "@/lib/holders";
import { serverPc } from "./chat/identity";
import { kv } from "./kv";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const CHUNK0 = BigInt(Math.max(1_000, Number(process.env.HOLDERS_CHUNK_BLOCKS) || 2_000_000));

async function catchUp(coin: Address, budgetMs: number): Promise<{ bal: Record<string, string>; asOfBlock: bigint }> {
  const s = kv(), pc = serverPc(), d = deployment();
  const bk = `holders:bal:${coin}`, ck = `holders:cur:${coin}`;
  const read = async () => {
    const [b, c] = await s.mget([bk, ck]);
    return { bal: (b ? JSON.parse(b) : {}) as Record<string, string>, cur: c ? BigInt(c) : d.fromBlock - BigInt(1) };
  };
  const latest = await pc.getBlockNumber();
  let { bal, cur } = await read();
  if (cur >= latest || !(await s.setNX(`holders:lock:${coin}`, "1", 10))) return { bal, asOfBlock: cur < latest ? cur : latest };
  try {
    ({ bal, cur } = await read()); // re-read under the lock
    const t0 = Date.now();
    let chunk = CHUNK0;
    while (cur < latest && Date.now() - t0 < budgetMs) {
      const from = cur + BigInt(1), to = from + chunk - BigInt(1) > latest ? latest : from + chunk - BigInt(1);
      let logs;
      try { logs = await pc.getLogs({ address: coin, event: TRANSFER, fromBlock: from, toBlock: to }); }
      catch (e) { if (chunk > BigInt(2_000)) { chunk = chunk / BigInt(8); continue; } throw e; }
      applyTransfers(bal, logs.map((l) => ({ from: l.args.from as string, to: l.args.to as string, value: l.args.value as bigint })));
      cur = to;
      await s.set(bk, JSON.stringify(bal));
      await s.set(ck, cur.toString());
    }
    return { bal, asOfBlock: cur };
  } finally { await s.del(`holders:lock:${coin}`).catch(() => {}); }
}

/** Throws "unknown coin" for tokens Launchpad doesn't know (no curve). */
export async function holdersOf(coin: Address, limit: number, budgetMs = 8_000): Promise<{ holders: Holder[]; asOfBlock: string }> {
  const pc = serverPc(), d = deployment();
  const c = coin.toLowerCase() as Address;
  const curve = String(await pc.readContract({ address: d.launchpad, abi: launchpadAbi, functionName: "curveOf", args: [c] }).catch(() => ZERO)).toLowerCase();
  if (curve === ZERO.toLowerCase()) throw new Error("unknown coin");
  const [{ bal, asOfBlock }, totalSupply, market] = await Promise.all([
    catchUp(c, budgetMs),
    pc.readContract({ address: c, abi: tokenAbi, functionName: "totalSupply" }) as Promise<bigint>,
    hasLens() ? pc.readContract({ address: d.marketLens, abi: marketLensAbi, functionName: "market", args: [c] }).then((m) => ({ mcapUsd: Number(m[1]) / 1e18 })).catch(() => null) : Promise.resolve(null),
  ]);
  let mcapUsd = market?.mcapUsd ?? null;
  if (mcapUsd == null) mcapUsd = await pc.readContract({ address: curve as Address, abi: bondingCurveAbi, functionName: "mcapNow" }).then((v) => Number(v as bigint) / 1e18).catch(() => null);
  const labels: Record<string, Exclude<HolderLabel, null>> = { [curve]: "curve" };
  if (d.poolManager !== ZERO) labels[d.poolManager.toLowerCase()] = "pool";
  if (d.hook !== ZERO) labels[d.hook.toLowerCase()] = "pool";
  if (d.lockedLP !== ZERO) labels[d.lockedLP.toLowerCase()] = "locker";
  return { holders: rankHolders(bal, { totalSupply, mcapUsd, labels, limit }), asOfBlock: asOfBlock.toString() };
}
