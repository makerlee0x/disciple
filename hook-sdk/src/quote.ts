// Exact quotes from quoteView. A quote is exact for a swap landing against the same state: the same block (the
// centre steps at most once per block toward the source) and the same source pools (the live cap reads them in
// the swap). Re-quote when either moves; see watchSet() in index.ts.
import { BaseError, ContractFunctionRevertedError, type Hex, type PublicClient } from "viem";
import { discipleHookAbi } from "./abi.ts";

export interface Quote {
  amountIn: bigint;
  amountOut: bigint;
}

export interface QuoteOpts {
  blockNumber?: bigint;
}

/** Revert reasons a router should treat as "no quote" (the pool can't fill this size or isn't live). */
export const NO_FILL = ["UnknownPool", "NotLive", "NoAnchor", "BadParams", "ZeroOutput", "TradeTooLarge", "InsufficientReserve"];

/** The hook's custom error name, or undefined if the failure was not a hook revert (RPC error, etc). */
export function revertName(e: unknown): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? r.data?.errorName : undefined;
}

async function view(c: PublicClient, hook: Hex, id: Hex, zeroForOne: boolean, amountSpecified: bigint, o: QuoteOpts) {
  const [amountIn, amountOut] = await c.readContract({
    address: hook,
    abi: discipleHookAbi,
    functionName: "quoteView",
    args: [id, zeroForOne, amountSpecified],
    blockNumber: o.blockNumber,
  });
  return { amountIn, amountOut };
}

/** Exact input: spend `amountIn` of the input side (currency0 if zeroForOne). v4 sign: negative = exact in. */
export const quoteExactIn = (c: PublicClient, hook: Hex, id: Hex, zeroForOne: boolean, amountIn: bigint, o: QuoteOpts = {}) =>
  view(c, hook, id, zeroForOne, -amountIn, o);

/** Exact output: receive `amountOut` of the output side. */
export const quoteExactOut = (c: PublicClient, hook: Hex, id: Hex, zeroForOne: boolean, amountOut: bigint, o: QuoteOpts = {}) =>
  view(c, hook, id, zeroForOne, amountOut, o);

/** Like quoteExactIn, but null when the pool can't fill (any NO_FILL revert). Other errors still throw. */
export async function tryQuoteExactIn(
  c: PublicClient,
  hook: Hex,
  id: Hex,
  zeroForOne: boolean,
  amountIn: bigint,
  o: QuoteOpts = {},
): Promise<Quote | null> {
  try {
    return await quoteExactIn(c, hook, id, zeroForOne, amountIn, o);
  } catch (e) {
    if (NO_FILL.includes(revertName(e) ?? "")) return null;
    throw e;
  }
}

/** Minimum output after a slippage allowance in basis points (rounded down). */
export const minOut = (amountOut: bigint, slippageBps: number): bigint =>
  (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;

/** Maximum input after a slippage allowance in basis points (rounded up). */
export const maxIn = (amountIn: bigint, slippageBps: number): bigint =>
  (amountIn * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;

/**
 * Largest exact-input size the pool fills, by binary search on quoteView (about 2 * log2(hi/lo) calls; pin
 * `blockNumber` so every call sees the same state). Returns 0n if even `lo` doesn't fill.
 */
export async function maxFillIn(
  c: PublicClient,
  hook: Hex,
  id: Hex,
  zeroForOne: boolean,
  lo: bigint,
  hi: bigint,
  o: QuoteOpts = {},
  steps = 40,
): Promise<bigint> {
  const fills = async (a: bigint) => (await tryQuoteExactIn(c, hook, id, zeroForOne, a, o)) !== null;
  if (!(await fills(lo))) return 0n;
  while (await fills(hi)) {
    lo = hi;
    hi *= 2n;
    if (--steps <= 0) return lo;
  }
  for (let i = 0; i < steps && hi - lo > lo / 1000n + 1n; i++) {
    const mid = (lo + hi) / 2n;
    if (await fills(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Quotes at several exact-input sizes (null where the pool can't fill), all against one block. */
export async function depthLadder(
  c: PublicClient,
  hook: Hex,
  id: Hex,
  zeroForOne: boolean,
  sizes: bigint[],
  o: QuoteOpts = {},
): Promise<{ amountIn: bigint; quote: Quote | null }[]> {
  const blockNumber = o.blockNumber ?? (await c.getBlockNumber({ cacheTime: 0 }));
  return Promise.all(
    sizes.map(async (amountIn) => ({ amountIn, quote: await tryQuoteExactIn(c, hook, id, zeroForOne, amountIn, { blockNumber }) })),
  );
}
