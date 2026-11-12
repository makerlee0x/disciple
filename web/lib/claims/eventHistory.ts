/** Lossless event history on RPCs with a 100,000-block inclusive range limit. Pin latest once per scan. */
export const EVENT_HISTORY_CHUNK = BigInt(100_000);
export async function scanEventHistory<T>(pc: { getBlockNumber(): Promise<bigint> }, read: (from: bigint, to: bigint) => Promise<T[]>, from: bigint, to?: bigint): Promise<T[]> {
  const head = to ?? await pc.getBlockNumber(), out: T[] = [];
  if (from < BigInt(0)) throw new RangeError("negative history start");
  for (let lo = from; lo <= head; lo += EVENT_HISTORY_CHUNK) {
    const end = lo + EVENT_HISTORY_CHUNK - BigInt(1), hi = end < head ? end : head;
    out.push(...await read(lo, hi)); // fail the whole scan; never silently return partial reward totals
  }
  return out;
}
