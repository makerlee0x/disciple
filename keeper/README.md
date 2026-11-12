# Disciple keeper

Open-source keeper for Disciple pools. Anyone can run one, and the pools pay it out of their own tip jars, so a pool
creator can run one for their own pools and anyone else can run one for profit. It does two jobs:

- **Same-chain pools**: when a pool's centre is 1% or more behind its leader, it calls `sample()` on the hook. The
  hook pays the caller gas + 20% from the pool's tip jar, straight to the keeper wallet, in the pool's own tokens.
- **Cross-chain pools**: it pushes the home-chain source price over LayerZero, then finishes delivery on the
  destination itself (the route uses a zero-fee self-executor, so nobody else is paid to deliver). The hook credits
  the refund to the keeper from the pool's jar, and the keeper collects its credits once a day.

The jar is filled by a 12% skim of the pool's fees until it holds about a week of tips (anyone can also top it up
with `fundJar`). A pool whose tokens the hook cannot value in ETH (for example two memecoins with no WETH or USD
side) pays no tips; it still catches up through its own trades.

Cross-chain routes in v0: Ethereum → Robinhood Chain and Robinhood Chain → Ethereum (`DisciplePushSender` on the home chain,
`DisciplePushReceiver` + `DiscipleHook` on the destination). The keeper does not change or need any contract code.

## Same-chain: what it does every `sampling.everySec` (default 2 s)

1. **Finds pools.** Scans each `sameChain` hook's `Created` events for same-chain pools (and any listed in `pools`).
2. **Asks the hook.** One `sampleDue(id)` eth_call per pool. The hook answers yes only when a `sample()` sent now
   would pay: the pool is live, nobody has read the price yet this block, the centre is 1%+ from the leader, and the
   jar is not empty. So the keeper never guesses.
3. **Samples.** Sends `sample(id)` and logs the tip it got against the gas it spent. The centre moves at most one
   step (1% on Robinhood) per block, so a 5% move takes about five tipped samples, then the tips stop.
4. If a pool pays nothing `missesBeforeRest` times in a row (someone else sampled first, or the hook cannot value
   its tokens), it rests that pool for `restSec`.
5. **One sample per L1 block.** It never samples the same pool twice within `minGapSec` (default 13 s). On
   Arbitrum-stack chains such as Robinhood, the hook's `block.number` is the Ethereum L1 block (about 12 s), so a
   second sample sooner does nothing but spend gas.
6. **Optional: keep a low-fee pool at the market** (`selfPayBps`, off by default). The hook only tips from 1%, which
   is fine for a 1% pool but leaves a 0.25% pool quoting off the market between 0.25% and 1%. With `selfPayBps: 25`
   the keeper also samples, at its own gas, any pool whose centre is 0.25%+ from its leader's live price (single-leg
   v2 / v3 / v4 leaders), at most `selfPayMaxPerHour` (default 60) times per pool per hour.

Sends on one chain go one at a time, and the keeper tracks the next nonce itself instead of re-reading it from the
RPC after each receipt, which a lagging node behind a load balancer can answer with the old count ("nonce too low").

**Carry pools.** Carry's follower hook (makerlee0x/carry `contracts/follower`) has the same `sample()` /
`sampleDue()` and pool storage head, but a shorter `poolState`. Set `"abi": "carry"` on its `sameChain` entry.
On Carry pools the keeper also puts USDG back into Morpho: swaps only pull USDG out of a pool's Morpho tail (a sell
that needs more than the hot part holds), so every `sampling.sweepEverySec` (default 900 s) it reads each pool's
`tailState` and calls `sweep(id)` once the hot quote is above `sampling.sweepBandBps` of its target (default 20000 =
2x: past 40% hot at the 20% launch target, trimmed back to 20%). Sweeps are at the keeper's own gas (about 290k).

On the local anvil test, with plain tokens, a tip came to about gas + 26% (the hook adds a fixed 90k for the gas
it cannot measure, sized for heavier real tokens). The first tip in a token pays about gas + 10%, because the
keeper's balance slot for that token is new.

## Cross-chain: what it does each tick

