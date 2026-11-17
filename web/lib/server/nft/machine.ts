import "server-only";
/** The live Candy Machine id (set from /admin/mint once maker has created it), and a cached minted count for /mint. */
import { kv } from "../kv";
import { mintedItems } from "./chain";
import { isSolAddress } from "@/lib/nft/config";

const CM_KEY = "nft:cm";
export type LiveMachine = { candyMachine: string; lut: string | null };
/** The machine /mint mints from (+ its lookup table), or null when the mint is off. */
export async function liveMachine(): Promise<LiveMachine | null> {
  const env = process.env.NEXT_PUBLIC_DISCIPLE_CANDY_MACHINE?.trim();
  const envLut = process.env.NEXT_PUBLIC_DISCIPLE_CANDY_LUT?.trim();
  if (env && isSolAddress(env)) return { candyMachine: env, lut: envLut && isSolAddress(envLut) ? envLut : null };
  const v = await kv().get(CM_KEY).catch(() => null);
  if (!v) return null;
  try {
    const j = JSON.parse(v) as Partial<LiveMachine>;
    return isSolAddress(j.candyMachine) ? { candyMachine: j.candyMachine, lut: isSolAddress(j.lut) ? j.lut : null } : null;
  } catch { return null; }
}
export const candyMachineId = async () => (await liveMachine())?.candyMachine ?? null;
export async function setLiveMachine(m: LiveMachine | null): Promise<void> {
  if (m) await kv().set(CM_KEY, JSON.stringify(m)); else await kv().del(CM_KEY);
}

let cache: { at: number; count: number } | null = null;
/** Disciples minted so far (all of them, LaunchMyNFT's and ours). null = couldn't check. 30 s cache. */
export async function mintedCount(): Promise<number | null> {
  if (cache && Date.now() - cache.at < 30_000) return cache.count;
  const m = await mintedItems();
  if (!m) return cache?.count ?? null;
  cache = { at: Date.now(), count: m.count };
  return m.count;
}
