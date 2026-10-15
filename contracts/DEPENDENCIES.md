# Forge dependencies

This tree does **not** vendor `lib/`. Install before build:

```bash
forge install foundry-rs/forge-std --no-commit
forge install uniswap/v4-core --no-commit
forge install uniswap/v4-periphery --no-commit
forge install OpenZeppelin/openzeppelin-contracts --no-commit
```

After install, if solc 0.8.28 rejects v4's `pragma solidity 0.8.26;`, rewrite those pragmas to `^0.8.26` (one-time local patch) or pin solc to 0.8.26.

A `.gitmodules` file will appear once `forge install` is run without `--no-commit` on a maintainer machine; until then use this note.
