# Disciple keeper

Open-source keeper for cross-chain Disciple pools. It keeps every pool's anchor fresh by pushing the home-chain
source price over LayerZero, then finishes delivery on the destination itself (the route uses a zero-fee
self-executor, so nobody else is paid to deliver). Anyone can run one. The pool refunds the keeper from its tank.

Routes in v0: Ethereum → Robinhood Chain and Robinhood Chain → Ethereum (`DisciplePushSender` on the home chain,
`DisciplePushReceiver` + `DiscipleHook` on the destination). The keeper does not change or need any contract code.

## What it does each tick

1. **Finds pools.** Scans the destination hook's `Created` events (and any pools listed in the config), and reads each
   pool's push source (kind, home pool, orientation, decimal shift) straight from the hook's storage.
2. **Decides what is due**, with the hook's own rules, so it only sends what the pool will pay for:
   - **Move**: the home price moved at least `moveBps` (default 1.02%) from the pool's anchor, or from the price
     already on its way. The hook pays from 1.00%; the small margin keeps a move that drifts back from going unpaid.
   - **Heartbeat**: the anchor is 59.5 minutes old *and the pool traded since its last price*. Untraded pools get no
     heartbeat, because the hook would not refund it (`unpaidHeartbeats: true` sends them anyway, at your cost).
   - **Opening price**: a pool that is not live yet gets its first price (`firstPrice`). This one is never refunded.
   - Pools with an empty tank are skipped: a refund can only come out of the tank.
3. **Pushes.** Groups due pools by source into as few messages as possible (at most 64 pools and 10 kB each), quotes
   the LayerZero fee, refuses anything above `maxPushCostEth`, and sends `push`.
4. **Delivers.** Once the DVNs have signed, it sends `commitVerification` and then `endpoint.lzReceive` on the
   destination, in nonce order. If another keeper's packet is stuck in front of ours (same pathway, lower nonce), it
   delivers that one too; others' packets older than `takeoverAfterSec` are also delivered. Every delivery logs each
   pool's result, the refund, what the keeper spent on that packet, and the net.

State (scan cursors, pools, packets on their way) is kept in `keeper-state.json`, so a restart picks up where it
stopped, including packets that still need delivering.

## Money

- Refund per accepted pool = 1.2 × (its share of the home transaction and LayerZero fee + its share of the
  destination delivery gas), capped at 0.002 ETH of cost, paid from the pool's tank.
- Gas is refunded at **basefee only**. Any priority fee is the keeper's own cost, so keep `priorityFeeGwei` small.
  On the forked test at ~0.04 gwei Ethereum basefee, a 0.003 gwei tip left the keeper about 11% up on a paid push
  (refund 0.0000087 ETH against 0.0000078 ETH spent on all three transactions). A 0.02 gwei tip lost money.
- Unpaid: opening prices, unpaid heartbeats if you turn them on, delivering someone else's packet, and the
  Robinhood L1 data fee (not counted by the contracts).
- Fund the keeper wallet with a little ETH on **both** chains (it sends on the home chain and delivers on the other).
  About 0.005 ETH on Ethereum and 0.002 ETH on Robinhood is plenty to start.

## Setup (once)

Needs Node 22.18 or newer, and Foundry's `cast` for the key.

```
cd ~/Desktop/disciple-app/keeper
```

```
npm install
```

```
cp keeper.config.example.json keeper.config.json
```

Then edit `keeper.config.json`: put in the sender and receiver addresses printed by `DeployV0Push`, and each hook's
deploy block as `hookFromBlock` (on the destination chain) and the sender's deploy block as `senderFromBlock` (on the
home chain). Delete a route you have not deployed.

Store the keeper wallet's key encrypted (skip if `disciple` already exists). Use a fresh wallet just for the keeper:

```
cast wallet import disciple --interactive
```

## Run

```
export ETH_RPC=<your Ethereum RPC URL>
```

```
export RH_RPC=<your Robinhood RPC URL>
```

See what it would do, without sending anything:

```
npm run status
```

Run it (asks for the keystore password once; Ctrl-C stops it cleanly):

```
npm start
```

To run it unattended, put the password in a file only you can read and point `KEEPER_PASSWORD_FILE` at it.

### RPC note

`logChunk` is the most blocks one `eth_getLogs` may cover. The Alchemy free tier allows 10, which is fine for
Ethereum (12 s blocks) but cannot keep up with Robinhood's ~100 ms blocks when scanning for new pools and other
keepers' packets. On a free tier, list your pools in `pools` and set `"scanPools": false` and `"scanPushes": false`
on the Robinhood side, or use a plan with a larger range (and raise `logChunk`).

## Config reference

| key | default | meaning |
|---|---|---|
| `account` | `disciple` | cast keystore name (in `~/.foundry/keystores`) or a path to one |
| `chains.<name>.rpcEnv` / `rpc` | `ETH_RPC`, `RH_RPC` | where the RPC URL comes from |
| `chains.<name>.logChunk` | 10 | max blocks per `eth_getLogs` |
| `chains.<name>.priorityFeeGwei` | 0.003 (Ethereum), 0 | tip on every transaction (not refunded) |
| `chains.<name>.maxFeeGwei` | 30 (Ethereum), 1 | never pay more than this per gas; pushes wait while basefee is above it |
| `routes[].pools` | `[]` | extra pool ids to serve |
| `routes[].scanPools` / `scanPushes` | true | scan for new pools / for other keepers' packets |
| `policy.moveBps` | 102 | move trigger in bps |
| `policy.firstPrice` | true | push opening prices |
| `policy.unpaidHeartbeats` | false | also heartbeat pools that did not trade |
| `policy.minTankWei` | 1 | skip pools whose tank is below this |
| `policy.takeoverAfterSec` | 900 | deliver others' packets stuck this long |
| `policy.maxPushCostEth` | 0.003 | refuse a push that would cost more |
| `policy.packetTtlSec` | 21600 | stop retrying a packet after this long |

## Tests

```
npm test
```

Unit tests cover the price math (same integer rounding as the hook), the due rules, batching, packet parsing, the
keystore, and (when `forge` is installed) that the storage slots the keeper reads still match the hook.

End to end on local forks of both chains (deploys everything on anvil, plays the DVNs, runs the keeper; nothing
touches mainnet):

```
FORK_ETH=$ETH_RPC FORK_RH=$RH_RPC bash test/fork/run.sh
```

It checks: opening prices in both directions, no push when nothing moved, a 3% move pushed as one message for two
pools and refunded to both, another keeper's undelivered packet delivered first in nonce order, and no unpaid
heartbeat an hour later.
