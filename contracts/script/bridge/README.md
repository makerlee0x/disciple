# Deploy DiscipleHook

This script deploys `DiscipleEngine`, `DiscipleAdminFacet`, `DiscipleLpFacet`, `DiscipleSwapFacet`, a small CREATE2 helper, and the mined `DiscipleHook`. It does not create a pool. It does not broadcast by itself. `forge script` sends transactions only when you add `--broadcast`.

It has not been run against Robinhood Chain testnet or Ethereum Sepolia.

Graduation is not a deploy-time parameter. Status turns on once pool TVL has stayed at or above 12% of that pool's smoothed reference TVL for 77 continuous minutes, and it turns off once pool TVL has stayed below that same line for 77 continuous minutes. The window is fixed. There is no percent band. Before graduation, and again after status turns off, the whole fee compounds for LPs. While status is on, each fee is 33% creator, 33% LPs, 33% permanent locked liquidity, and 1% hook builder. The builder address is the `BUILDER` deploy parameter. Only that address can hand the role off, in two steps. Pool creators cannot. Idle USDG stays in the pool. The script does not create a pool and does not perform either step.

The hook address is mined with `HookMiner` (the same flags as the tests: `beforeInitialize`, `beforeAddLiquidity`, `beforeRemoveLiquidity`, `beforeSwap`, `beforeSwapReturnsDelta`). The CREATE2 deployer is a helper this script deploys, so the chain does not need the Arachnid proxy at `0x4e59b44847b379578588920cA78FbF26c0B4956C`.

## Env

| Name | Required | Meaning |
| --- | --- | --- |
| `POOL_MANAGER` | yes | Uniswap v4 PoolManager on the chain you are deploying to. Supply it. The script does not guess one. |
| `USDG` | yes | Quote token. |
| `USDG_DECIMALS` | yes | Must match `USDG.decimals()` when the token has that function. |
| `BUILDER` | yes | Address that receives the 1% graduated-fee share. Set once, in the hook constructor. The current builder can propose a replacement; the pending address must accept. Pool creators cannot change it. Accrued fees are pulled with `claimBuilderFees`. |
| `LZ` | unless mocks | Adapter that implements `ILzRead`. Cross-chain anchors call it. Same-chain anchors never do. |
| `DEPLOY_MOCKS` | no | `1` deploys a mock lz reader when `LZ` is unset. The mock reader records the read and does not deliver a callback. Call `fulfill(guid, priceWad, tvlWad)` or `fulfillBytes` on it to complete a read. |
| `DEPLOY_SLOT_READER` | no | Unset deploys `V4SlotReader` against `POOL_MANAGER` and logs it. `0` skips it. That contract is the lzRead target for anchor kind 5 (`ANCHOR_LZ_V4_SLOT`). Deploy it on the chain that holds the reference v4 pool, which may be a different chain from the hook. |

## Chains

Robinhood Chain testnet:

- chain id `46630`
- RPC `https://rpc.testnet.chain.robinhood.com`
- explorer `https://explorer.testnet.chain.robinhood.com`

Ethereum Sepolia:

- chain id `11155111`
- pass your own `--rpc-url`. This repo's `foundry.toml` has no Sepolia endpoint.

## Command

Robinhood Chain testnet, with a real PoolManager, USDG, and lz adapter:

```bash
cd contracts && \
POOL_MANAGER=$POOL_MANAGER \
USDG=$USDG \
USDG_DECIMALS=$USDG_DECIMALS \
BUILDER=$BUILDER \
LZ=$LZ \
forge script script/bridge/DeployDisciple.s.sol:DeployDisciple \
  --rpc-url https://rpc.testnet.chain.robinhood.com \
  --private-key $PRIVATE_KEY \
  --broadcast
```

The same script against Sepolia, including a mock lz reader when that contract is not deployed there:

```bash
cd contracts && \
POOL_MANAGER=$POOL_MANAGER \
USDG=$USDG \
USDG_DECIMALS=$USDG_DECIMALS \
BUILDER=$BUILDER \
DEPLOY_MOCKS=1 \
forge script script/bridge/DeployDisciple.s.sol:DeployDisciple \
  --rpc-url <sepolia-rpc> \
  --private-key $PRIVATE_KEY \
  --broadcast
```

The `:DeployDisciple` suffix is required. The file also contains the CREATE2 helper and the mock reader.

Drop `--broadcast` to simulate. The script prints the hook, the facets, the engine, the builder, the lz adapter, and the slot reader.

Neither command has been run. The same script was run on a local anvil, with a freshly deployed PoolManager and a mock USDG, to check that the hook mines and the constructor accepts the address. That run is not a testnet deploy.
