# DISCIPLE FLOW indexer + REST API

This is a lightweight indexer built on viem, SQLite (better-sqlite3) and `node:http`. It indexes every DISCIPLE stack on RH testnet 46630:
- **v1**: the `previous` entry in `contracts/deployments/rh-testnet-46630.json`
- **v2**: the current stack plus the AnonLauncher/MarketLens add-ons
- **v3** (optional): after the combined redeploy, pass the new deployment json via `EXTRA_DEPLOYMENT`

## What it indexes
| Source | Events |
|---|---|
| Launchpad | `Launched`, `QuotePriced`, `MetadataUpdated`, `CreatorTransferred` |
| BondingCurve (each coin) | `Trade`, `GraduatedToV4` |
| DiscipleHook | `Trade` (post-grad), `LPDonation` |
| Migration | `Migrated` |
| TrampWallManager | `TrampPlaced`, `WallPlaced`, `Filled`, `Cancelled`, `FeesClaimed` |
| FeeRouter | `TradeFeeRouted`, `CreatorFeesClaimed`, `SnipeFeeRoutedToLP` (≤v2), `SnipeFeeRouted` (70/30, v3) |
| AnonLauncher | `AnonLaunched`, `Claimed`, `StealthOwnerTransferred` |
| RewardsVault | `RewardAccrued`, `Distributed` |
| Token (each coin) | `Transfer` (holder balances) |

Events are only accepted from the addresses of the expected stack. Spoofed `Launched` or `Trade` events from other addresses are ignored.

## REST API (GET, JSON, CORS `*`)
| Path | Returns |
|---|---|
| `/health` | stacks, cursors, counts |
| `/coins?sort=new\|volume\|mcap&stack=&graduated=&creator=&limit=` | coin list + volume/trades/last mcap |
| `/coins/:token` | detail + `live` market + `tier` inputs (see below) |
| `/coins/:token/trades?limit=&before=` | trades (curve + hook), newest first |
| `/coins/:token/candles?interval=1m\|5m\|15m\|1h\|4h\|1d&unit=price\|mcap` | OHLC in USD + volume |
| `/coins/:token/fees` | live creator fees pending (FeeRouter; AnonLauncher stealth owner + pending for pseudonymous coins) |
| `/coins/:token/orders` | tramps/walls for a coin |
| `/users/:addr/orders` · `/users/:addr/trades` · `/users/:addr/coins` | per-user data |
| `/users/:addr/counters` | `trampsPlaced/wallsPlaced/trampsFilled/wallsFilled/bigTrampsFilled` (tramp ≥ **$1K** at placement), trades, volumeUsd, coinsLaunched |
| `/rewards` | anti-snipe routing + RewardsVault totals |

**Live market (`live`):**
- After graduation, the price comes from v4 `StateView.getSlot0(poolId)` × the live `QuotePricer`. The fallback order is launch quote price, then `MarketLens.market`. `curveMcapNowUsd` is also returned so the old curve bug stays visible.
- Before graduation, it uses `curve.mcapNow()`.
- `liquidityUsd` is 2 × virtual in-range quote reserve (post-grad) or 2 × curve quote reserve (pre-grad).

**Verified-tier inputs (`tier`):** `volumeUsd`, `volume24hUsd`, `trades`, `ageSec`, `holders`, `liquidityUsd`. `holders` counts balances > 0, excluding the curve, PoolManager, Migration, hook, TrampWallManager and AnonLauncher.

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
| `RPC_URL` | public RH testnet RPC |
| `DB_PATH` | `./disciple-indexer.sqlite` |
| `PORT` | `4200` |
| `POLL_MS` | `4000` |
| `LOG_CHUNK` | `20000` |
| `DEPLOYMENT_JSON` | `../contracts/deployments/rh-testnet-46630.json` |
| `EXTRA_DEPLOYMENT` | (new stack json) |
| `V1_FROM_BLOCK` | `136090000` |

## Docker
```bash
docker build -f indexer/Dockerfile -t disciple-indexer .    # from the repo root
docker run -p 4200:4200 -v disciple-data:/data disciple-indexer
```

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
