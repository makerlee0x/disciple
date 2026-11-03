# LP accounting reference model

`ledger.py` is an exact (rational arithmetic), brute-force model of GPT's ACCOUNTING_SPEC v1 plus maker's decisions
(settle every block and before every deposit or withdrawal). It is the answer key for the Solidity accounting
module, not an efficient implementation.

`python3 test_examples.py` reproduces the spec's worked examples A–I exactly.
