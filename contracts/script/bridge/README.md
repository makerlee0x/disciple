# Deploy DiscipleHook

This script deploys `DiscipleEngine`, `DiscipleAdminFacet`, `DiscipleLpFacet`, `DiscipleSwapFacet`, a small CREATE2 helper, and the mined `DiscipleHook`. It does not create a pool. It does not broadcast by itself. `forge script` sends transactions only when you add `--broadcast`.

It has not been run against Robinhood Chain testnet or Ethereum Sepolia.

Graduation is not a deploy-time parameter. After a pool is created, status turns on once pool TVL has stayed at or above 12% of that pool's smoothed reference TVL for 77 continuous minutes, and it turns off once pool TVL has stayed below that same line for 77 continuous minutes. There is no percent band to set. Turning it off pulls the vault back to idle and pauses the creator's fee cut. The script does not perform either step.

The hook address is mined with `HookMiner` (the same flags as the tests: `beforeInitialize`, `beforeAddLiquidity`, `beforeRemoveLiquidity`, `beforeSwap`, `beforeSwapReturnsDelta`). The CREATE2 deployer is a helper this script deploys, so the chain does not need the Arachnid proxy at `0x4e59b44847b379578588920cA78FbF26c0B4956C`.

## Env

| Name | Required | Meaning |
| --- | --- | --- |
| `POOL_MANAGER` | yes | Uniswap v4 PoolManager on the chain you are deploying to. Supply it. The script does not guess one. |
| `USDG` | yes | Quote token. |
| `USDG_DECIMALS` | yes | Must match `USDG.decimals()` when the token has that function. |
| `VAULT` | unless mocks | ERC-4626 whose `asset()` is `USDG`. The hook checks this in the constructor. |
| `LZ` | unless mocks | Adapter that implements `ILzRead`. Cross-chain anchors call it. Same-chain anchors never do. |
| `DEPLOY_MOCKS` | no | `1` deploys a mock ERC-4626 and a mock lz reader for whichever of `VAULT` / `LZ` you left unset. The mock reader records the read and does not deliver a callback. Call `fulfill(guid, priceWad, tvlWad)` or `fulfillBytes` on it to complete a read. |
| `DEPLOY_SLOT_READER` | no | Unset deploys `V4SlotReader` against `POOL_MANAGER` and logs it. `0` skips it. That contract is the lzRead target for anchor kind 5 (`ANCHOR_LZ_V4_SLOT`). Deploy it on the chain that holds the reference v4 pool, which may be a different chain from the hook. |

`VAULT` is not defaulted to Morpho Steakhouse USDG (`0xBeEff033F34C046626B8D0A041844C5d1A5409dd`). That address is the Robinhood Chain vault. A testnet that does not have it needs another ERC-4626 of the same USDG, or `DEPLOY_MOCKS=1`.

## Chains

Robinhood Chain testnet:

- chain id `46630`
- RPC `https://rpc.testnet.chain.robinhood.com`
- explorer `https://explorer.testnet.chain.robinhood.com`

Ethereum Sepolia:

- chain id `11155111`
- pass your own `--rpc-url`. This repo's `foundry.toml` has no Sepolia endpoint.

## Command

Robinhood Chain testnet, with a real PoolManager, USDG, vault, and lz adapter:

```bash
cd contracts && \
POOL_MANAGER=$POOL_MANAGER \
USDG=$USDG \
USDG_DECIMALS=$USDG_DECIMALS \
VAULT=$VAULT \
LZ=$LZ \
forge script script/bridge/DeployDisciple.s.sol:DeployDisciple \
  --rpc-url https://rpc.testnet.chain.robinhood.com \
  --private-key $PRIVATE_KEY \
  --broadcast
```

The same script against Sepolia, including mock vault and lz reader when those contracts are not deployed there:

```bash
cd contracts && \
POOL_MANAGER=$POOL_MANAGER \
USDG=$USDG \
USDG_DECIMALS=$USDG_DECIMALS \
DEPLOY_MOCKS=1 \
forge script script/bridge/DeployDisciple.s.sol:DeployDisciple \
  --rpc-url <sepolia-rpc> \
  --private-key $PRIVATE_KEY \
  --broadcast
```

The `:DeployDisciple` suffix is required. The file also contains the CREATE2 helper and the mock vault and reader.

Drop `--broadcast` to simulate. The script prints the hook, the facets, the engine, the vault, the lz adapter, and the slot reader.

Neither command has been run. The same script was run on a local anvil, with a freshly deployed PoolManager and a mock USDG, to check that the hook mines and the constructor accepts the address. That run is not a testnet deploy.
