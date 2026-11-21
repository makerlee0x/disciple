import "server-only";
/**
 * Pumped launch price flag (audit 2026-11-21, maker picked "Flag and keep off boards").
 *
 * The live launch pricer (SpotLaunchPricer) reads the pair coin's spot price inside the launch tx, so a launch can pump
 * the pair coin in the same tx (DiscipleRouter.launchWithUsdg swaps into it first) and bake a 5-10x wrong price into the
 * curve: a cheap graduation and inflated USD numbers for that coin forever. No contract money is at risk, so the fix is
 * here: compare the price the curve baked (curve.quotePriceUsd()) with the pair coin's spot (QuotePricer.spotPriceUsd)
 * at the block before the launch and at the launch block itself (after the tx, once any pump is unwound). A coin more
 * than MAX_OFF off BOTH is flagged and kept off every board and season-points tally (lib/server/home). The coin stays
 * listed and tradeable.
 *
 * A launch price never changes, so a verdict is cached in KV for good. A read that fails (old state the RPC no longer
 * serves) is "unknown", never flags, and is tried again after a day.
 */
import { parseAbi, type Address, type PublicClient } from "viem";
import { ACTIVE_CHAIN, deployment } from "../chains";
import { kv, type Kv } from "./kv";

/** More than this far from the market (both reference reads) ⇒ flagged. An honest First BOOST moves it ~6% at most. */
export const MAX_OFF = 0.1;

const curveAbi = parseAbi(["function quotePriceUsd() view returns (uint256)"]);
const pricerAbi = parseAbi(["function spotPriceUsd(address quote) view returns (uint256)"]);
const key = (token: string) => `launchprice:${ACTIVE_CHAIN.id}:${token.toLowerCase()}`;

export type Verdict = "ok" | "pumped" | "unknown";

/** Pure, tested: baked vs the market before and after the launch block (null = that read failed). */
export function judgeLaunchPrice(baked: bigint, before: bigint | null, after: bigint | null, maxOff = MAX_OFF): Verdict {
  const refs = [before, after].filter((x): x is bigint => x != null && x > BigInt(0));
  if (baked <= BigInt(0) || !refs.length) return "unknown";
  const off = (r: bigint) => Math.abs(Number((baked * BigInt(1_000_000)) / r) / 1_000_000 - 1);
  return refs.every((r) => off(r) > maxOff) ? "pumped" : "ok";
}

export type LaunchRef = { token: Address | string; curve: Address | string; quote: Address | string; block: bigint | number };

async function check(pc: PublicClient, c: LaunchRef): Promise<Verdict> {
  const dep = deployment();
  if (String(c.quote).toLowerCase() === dep.usdg.toLowerCase() || /^0x0{40}$/i.test(dep.quotePricer)) return "ok"; // USDG is $1
  const b = BigInt(c.block);
  const at = (blockNumber: bigint) => pc.readContract({ address: dep.quotePricer, abi: pricerAbi, functionName: "spotPriceUsd", args: [c.quote as Address], blockNumber }).catch(() => null);
  const [baked, before, after] = await Promise.all([
    pc.readContract({ address: c.curve as Address, abi: curveAbi, functionName: "quotePriceUsd" }).catch(() => null),
    b > BigInt(0) ? at(b - BigInt(1)) : Promise.resolve(null),
    at(b),
  ]);
  return baked == null ? "unknown" : judgeLaunchPrice(baked, before, after);
}

/**
 * Tokens (lowercase) whose launch price was pumped. Cached verdicts come from KV in one read; at most `budget` new coins
 * are checked per call (each is 3 reads), the rest wait for the next build.
 */
export async function pumpedLaunchSet(pc: PublicClient, launches: LaunchRef[], budget = 25, s: Kv = kv()): Promise<Set<string>> {
  const out = new Set<string>();
  if (!launches.length) return out;
  const raw = await s.mget(launches.map((c) => key(String(c.token)))).catch(() => launches.map(() => null));
  const todo: LaunchRef[] = [];
  launches.forEach((c, i) => {
    if (raw[i] === "pumped") out.add(String(c.token).toLowerCase());
    else if (raw[i] !== "ok" && raw[i] !== "unknown" && todo.length < budget) todo.push(c);
  });
  await Promise.all(todo.map(async (c) => {
    const v = await check(pc, c).catch((): Verdict => "unknown");
    if (v === "pumped") {
      out.add(String(c.token).toLowerCase());
      console.warn("[disciple] launch price off the market: kept off boards", { token: String(c.token), quote: String(c.quote), block: String(c.block) });
    }
    // a verdict is for good; "unknown" (state the RPC can't serve) is retried once a day
    if (v === "unknown") await s.setNX(key(String(c.token)), v, 86_400).catch(() => undefined);
    else await s.set(key(String(c.token)), v).catch(() => undefined);
  }));
  return out;
}

/** KV only (no chain reads): the cached "pumped" verdicts among `tokens`, for paths that must stay fast (XP scoring). */
export async function pumpedCached(tokens: readonly string[], s: Kv = kv()): Promise<Set<string>> {
  const list = [...new Set(tokens.map((t) => t.toLowerCase()))];
  const out = new Set<string>();
  if (!list.length) return out;
  const raw = await s.mget(list.map(key)).catch(() => list.map(() => null));
  list.forEach((t, i) => { if (raw[i] === "pumped") out.add(t); });
  return out;
}
