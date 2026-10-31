# Deploy DiscipleHook

This script deploys `DiscipleEngine`, `DiscipleAdminFacet`, `DiscipleCreateFacet`, `DiscipleLpFacet`, `DiscipleSwapFacet`, a small CREATE2 helper, and the mined `DiscipleHook`. When `LZ` is unset it also deploys `DiscipleLzRead` against `LZ_ENDPOINT`. It deploys `AnchorLens` unless `DEPLOY_LENS=0`. It does not create a pool. It does not set the endpoint's read library or DVN config. It does not broadcast by itself. `forge script` sends transactions only when you add `--broadcast`.

It has not been run against Robinhood Chain testnet or Ethereum Sepolia. Pool creation is permissionless, multiple pools per coin, and is not part of this script. Anyone can call `createPool` for any coin. The creator argument is that pool's fee wallet. There is no creator allowlist. `tickSpacing` distinguishes pools for one coin, and the reference checks still apply.

Graduation is not a deploy-time parameter. Status turns on once pool TVL has stayed at or above 12% of that pool's smoothed reference TVL for 77 continuous minutes, and it turns off once pool TVL has stayed below that same line for 77 continuous minutes. The window is fixed. There is no percent band. Before graduation, and again after status turns off, the whole fee compounds for LPs. While status is on, each fee is 33% creator, 33% LPs, 33% permanent locked liquidity, and 1% hook builder. The builder address is the `BUILDER` deploy parameter. Only that address can hand the role off, in two steps. Pool creators cannot. Idle USDG stays in the pool. The script does not create a pool and does not perform either step.

The hook address is mined with `HookMiner` (the same flags as the tests: `beforeInitialize`, `beforeAddLiquidity`, `beforeRemoveLiquidity`, `beforeSwap`, `beforeSwapReturnsDelta`). The CREATE2 deployer is a helper this script deploys, so the chain does not need the Arachnid proxy at `0x4e59b44847b379578588920cA78FbF26c0B4956C`.

When this script deploys the adapter, the order is: adapter with the hook unset, then the facets and the mined hook, then `setHook` once. A pre-set `LZ` is left alone. The owner of that adapter calls `setHook` once, after the hook address is known. `setHook` cannot be repeated.

## Env

| Name | Required | Meaning |
| --- | --- | --- |
| `POOL_MANAGER` | yes | Uniswap v4 PoolManager on the chain you are deploying to. Supply it. The script does not guess one. |
| `USDG` | yes | Quote token. |
| `USDG_DECIMALS` | yes | Must match `USDG.decimals()` when the token has that function. |
| `BUILDER` | yes | Address that receives the 1% graduated-fee share. Set once, in the hook constructor. The current builder can propose a replacement; the pending address must accept. Pool creators cannot change it. Accrued fees are pulled with `claimBuilderFees`. |
| `LZ` | one of | An already deployed `DiscipleLzRead`. Cross-chain anchors call it. Same-chain anchors never do. |
| `LZ_ENDPOINT` | one of | Endpoint V2 on this chain, used when `LZ` is unset. The public CREATE2 endpoint on Ethereum and on Sepolia is `0x1a44076050125825900e736c501f859c50fE728c`. Robinhood Chain testnet is not in the public LayerZero registry. Supply the endpoint address if one is deployed there. |
| `READ_CHANNEL` | with endpoint | Channel the adapter sends to and accepts results from. LayerZero read channel 1 is `4294967295`. |
| `LZ_CONFIRMATIONS` | no | Confirmation floor on the adapter. Default `15`. A read request can raise it. It cannot lower it. |
| `DEPLOY_LENS` | no | Unset deploys `AnchorLens` and logs the address. `0` skips it. That address is `remoteOracle` for a pool whose reference pool lives on this chain. The builder must allowlist it before a cross-chain pool can use it. |
| `V3_FACTORY` | no | Uniswap v3 factory. Same-chain v3 anchors must equal `getPool(coin, USDG, fee)`. Unset stores address zero, and those creates revert. |
| `DEPLOY_MOCKS` | local only | `1` deploys an owner-gated adapter stand-in, and only when the chain id is 31337 or 1337. Any other chain reverts. `fulfill` is owner-only. |

