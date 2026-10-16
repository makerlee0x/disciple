# Tramps & Walls (graduated coins)

**Tramp** = single-sided *quote-token* v4 LP placed fully **below** the current price (support — a trampoline the rocket bounces off).
**Wall** = single-sided *coin* LP placed fully **above** the current price (resistance).

Tramps and walls are **one-sided limit orders, nothing more**. They earn **no swap-fee share and no yield**: the pool LP fee is 0 and the hook donates nothing to in-range liquidity. No minimum hold, no vesting, cancel any time. Each one is exactly **one tick spacing** wide (enforced on-chain). When price fully crosses it, any keeper can `pull(id)` it and receives a **0.1% tip** (`keeperTipBps = 10`) out of the filled proceeds; the rest goes to the owner. The only extras are off-chain points + badges for filled orders (achievements category `tramps` in `web/lib/achievements.ts`).

Only shown on graduated coins (`isGraduated(token) === true`).

## Frontend seam

The UI talks only to `TrampWallAdapter` (`web/lib/trampwalls/adapter.ts`). Today it's backed by `createMockAdapter` (`web/lib/trampwalls/mock.ts`, localStorage). FLOW ships a viem-backed implementation of the same interface (TrampWallManager + indexer) and we swap it in `components/trampwalls/TrampWallPanel.tsx`.

```ts
type TrampWallKind = "tramp" | "wall";
type TrampWallStatus = "active" | "filled" | "cancelled";

interface TrampWall {
  id: string;              // manager position id (uint256 as decimal string)
  token: Address; owner: Address; kind: TrampWallKind;
  mcapUsd: number;         // center, as market cap USD (UI/engine works in mcap space)
  mcapLoUsd: number; mcapHiUsd: number;
  tickLower?: number; tickUpper?: number;
  amount: bigint;          // quote wei (tramp) | token wei (wall)
  sizeUsd: number;         // USD notional at placement (line thickness)
  status: TrampWallStatus;
  filledFrac: number;      // 0..1 of range converted
  feesEarnedUsd: number;   // legacy field, always 0 (no yield; kept for adapter compatibility)
  pointsEarned: number;
  createdAt: number; filledAt?: number;   // ms epoch
}

interface PlaceTrampWallParams {
  token: Address; kind: TrampWallKind;
  mcapUsd: number;         // target center (adapter converts to ticks, aligned to tickSpacing)
  rangeWidthPct?: number;  // ignored on-chain: a band is always exactly one tick spacing
  amount: bigint; sizeUsd: number;
}

interface TrampWallPreview {
  distancePct: number; mcapLoUsd: number; mcapHiUsd: number;
  estFeeShareUsdPerDay: number; estSharePct: number; // legacy, always 0 (no fee share)
  pointsIfFilled: number;
  valid: boolean; reason?: string;
}

type TrampWallEvent =
  | { type: "Placed"; tw: TrampWall }
  | { type: "Cancelled"; id: string; token: Address }
  | { type: "Filled"; id: string; token: Address; filledAt: number; pointsEarned: number }
  | { type: "FeesDonated"; id: string; token: Address; amountUsd: number }; // legacy, never emitted (no donations)

interface TrampWallAdapter {
  isGraduated(token: Address): Promise<boolean>;
  list(token: Address): Promise<TrampWall[]>;                     // active + recently filled, all owners
  listMine(owner: Address, token?: Address): Promise<TrampWall[]>;
  preview(p: PlaceTrampWallParams, currentMcapUsd: number): Promise<TrampWallPreview>;
  place(p: PlaceTrampWallParams): Promise<{ ok: boolean; id?: string; txHash?: string; reason?: string }>;
  cancel(id: string): Promise<{ ok: boolean; txHash?: string; reason?: string }>;
  onEvent(token: Address, cb: (e: TrampWallEvent) => void): () => void;
}
```

## Contract (TrampWallManager, shipped)

- `placeTramp(token, tickLower, tickUpper, quoteAmt, minLiquidity, deadline)` / `placeWall(token, tickLower, tickUpper, tokenAmt, minLiquidity, deadline)`: graduated pools only, strictly single-sided (tramp below price, wall above), and `tickUpper - tickLower == tickSpacing`.
- `cancel(id)`: owner only, any time (no hold, no vesting). Returns the remaining principal plus any filled proceeds. There are no fees to claim.
- `pull(id)`: anyone (keeper), once `isFilled(id)`. The keeper gets the 0.1% tip and the owner gets the rest.
- Events: `TrampPlaced` / `WallPlaced`, `Cancelled` (`quoteFees` / `tokenFees` are always 0), `Filled`, `KeeperTipPaid`. Off-chain points are awarded on `Filled`.

Indexer also needs a per-user rollup for achievements: `trampsFilled`, `wallsFilled`, `bigTrampsFilled` (≥$1K) → `IdentityMetrics` in `web/lib/stats.ts`.

## Chart

`web/public/flight/engine.js` reads `window.__trampWalls` (`{id, kind, mcap, lo, hi, sizeUsd, mine, status}`) and `window.__twPreview` (the modal's preview). It draws only real/mock positions, not order-book levels, and no heatmap.
- Each position is one small element. A tramp is a little sprung trampoline arc below price; a wall is a small dome-topped stone slab above price. Width and thickness scale with log10(sizeUsd), clamped (about 28–150 px wide, 1.5–6 px thick), so a $10 tramp is tiny and a $10K wall is big.
- Each element has a compact $ tag ($40, $1.2K, `×n` when merged). Your own are gold/red and bold.
- At most 8 elements are shown, the ones nearest the price. Same-kind positions at the same level (within about 14 px) merge into one.
- Fill animations are subtle: a small damped bounce on a tramp, a few crack chips on a wall. The engine dispatches a `twfilled` event.
- Nothing is drawn over the rocket (keep-out mask, and elements slide aside). No camera shake; heading rules unchanged (−15..88°, no spin). `__flight.screenYToMcap(y)` powers drag-to-place.

Mock: add `?graduated=1` to force the panel on any coin and `?tw=open` to open the modal.
