# Relay wallet gas refill

Cron `/api/cron/gas-refill` (every 10 minutes) keeps every relay wallet in ETH: the main relayer (`RELAYER_PRIVATE_KEY`) and every key in `RELAYER_KEY_POOL`. It replaces the manual "convert USDG to ETH" job.

## How it works

1. Players pay gas back in USDG to the main relayer (gasless withdraw fee, flat gasless trade fee).
2. When any relay wallet drops below `GAS_REFILL_MIN_ETH`, the main relayer swaps USDG to ETH on the Uniswap v3 WETH/USDG pool `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` (about $10M deep, Nov 2026) through the Universal Router. The swap goes USDG to WETH, then WETH is unwrapped to ETH, and `amountOutMin` is the pool's spot price after its fee, minus `GAS_REFILL_SLIPPAGE_BPS`.
3. The main relayer then sends ETH to each low pool wallet, up to `GAS_REFILL_TARGET_ETH`, lowest balance first.

Every transaction is gas-estimated (simulated) first and is signed only by the main relayer through its shared KV nonce allocator (`sendWithRelayerNonce`). Pool wallets only receive ETH, so their leases and nonces are never touched. Adding a relayer is only an env change: add `RELAYER_KEY_n` and list it in `RELAYER_KEY_POOL`. No contract holds a relayer allowlist.

Before each swap the cron checks three things: the pool must be exactly USDG + `GAS_REFILL_WETH`, it must hold at least `GAS_REFILL_MIN_POOL_ETH` WETH, and its spot price must sit inside the USD/ETH sanity band. If any check fails, nothing is swapped and an alert fires.

## Env

| Var | Default | |
|---|---|---|
| `GAS_REFILL_ENABLED` | off | Kill switch. Must be `1` to run. Unset it to stop. |
| `GAS_REFILL_DRY_RUN` | off | `1` = report the plan only, send nothing |
| `GAS_REFILL_MIN_ETH` | 0.002 | top up a wallet below this |
| `GAS_REFILL_TARGET_ETH` | 0.005 | ...back up to this |
| `GAS_REFILL_MAIN_FLOOR_ETH` | 0.002 | the main relayer never sends below this |
| `GAS_REFILL_MIN_SWAP_USDG` | 5 | smallest swap (no dust swaps) |
| `GAS_REFILL_MAX_SWAP_USDG` | 100 | per-run cap |
| `GAS_REFILL_MAX_DAY_USDG` | 300 | per UTC day |
| `GAS_REFILL_MAX_DAY_ETH` | 0.1 | ETH sent to pool wallets per UTC day |
| `GAS_REFILL_SLIPPAGE_BPS` | 100 | 1..1000 |
| `GAS_REFILL_LOW_USDG` | 20 | alert below this USDG on the main relayer |
| `GAS_REFILL_MIN_POOL_ETH` | 20 | depth guard |
| `GAS_REFILL_MIN_USD_PER_ETH` / `_MAX_` | 500 / 50000 | spot sanity band |
| `GAS_REFILL_POOL` / `GAS_REFILL_WETH` | mainnet pool / WETH `0x0Bd7…AD73` | needed on other chains |
| `GAS_REFILL_ROUTER` | `deployment().universalRouter` | |
| `GAS_REFILL_ALERT_WEBHOOK` | none | Discord / Slack style URL (gets `{content, text}`) |
| `GAS_REFILL_ALERT_EVERY_MIN` | 360 | each alert kind at most this often |

Alerts are also logged as `[gas-refill] ALERT …`: `low_usdg`, `run_cap`, `day_cap`, `usdg_short`, `thin_pool`, `bad_pool`, `bad_price`, `swap_failed`, `topup_failed`, `still_low`, `main_out_of_eth`, `run_error`.

If the main relayer itself has no ETH, it can't pay for the swap. The cron then alerts `main_out_of_eth`, and the Team has to send it ETH by hand once.

## First mainnet run

1. Set `GAS_REFILL_ENABLED=1` and `GAS_REFILL_DRY_RUN=1`. Read the cron response in the Vercel logs: wallets, `usdPerEth`, and the planned swap.
2. Remove `GAS_REFILL_DRY_RUN`. The first real swap also sends a one-time USDG approve to Permit2, then sets a Permit2 allowance for the Universal Router (exactly the swap amount, 10 minutes) on each run.
