# DISCIPLE FLOW indexer + REST API

This is a lightweight indexer built on viem, SQLite (better-sqlite3) and `node:http`. It indexes every DISCIPLE stack on RH testnet 46630:
- **v1**: the `previous` entry in `contracts/deployments/rh-testnet-46630.json`
- **v2**: the current stack plus the AnonLauncher/MarketLens add-ons
- **v3** (optional): after the combined redeploy, pass the new deployment json via `EXTRA_DEPLOYMENT`

## What it indexes
| Source | Events |
|---|---|
| Launchpad | `Launched`, `QuotePriced`, `MetadataUpdated`, `CreatorTransferred`, `LaunchTierContext`, `LaunchMode` (v4: `coins.mode` 0 TRENCH / 1 PVE / 2 PVP) |
| BondingCurve (each coin) | `Trade` (ends in `mcapAfterUsd`), `GraduatedToV4`, `AltitudeUpdate`, `TierBreak` (PR #44), v4 PVE: `ProfitTaxCharged`, `HolderRewardsClaimed` |
| DiscipleHook | `Trade` (post-grad; v4 emits the `IHookTradeEvents` overload ending in `uint160 sqrtPriceAfter` → mcap/price computed in `src/usd.ts` via `mcapUsdFromSqrt`/`priceWadFromSqrt`; older hooks end in `mcapAfterUsd`), `AltitudeUpdate`, `TierBreak` (PR #44). `LPDonation` was removed in PR #44 and is no longer decoded |
| Migration | `Migrated` |
| TrampWallManager | `TrampPlaced`, `WallPlaced`, `Filled`, `Cancelled`, `KeeperTipPaid` (PR #44), `FeesClaimed` (≤v3 only) |
| FeeRouter | `TradeFeeRouted` (audit #11 ABI: feeToken, feeIsQuote, creator, referralPayee, kolPayee + kolShare; per-payee rows in `fee_credits`), `CreatorFeesClaimed`, `CreatorTokenFeesClaimed` (v4, launch-token units), `ReferrerFeesClaimed`, `SnipeFeeRoutedToLP` (≤v2), `SnipeFeeRouted` (70/30, v3) |
| AnonLauncher | `AnonLaunched`, `Claimed`, `StealthOwnerTransferred`, `LaunchFeePaid` |
| ReferralRegistry | `ReferrerPending`, `ReferrerAttributed` (sticky), `UsdgDepositRecorded` |
| RewardsVault | `RewardAccrued`, `Distributed` |
| UsdgDepositNotifier (v4) | `Deposited`, `Escrowed` (7-day lock per entry), `Withdrawn`, `Attested` |
| Token (each coin) | `Transfer` (holder balances) |

Events are only accepted from the addresses of the expected stack. Spoofed `Launched` or `Trade` events from other addresses are ignored.

## REST API (GET, JSON, CORS `*`)
| Path | Returns |
|---|---|
| `/health` | stacks, cursors, counts |
| `/coins?sort=new\|volume\|mcap&stack=&graduated=&creator=&limit=` | coin list + volume/trades/last mcap |
| `/coins/:token` | detail + `live` market + `tier` inputs (see below) |
| `/coins/:token/trades?limit=&before=` | trades (curve + hook), newest first |
| `/coins/:token/candles?interval=1m\|5m\|15m\|1h\|4h\|1d&unit=price\|mcap&from=&to=` | OHLC in USD + volume over `[from, to]` (unix s). Default: 300 bars ending at the coin's last trade; span capped at 2000 bars |
| `/coins/:token/fees` | live creator fees pending (FeeRouter; AnonLauncher stealth owner + pending for pseudonymous coins) |
| `/coins/:token/orders` | tramps/walls for a coin |
| `/users/:addr/orders` · `/users/:addr/trades` · `/users/:addr/coins` | per-user data |
| `/users/:addr/counters` | `trampsPlaced/wallsPlaced/trampsFilled/wallsFilled/bigTrampsFilled` (tramp ≥ **$1K** at placement), trades, volumeUsd, coinsLaunched |
| `/rewards` | anti-snipe routing + RewardsVault totals |
| `/coins/:token/holders?limit=` (1–1000, default 100) | balances desc, `pct` of supply, `protocol` flag (curve/PoolManager/hook/TWM…) |
| `/coins/:token/altitude` | current `tier` + spot `mcapUsd` (from `AltitudeUpdate`), `LaunchTierContext`, every `TierBreak` |
| `/coins/:token/fee-routing` | summed `TradeFeeRouted` creator / lp / treasury / referral / creatorTax / kol shares in quote units, plus `tokenUnits` for post-grad fees charged in the launch token (never mixed), snipe 70/30, claims (wei + USD) |
| `/tier-breaks?limit=` | global tier-break feed (GAME) |
| `/orders?status=&kind=&token=&owner=&stack=` | tramp/wall orders incl. keeper + keeper tip |
| `/leaderboard/:board?by=&since=&limit=` | `traders` (by volumeUsd\|trades), `creators`, `coins` (by volume\|mcap\|tier\|new), `tramps`, `keepers`, `referrers` |
| `/users/:addr` | profile: counters, holdings, launched coins, anon (stealth-owned) coins, referrals, keeper tips |
| `/coins/:token/profit-tax?limit=` | v4 PVE profit tax: count, sellers, total tax / gross / cost basis, holder rewards claimed, unclaimed estimate (raw + USD), recent events + claims |
| `/users/:addr/rewards` | holder rewards claimed per coin + live `pendingRewards` on PVE curves, profit tax paid, creator fee claims (quote + token units), fee credits per role |
| `/users/:addr/referral` | referrer + status, referred wallets (attributed/pending), USDG gate total, notifier escrow entries (unlocked?, funded by), withdrawals, referral earnings + claims |
| `/users/:addr/holdings` · `/users/:addr/referrals` | per-user holdings (with last price) / referred-by, referred wallets, referrer claims, USDG deposits |

A typed fetch client for SITE/GAME lives in `client/disciple-indexer.ts` (copy into `/web` when wanted; this PR doesn't touch `/web`).

**Live market (`live`):**
- After graduation, the price comes from v4 `StateView.getSlot0(poolId)` × the live `QuotePricer`. The fallback order is launch quote price, then `MarketLens.market`. `curveMcapNowUsd` is also returned so the old curve bug stays visible.
- Before graduation, it uses `curve.mcapNow()`.
- `liquidityUsd` is 2 × virtual in-range quote reserve (post-grad) or 2 × curve quote reserve (pre-grad).

**Coin metric inputs (`tier`):** (display only; they no longer drive verification, which is a manual flag in `web/lib/verified.ts`) `volumeUsd`, `volume24hUsd`, `trades`, `ageSec`, `holders`, `liquidityUsd`. `holders` counts balances > 0, excluding the curve, PoolManager, Migration, hook, TrampWallManager and AnonLauncher.

**USD note:** trade USD values use the coin's launch-time quote price from `QuotePriced`. Live mcap uses the live pricer.

## Run locally
```bash
cd indexer
npm ci
npm test                       # unit tests (synthetic logs)
npm run index:once             # one sync pass against RH testnet, prints status
npm start                      # sync + poll every POLL_MS, serve on :4200
curl localhost:4200/coins/0xfa86b94d37cba24910bd68426c5c0ace683d6628   # TRMP
```

| Env var | Default |
|---|---|
| `RPC_URL` | public RH testnet RPC (set via env / `.env`; never commit keys) |
| `STACK_ID` | id for the newest stack in the json (needed for `web-bundle/addresses.json`, which has no `id`) |
| `STACKS` | comma list to restrict stacks, e.g. `v3` |
| `START_BLOCK` | override the newest stack's start block |
| `CONFIRMATIONS` | `2` — index up to head − N |
| `REORG_DEPTH` | `64` — block hashes retained for reorg checks |
| `RPC_RPS` | `20` — token-bucket limit on RPC calls |
| `MIN_LOG_CHUNK` | `500` — floor for adaptive getLogs range splitting |
| `DB_PATH` | `./disciple-indexer.sqlite` |
| `QUOTE_DECIMALS` | optional `0xUSDG:6,0xSTRAT:18` — known quote decimals for `coins.quote_decimals` (else `decimals()` is read on-chain once per quote; unknown stays NULL, never assumed 18). Set USDG:6 for the 6-dec redeploy. |
| `PORT` | `4200` |
| `POLL_MS` | `4000` |
| `LIST_CACHE_MS` | `5000` — TTL of the list-endpoint cache (0 = off) |
| `LOG_CHUNK` | `20000` |
| `DEPLOYMENT_JSON` | `../contracts/deployments/rh-testnet-46630.json` |
| `EXTRA_DEPLOYMENT` | (new stack json) |
| `V1_FROM_BLOCK` | `136090000` |

## Config: current v3 stack and the PR #44 redeploy
Addresses and start blocks come from JSON only — no addresses in code.
```bash
# v3 only, straight from the web bundle (start block 136187963)
DEPLOYMENT_JSON=../contracts/deployments/web-bundle/addresses.json STACK_ID=v3 npm start
# after the PR #44 redeploy: either regenerate the web bundle and point at it with STACK_ID=v4,
# or keep the chain json and add the new stack:
EXTRA_DEPLOYMENT=../contracts/deployments/<new>.json EXTRA_STACK_ID=v4 npm start
```
Old stacks never emit the new events, so a single union ABI decodes every stack. Each event is only accepted from the expected emitter of its stack (or a curve/token discovered through that stack's Launchpad).

## Performance
- **Per-coin aggregates.** `coin_stats` (volume, trade count, last mcap, last price, last trade ts/block) is updated in the
  same transaction as each newly inserted trade, so `/coins` (and `/leaderboard/coins`, profiles) never scan `trades`.
  Existing DBs are backfilled once on startup (`rebuildCoinStats`, versioned in `meta`). Reorg rebuilds clear them with the stack.
- **USD in one place.** `src/usd.ts tradeUsd()` is the only Trade → USD conversion (price, volume, mcap). The #75 redeploy
  replaces `mcapAfterUsd` with `sqrtPriceAfter`; swap the mcap computation there.
- **Candles** read only the requested range (`trades_token_ts`).
- **Leaderboard** uses `trades(trader, ts)`.
- **List cache.** `/coins`, `/leaderboard/*`, `/tier-breaks`, `/orders` are cached in-process for `LIST_CACHE_MS`
  (default 5000; 0 disables), invalidated by any newly applied chunk, and sent with `Cache-Control: public, max-age=5, s-maxage=5`
  for a CDN/proxy in front of the container.

## Reliability
- **Atomic chunks.** Each `LOG_CHUNK` range does core-contract logs → decode any `Launched` in that batch → curve/token logs for known and new coins → one merged, (block, logIndex)-ordered SQLite transaction that also advances the cursor. A crash never half-applies a chunk, so balances are never double-counted.
- **Reorgs.** The indexer stays `CONFIRMATIONS` behind head and stores the hash of each cursor block. On every pass it re-reads the cursor block. If the hash changed, that stack's derived rows are wiped and replayed from its start block. That takes ~15 s for v3 today; the RH testnet is an Arbitrum Orbit chain, so reorgs past the confirmation lag are very rare. Upgrade path for mainnet scale: per-block undo logs or Ponder.
- **RPC limits.** A token-bucket limiter (`RPC_RPS`) covers all calls. Retries use exponential backoff with jitter, and 429s back off 4× longer. When a provider rejects a range ("block range"/"too many results"), getLogs splits it in half recursively down to `MIN_LOG_CHUNK`. Block timestamps are fetched 10 at a time and cached.

## Tests
`npm test` runs 29 vitest cases on synthetic logs:
- spoofed emitters
- trades and candles
- counters
- PR #44 altitude, tier breaks, keeper tips, sticky referrals, fee-routing shares, leaderboards and profile
- adaptive getLogs splitting, 429 retry, the rate limiter
- coins launched mid-chunk, idempotent re-sync, and reorg detection and rebuild against a fake chain
- loading the web-bundle config
- coin_stats aggregates vs the old join, idempotent re-sync, backfill migration, candle ranges, limit clamping, list cache

## Docker
```bash
docker build -f indexer/Dockerfile -t disciple-indexer .    # from the repo root
docker run -p 4200:4200 -v disciple-data:/data disciple-indexer
```

## Verified against testnet (2026-10-16, branch flow/indexer-v4)
- **v3 only** (`web-bundle/addresses.json`, from 136187963): a cold backfill to head 136724193 took **14 s**. It indexed 1 coin (SMK `0xcac8…6bb3`, graduated) with 63 trades, 66 fee events and 27 balances.
  - `/coins/:t/fee-routing`: creator 30,277.9 / LP 25,380.2 / treasury 31,195.5 STRATEGY (≈ $74 / $62 / $76), referral 0
  - Snipe fees: 3.108 to rewards and 1.332 to treasury (70/30). RewardsVault `RewardAccrued` = 3.108.
  - The v3 contracts predate PR #44, so `altitude.tier` is null. `LaunchTierContext` is populated (start $7K, graduation $33K).
- **All stacks** (v1+v2+v3 via `rh-testnet-46630.json`): backfill took 34 s. Totals: 11 coins, 122 trades, 2 orders, 133 fee events, 91 balances.

## Verified against testnet (2026-10-15)
- 10 coins and 60 trades across v1 and v2.
- **TRMP** `/coins/0xfa86…6628`:
  - `live.mcapUsd` = **$45,284.87** (`v4-pool`), against `curveMcapNowUsd` = $33,000 (the old curve bug)
  - `liquidityUsd` ≈ $21.6K, holders 17, volume $14.3K over 30 trades
  - creator fees pending 16,722 STRATEGY ≈ $40.97
  - tramp #1 and wall #2 both filled; the deployer's counters are `trampsFilled=1`, `wallsFilled=1`
- The pseudonymous coins (PSD0/PSD1) show `anon=1` with their stealth owners; their fees have already been claimed.

## After the combined redeploy
Keep the v2 json as `DEPLOYMENT_JSON` (for example, copy it to `deployments/rh-testnet-46630.v2.json`). Then set `EXTRA_DEPLOYMENT=contracts/deployments/rh-testnet-46630.json` and `EXTRA_STACK_ID=v3`, so all three stacks are indexed.
