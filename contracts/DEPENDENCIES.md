# Forge dependencies (pinned)

`lib/` is gitignored. These exact commits are pinned in `foundry.lock` and `.gitmodules`.

| Dep | Commit | Tag |
|---|---|---|
| foundry-rs/forge-std | `f3dae6e6ee381f25eb6a246f7da9b85c91a68219` | v1.17.0 |
| OpenZeppelin/openzeppelin-contracts | `cab19933c33c2ad1d4c7a84864a3601dddfd16f3` | v5.7.0 |
| uniswap/v4-core | `e50237c43811bd9b526eff40f26772152a42daba` | v4.0.0 (before the `PoolOperation` refactor) |
| uniswap/v4-periphery | `9969eec44cfdf07e24b41de47f40276a58401976` | — (only `test/shared/HookMiner.sol` is used) |

To install from scratch (I checked that a clean install builds and passes all tests):

```bash
cd contracts
forge install \
  foundry-rs/forge-std@f3dae6e6ee381f25eb6a246f7da9b85c91a68219 \
  OpenZeppelin/openzeppelin-contracts@cab19933c33c2ad1d4c7a84864a3601dddfd16f3 \
  uniswap/v4-core@e50237c43811bd9b526eff40f26772152a42daba \
  uniswap/v4-periphery@9969eec44cfdf07e24b41de47f40276a58401976
forge build
```

The compiler is pinned to **solc 0.8.26** (`foundry.toml`) because v4-core v4.0.0 uses the exact pragma `pragma solidity 0.8.26;`. No local patches are needed. Do not bump v4-core past v4.0.0 without also updating v4-periphery: newer periphery `src/` (V4Quoter, for example) imports `types/PoolOperation.sol`, which only exists in newer core.
