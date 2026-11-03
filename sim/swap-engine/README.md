# Swap engine mirror

`engine.py` is a line-for-line Python copy of `contracts/src/bridge/libraries/DiscipleSwapMath.sol`, and
`fpm.py` is a bit-exact port of Solady's `lnWad`/`expWad`. They let the integer algorithm be fuzzed against an
80-digit Decimal reference without a Solidity toolchain.

- `python3 fuzz2.py <seed> <n> [min_log10_reserve]`: every fill must be pool-favoured; reports the worst extra shortfall.
- `python3 props.py <seed>`: split never beats whole, round trips never profit.
- `python3 gen_vectors.py ../../contracts/test/bridge/`: regenerates `DiscipleSwapMathVectors.sol`.

Change the Solidity and the mirror together, then regenerate the vectors.
