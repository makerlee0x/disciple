import "server-only";
/** Live data for the link preview cards (lib/server/og/card.ts). Short in-memory cache; any read that fails is left out. */
import { parseAbi, type Address } from "viem";
import { getHomeData } from "@/lib/server/home";
import { usernameOf, walletOf } from "@/lib/server/usernames";
import { coinIconBuffer } from "@/lib/server/share/coinIcon";
import { serverPc } from "@/lib/server/chat/identity";
import { xpSummary } from "@/lib/server/xp";
import { unlocksOf } from "@/lib/server/achievements";
import { looksOf } from "@/lib/server/looks";
import { USERNAME_STORED_RE } from "@/lib/profile";

const TTL = 60_000;
const memo = new Map<string, { at: number; v: Promise<unknown> }>();
function cached<T>(key: string, f: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.v as Promise<T>;
  const v = f().catch((e) => { memo.delete(key); throw e; });
  memo.set(key, { at: Date.now(), v });
  if (memo.size > 500) memo.delete(memo.keys().next().value as string);
  return v;
}
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const erc20 = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)"]);

export type RocketInfo = { ticker: string; name: string; host: string | null; mcapUsd: number | null; orbitPct: number | null; graduated: boolean; aboard: number | null };

/** null = not a rocket we can read (bad address, or the chain has no token there). */
export function rocketInfo(addr: string): Promise<RocketInfo | null> {
  if (!isAddr(addr)) return Promise.resolve(null);
  const a = addr.toLowerCase();
  return cached(`r:${a}`, async () => {
    const home = await getHomeData(3_000).catch(() => null);
    const c = home?.coins.find((x) => x.token.toLowerCase() === a);
    if (c) {
      const host = c.creatorAddr ? await usernameOf(c.creatorAddr).catch(() => null) : null;
      return {
        ticker: c.ticker, name: c.name, host, mcapUsd: c.mcapUsd ?? null, graduated: c.graduated,
        orbitPct: c.graduated ? 100 : c.progressBps != null ? Math.max(0, Math.min(100, c.progressBps / 100)) : null,
        aboard: c.stats?.crew || null,
      };
    }
    const pc = serverPc();
    const [sym, nm] = await Promise.all([
      pc.readContract({ address: a as Address, abi: erc20, functionName: "symbol" }).catch(() => null),
      pc.readContract({ address: a as Address, abi: erc20, functionName: "name" }).catch(() => null),
    ]);
    if (!sym) return null;
    return { ticker: String(sym).slice(0, 12), name: String(nm || sym).slice(0, 40), host: null, mcapUsd: null, orbitPct: null, graduated: false, aboard: null };
  });
}
export const rocketIcon = (addr: string) => (isAddr(addr) ? cached(`i:${addr.toLowerCase()}`, () => coinIconBuffer(addr)) : Promise.resolve(null));

export type PilotInfo = { handle: string; level: number | null; trophies: number | null; hull: string | null };

export function pilotInfo(raw: string): Promise<PilotInfo | null> {
  const u = raw.trim().toLowerCase().replace(/^@/, "");
  if (!USERNAME_STORED_RE.test(u)) return Promise.resolve(null);
  return cached(`p:${u}`, async () => {
    const w = await walletOf(u).catch(() => null);
    if (!w) return null;
    const [xp, un, lk] = await Promise.all([
      xpSummary(w).catch(() => null),
      unlocksOf(w).catch(() => null),
      looksOf([w]).catch(() => null),
    ]);
    return { handle: u, level: xp?.level.level ?? null, trophies: un ? un.length : null, hull: lk?.[w.toLowerCase()]?.hull ?? lk?.[w]?.hull ?? null };
  });
}

/** The name on an invite card: a /r/<name> username that exists, else null (codes stay anonymous). */
export async function inviterName(raw: string | null): Promise<string | null> {
  if (!raw) return null;
  const u = raw.trim().toLowerCase().replace(/^@/, "");
  if (/^0x[0-9a-f]{40}$/.test(u)) return usernameOf(u).catch(() => null);
  if (!USERNAME_STORED_RE.test(u)) return null;
  return (await walletOf(u).catch(() => null)) ? u : null;
}