1. **Finds pools.** Scans the destination hook's `Created` events (and any pools listed in the config), and reads each
   pool's push source (kind, home pool, orientation, decimal shift) straight from the hook's storage.
2. **Decides what is due**, with the hook's own rules, so it only sends what the pool will pay for:
   - **Move**: the home price moved at least `moveBps` (default 1.02%) from the pool's anchor, or from the price
     already on its way. The hook pays from 1.00%; the small margin keeps a move that drifts back from going unpaid.
   - **Heartbeat**: the anchor is 59.5 minutes old *and the pool traded since its last price*. Untraded pools get no
     heartbeat, because the hook would not refund it (`unpaidHeartbeats: true` sends them anyway, at your cost).
   - **Opening price**: a pool that is not live yet gets its first price (`firstPrice`). This one is never refunded.
   - An empty jar does not stop a push (the push still fixes the price, and trades refill the jar), but the refund is
     then zero. Set `policy.minJar` to skip pools whose jar is below a floor.
3. **Pushes.** Groups due pools by source into as few messages as possible (at most 64 pools and 10 kB each), quotes
   the LayerZero fee, refuses anything above `maxPushCostEth`, and sends `push`.
4. **Delivers.** Once the DVNs have signed, it sends `commitVerification` and then `endpoint.lzReceive` on the
   destination, in nonce order. If another keeper's packet is stuck in front of ours (same pathway, lower nonce), it
   delivers that one too; others' packets older than `takeoverAfterSec` are also delivered. Every delivery logs each
   pool's result, the credit (in that pool's quote token), and what the keeper spent on that packet in ETH.
5. **Collects.** Every `collectEverySec` (default a day) it reads `owed(keeper, token)` for each served pool's tokens
   and calls `collect(token)` for anything owed. `npm run collect` does it now.

State (scan cursors, pools, packets on their way) is kept in `keeper-state.json`, so a restart picks up where it
stopped, including packets that still need delivering.

## Money

- Same chain: tip = (gas of the call) × basefee × 1.2, valued in the pool's tokens, at most 1/32 of the jar per tip,
  and only one tip per pool per block.
- Carry pools (`"abi": "carry"`): tip = cost × `tipBps`/10,000 (1.05 at launch, settable 1.00–1.50 by the admin), where cost includes the Robinhood L1 data fee once per
  transaction, paid in USDG (the jar skims quote only). At launch the margin is about 5% by design, so a Carry keeper roughly
  breaks even; it exists to keep the price fresh, not to profit.
- Cross chain: refund per accepted pool = 1.2 × (its share of the home transaction and LayerZero fee + its share of
  the destination delivery gas), capped at 0.002 ETH of cost, valued in the pool's quote token and credited from
  the jar (at most 1/32 of it per refund). Credits wait in the hook until the keeper collects them.
- Gas is refunded at **basefee only**. Any priority fee is the keeper's own cost, so keep `priorityFeeGwei` small.
  On the forked test at ~0.04 gwei Ethereum basefee, a 0.003 gwei tip left the keeper about 11% up on a paid push
  (refund 0.0000087 ETH against 0.0000078 ETH spent on all three transactions). A 0.02 gwei tip lost money.
- Unpaid: opening prices, unpaid heartbeats if you turn them on, delivering someone else's packet, and the
  Robinhood L1 data fee on Disciple v0.2 pools (Carry pools count it).
- Tips and credits are paid in the pool's tokens (USDG, WETH, the coin...), not ETH, so the wallet's ETH slowly
  turns into tokens. Top up ETH now and then, or swap the tips back.
- Fund the keeper wallet with a little ETH on each chain it sends on (cross-chain routes send on both). For
  same-chain only on Robinhood, 0.002 ETH is plenty to start; add about 0.005 ETH on Ethereum for routes.

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

Then edit `keeper.config.json`:
- `sameChain`: put in the hook address and its deploy block as `fromBlock` (or list your pool ids in `pools`).
- `routes`: put in the sender and receiver addresses printed by `DeployV0Push`, each hook's deploy block as
  `hookFromBlock` (on the destination chain) and the sender's deploy block as `senderFromBlock` (on the home chain).