## What you still configure on the endpoint

The adapter's owner is the endpoint delegate (`setDelegate` runs in the adapter constructor). After the script:

1. `setSendLibrary` and `setReceiveLibrary` for `READ_CHANNEL`, pointing at this chain's ReadLib.
2. `endpoint.setConfig` for that channel with the DVN allowlist. The DVNs have to support the reference chain's endpoint id and timestamp reads. The adapter does not pick a DVN.

The lens runs on the reference chain. Kind 0 passes `v3Pool` into `AnchorLens.readV3`. Kind 4 passes `refHook` into `readV4Oracle`. Kind 5 passes the remote PoolManager as `refHook` into `readV4Slot`. The pool chain stores the lens address as `remoteOracle`.

## Chains

Robinhood Chain testnet, the pool chain in the command below:

- chain id `46630`
- RPC `https://rpc.testnet.chain.robinhood.com`
- explorer `https://explorer.testnet.chain.robinhood.com`
- LayerZero endpoint, endpoint id, ReadLib, and DVNs are not published in the public registry. Supply them if LayerZero has deployed there.

Ethereum mainnet, when it is the reference chain:

- endpoint id `30101`
- Endpoint V2 `0x1a44076050125825900e736c501f859c50fE728c`

Ethereum Sepolia, when it is the reference chain:

- chain id `11155111`
- endpoint id `40161`
- Endpoint V2 `0x1a44076050125825900e736c501f859c50fE728c`
- pass your own `--rpc-url`. This repo's `foundry.toml` has no Sepolia endpoint.
- Read channel 1 is `4294967295` on the public LayerZero deployments.

## Command

Robinhood Chain testnet. `LZ_ENDPOINT` and `READ_CHANNEL` are the values the owner supplies for that chain. The script deploys the adapter and calls `setHook`.

```bash
cd contracts && \
POOL_MANAGER=$POOL_MANAGER \
USDG=$USDG \
USDG_DECIMALS=$USDG_DECIMALS \
BUILDER=$BUILDER \
LZ_ENDPOINT=$LZ_ENDPOINT \
READ_CHANNEL=$READ_CHANNEL \
LZ_CONFIRMATIONS=${LZ_CONFIRMATIONS:-15} \
forge script script/bridge/DeployDisciple.s.sol:DeployDisciple \
  --rpc-url https://rpc.testnet.chain.robinhood.com \
  --private-key $PRIVATE_KEY \
  --broadcast
```

Sepolia, deploying the lens (and a hook, if that chain should host pools) against the public endpoint and read channel 1. `POOL_MANAGER` and `USDG` are still required because the script deploys the hook.

```bash
cd contracts && \
POOL_MANAGER=$POOL_MANAGER \
USDG=$USDG \
USDG_DECIMALS=$USDG_DECIMALS \
BUILDER=$BUILDER \
LZ_ENDPOINT=0x1a44076050125825900e736c501f859c50fE728c \
READ_CHANNEL=4294967295 \
LZ_CONFIRMATIONS=15 \
forge script script/bridge/DeployDisciple.s.sol:DeployDisciple \
  --rpc-url <sepolia-rpc> \
  --private-key $PRIVATE_KEY \
  --broadcast
```

On Sepolia as a reference chain only, the logged `anchor lens` address is what a Robinhood pool stores as `remoteOracle`. The pool's `remoteEid` is `40161` when the reference pool is on Sepolia, and `30101` when it is on Ethereum.

The `:DeployDisciple` suffix is required. The file also contains the CREATE2 helper.

Drop `--broadcast` to simulate. The script prints the hook, the facets, the engine, the builder, the adapter, the channel, and the lens.

Neither command has been run. An earlier version of this script was run on a local anvil, with a freshly deployed PoolManager and a mock USDG, to check that the hook mines. That run is not a testnet deploy, and it did not deploy this adapter.
