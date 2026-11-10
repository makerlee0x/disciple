# @disciple/hook-sdk

The read side of Disciple hook pools, for routers, aggregators and front ends: find pools, get exact quotes, measure depth, see which source pools move a quote, and compute turnover. It's built on viem. The integration guide is [contracts/docs/aggregator-integration.md](../contracts/docs/aggregator-integration.md).

```ts
import { createPublicClient, http } from "viem";
import { ROBINHOOD, poolsForPair, quoteExactIn, readPoolInfo, watchSet, minOut } from "@disciple/hook-sdk";

const c = createPublicClient({ transport: http(process.env.RH_RPC) });
const { hook, tokens } = ROBINHOOD;

const [{ id, key }] = await poolsForPair(c, hook, tokens.STRATEGY, tokens.USDG);
const info = await readPoolInfo(c, hook, id);              // fee, coin side, source legs
const q = await quoteExactIn(c, hook, id, false, 5_000_000n); // $5 USDG -> STRATEGY (zeroForOne = false)
const limit = minOut(q.amountOut, 50);                     // 0.5% slippage
const watch = watchSet(hook, info);                        // re-quote when these pools or the hook move
```

| Function | What it does |
|---|---|
| `poolsForPair`, `discipleKey`, `poolId` | Pool keys and ids from the hook's `poolsOf` counter, with no log scan |
| `readPoolInfo`, `watchSet` | Fee, live/local flags, coin side and source legs, read from storage (the hook has no getter for these) |
| `quoteExactIn`, `quoteExactOut`, `tryQuoteExactIn` | `quoteView`. The `try` form returns null on "can't fill" reverts |
| `maxFillIn`, `depthLadder` | Largest size that fills, and quotes at several sizes in one block |
| `minOut`, `maxIn` | Slippage limits, rounded against the trader |
| `decodeSwap`, `turnover` | `HookSwap` decoding and volume / pool value |

Building swap transactions is not in here yet. Integrators use their own v4 executor (see the guide). A Universal Router helper comes once its Robinhood deployment is checked.

```
npm ci
npm test                 # unit tests, no network
RH_RPC=https://... npm run live   # read-only check against the live pool
```

The storage offsets in `src/pools.ts` are for hook v0.2. `npm run live` prints `OK` when the source legs it reads match the known ones.