Delete whatever you have not deployed (a same-chain-only keeper needs no `routes` and only `RH_RPC`).

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

## Hosting it (always on)

Same-chain sampling only earns while the keeper is running, so it wants a machine that never sleeps. A laptop is
fine for testing; for real use, a small Linux server (any $5 a month VPS: 1 vCPU, 1 GB) is plenty.

1. On the server: install Node 22 and Foundry, then copy the `keeper/` folder (or clone the repo).
2. Create a **fresh** keeper wallet there with `cast wallet import disciple --interactive`, and send it a little
   ETH. Never use a dev or test key: one of anvil's has a sweeper on Robinhood mainnet.
3. Put the RPC URLs and the password file path in an env file only you can read, for example `/etc/disciple-keeper.env`:
   `RH_RPC=...`, `ETH_RPC=...`, `KEEPER_PASSWORD_FILE=/root/.keeper-pass`.
4. Run it as a service so it restarts on crashes and reboots, e.g. a systemd unit:

```
[Unit]
Description=Disciple keeper
After=network-online.target

[Service]
WorkingDirectory=/opt/disciple/keeper
EnvironmentFile=/etc/disciple-keeper.env
ExecStart=/usr/bin/node src/main.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Logs: `journalctl -u disciple-keeper -f`. Health: `npm run status` shows every pool, its jar, and what is owed.

The RPC matters: sampling makes one call per pool every 2 s (about 43k calls a day per pool), so use a paid plan or
your own node for more than a few pools, or raise `sampling.everySec`.

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
| `sameChain[].chain` / `hook` | | chain name and same-chain hook address |
| `sameChain[].fromBlock` | 0 (= from now) | scan `Created` events from here |
| `sameChain[].pools` / `scanPools` | `[]` / true | extra pool ids / scan for new pools |
| `sampling.everySec` | 2 | how often to check same-chain pools |
| `sampling.missesBeforeRest` / `restSec` | 3 / 3600 | rest a pool after this many unpaid samples, for this long |
| `sampling.sweepEverySec` | 900 | Carry pools: how often to check each pool's Morpho tail (0 = never sweep) |
| `sampling.sweepBandBps` | 20000 | Carry pools: sweep once hot quote is above this share of its target (20000 = 2x) |
| `routes[].pools` | `[]` | extra pool ids to serve |
| `routes[].scanPools` / `scanPushes` | true | scan for new pools / for other keepers' packets |
| `policy.moveBps` | 102 | move trigger in bps |
| `policy.firstPrice` | true | push opening prices |
| `policy.unpaidHeartbeats` | false | also heartbeat pools that did not trade |
| `policy.minJar` | 0 | skip cross-chain pools whose jar (quote raw units) is below this |
| `policy.collectEverySec` | 86400 | how often to collect cross-chain credits |
| `policy.takeoverAfterSec` | 900 | deliver others' packets stuck this long |
| `policy.maxPushCostEth` | 0.003 | refuse a push that would cost more |
| `policy.packetTtlSec` | 21600 | stop retrying a packet after this long |

## Tests

```
npm test
```

Unit tests cover the price math (same integer rounding as the hook), the due rules, batching, packet parsing, the
keystore, and (when `forge` is installed) that the storage slots the keeper reads still match the hook.

Same-chain sampler end to end on a plain local anvil (no RPC needed: deploys a mock leader, the hook and a pool,
moves the leader 5%, and checks the keeper is tipped until the pool catches up, then stops):

```
bash test/local/same-chain.sh
```

Cross-chain end to end on local forks of both chains (deploys everything on anvil, plays the DVNs, runs the keeper; nothing
touches mainnet):

```
FORK_ETH=$ETH_RPC FORK_RH=$RH_RPC bash test/fork/run.sh
```

It checks: opening prices in both directions, no push when nothing moved, a 3% move pushed as one message for two
pools and credited to both from their jars, another keeper's undelivered packet delivered first in nonce order, no
unpaid heartbeat an hour later, and collecting the credits.
