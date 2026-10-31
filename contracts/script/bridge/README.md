# Deploy DiscipleHook

This script deploys four linked libraries and the mined `DiscipleHook`. Forge links the libraries into the hook's creation code before the hook is mined, so the salt is for the linked bytecode. It does not create a pool. It does not broadcast by itself. `forge script` sends transactions only when you add `--broadcast`.

It has not been run against Robinhood Chain testnet or Ethereum Sepolia. Pool creation is permissionless, multiple pools per coin, and is not part of this script. Anyone can call `createPool` for any coin. The creator argument is that pool's fee wallet. There is no creator allowlist and no way to change that wallet later. `tickSpacing` distinguishes pools for one coin, and the reference checks still apply.

Graduation is not a deploy-time parameter. Status turns on once protocol inventory has stayed at or above 12% of that pool's smoothed reference TVL for 77 continuous minutes, and it turns off once that inventory has stayed below the same line for 77 continuous minutes. The window is fixed. There is no percent band. Before graduation, and again after status turns off, the whole fee compounds for LPs. While status is on, each fee is 3,333 bps to the creator, 3,333 bps permanent locked liquidity, and the remainder to LPs. There is no builder. Idle USDG stays in the pool. The script does not create a pool.

The hook address is mined with `HookMiner` (the same flags as the tests: `beforeInitialize`, `beforeAddLiquidity`, `beforeRemoveLiquidity`, `beforeSwap`, `beforeSwapReturnsDelta`). The CREATE2 deployer is a helper this script deploys, so the chain does not need the Arachnid proxy at `0x4e59b44847b379578588920cA78FbF26c0B4956C`.

## Deploy and link order

The libraries are stateless and their addresses cannot change. Forge deploys each one before the hook, because the hook bytecode contains the addresses.

1. `DiscipleMath` — curve, Dutch auction, fee split, graduation step.
2. `DiscipleAnchor` — v2, v3, and v4 reads.
3. `DiscipleBook` — create, swap, poke, seed.
4. `DiscipleLp` — deposit, redeem, creator claim, quotes.
5. `DiscipleHook` — mined last. Holds every token and every storage slot. PoolManager calls this contract only.

After deploy the script logs `math`, `anchor`, `book`, and `lp` from the hook's `mathLibrary`, `anchorLibrary`, `bookLibrary`, and `lpLibrary` views. Those are code addresses, not storage.

## Env

| Name | Required | Meaning |
| --- | --- | --- |
| `POOL_MANAGER` | yes | Uniswap v4 PoolManager on the chain you are deploying to. Supply it. The script does not guess one. |
| `USDG` | yes | Quote token. |
| `USDG_DECIMALS` | yes | Must match `USDG.decimals()` when the token has that function. At most 18. |
| `V2_FACTORY` | no | Uniswap v2 factory. A v2 anchor must equal `getPair(coin, USDG)`. Unset stores address zero, and those creates revert. |
| `V3_FACTORY` | no | Uniswap v3 factory. A v3 anchor must equal `getPool(coin, USDG, fee)` and have cardinality of at least 2. Unset stores address zero, and those creates revert. |

There is no `BUILDER`, no LayerZero endpoint, and no lens. The hook takes no ETH.

## Chains

Drop `--broadcast` to simulate. The script prints the hook, the four libraries, the quote token, and the two factories.

```bash
POOL_MANAGER=0x... USDG=0x... USDG_DECIMALS=18 \
V2_FACTORY=0x... V3_FACTORY=0x... \
forge script script/bridge/DeployDisciple.s.sol:DeployDisciple \
  --rpc-url "$RPC" --private-key "$KEY"
```

Add `--broadcast` only when you mean to deploy. This repository does not run that step.
