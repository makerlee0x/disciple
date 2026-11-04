# LP accounting reference model

`ledger.py` is an exact (rational arithmetic), brute-force model of GPT's ACCOUNTING_SPEC v1 plus maker's decisions
(settle every block and before every deposit or withdrawal). It is the answer key for the Solidity accounting
module, not an efficient implementation.

`python3 test_examples.py` reproduces the spec's worked examples A–I exactly.

## Integer mirror of the Solidity ledger (2026-11-04)

- `intledger.py` is the exact algorithm `contracts/src/bridge/libraries/DiscipleLedger.sol` runs: integer fixed point, with every rounding against the LP.
- `python3 compare_int.py 40` checks it against `fast.py` (exact rationals) on random histories. In 40/40 histories the worst error is 6.6e-18 of reserves. The integer version never pays an LP more than the exact model, and claims never exceed escrow.
- `python3 gen_ledger_vectors.py ../../contracts/test/bridge/` writes `DiscipleLedgerVectors.sol`: 8 histories and 778 ops. `DiscipleLedger.t.sol` replays them, and every number must match bit for bit.
- Two guards are added beyond the spec:
  - 1e6 shares can never be withdrawn, so the pool never drains to rounding dust.
  - An interval gain above half the pool value is not distributed; it stays in share value pro rata. This keeps the 1/(V - D) terms bounded.
- The slide's quadratic term applies at every principal size. (An earlier cut-off below 1e12 principal shares paid every share the front weight; with a 6-decimal quote a $5,000 pool paid out 1.7x its earnings. Removed 2026-11-04.)
