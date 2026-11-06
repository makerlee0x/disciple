# DISCIPLE #251 local-only ERC-7562 verifier

Target: `7b1fab32909f09e41ab690c4990f2ba7edaaab20` (`cursor/paymaster-v5-gas-credit-0662`).

## Laptop: copy/paste

Prerequisites: Git, Node 20+ with npm, and Foundry (`forge`, `anvil`) on PATH. No wallet key, `.env`, paid RPC, Docker, or full application install is needed.

From a clone of this branch (the harness lives in `tools/erc7562-check/`):

```bash
export PATH="$HOME/.foundry/bin:$PATH"
git clone --branch cursor/paymaster-v5-gas-credit-0662 --single-branch https://github.com/makerlee0x/disciple.git disciple
cd disciple/contracts
bash ../tools/erc7562-check/setup.sh "$PWD"
bash ../tools/erc7562-check/run.sh
```

With an existing clone, only the final two commands are needed. The results in this folder were produced against `7b1fab32909f09e41ab690c4990f2ba7edaaab20`.

`setup.sh` fetches the six exact pinned libraries, fetches the pinned reference bundler, installs the small harness npm dependencies, copies only the required contract/client sources to the harness, and builds 14 Solidity dependency-closure files with **normal solc 0.8.26, optimizer 200, viaIR, Cancun**. It never runs Foundry tests/fuzz or compiles the whole repository. It refuses to overwrite an existing library at a different revision. Source checkout tracked files are untouched.

`run.sh` creates an isolated Anvil fork, uses default Anvil development accounts, deploys/stakes/deposits only on localhost, runs the six intended on-chain operations, saves traces, prints admission/execution verdicts and gas, then shuts down its own node. All outputs stay in the harness. An occupied port is an error, not an invitation to reuse another node.

Optional:

```bash
FORK_RPC=https://rpc.testnet.chain.robinhood.com ANVIL_PORT=18546 bash ../tools/erc7562-check/run.sh
# Replay the recorded fork block (if the public upstream retains historical state):
FORK_BLOCK=<forkBlock-from-results.json> bash ../tools/erc7562-check/run.sh
```

`FORK_RPC` is used **only for Anvil's upstream read-only fork**. The harness accepts only loopback `ANVIL_RPC`, checks `web3_clientVersion` is Anvil and chain ID is 46630 before any write. No source app secrets are read. Never share logs containing a private upstream RPC URL without redacting it.

## What is checked

- EntryPoint v0.7 at `0x0000000071727De22E5E9d8BAf0edAc6f37da032`; live MAv2 factory, implementation and SingleSigner/TimeRange modules are reused from RH testnet.
- Fresh MAv2 account; testnet USDG mock is minted **on the fork only**. Paymaster V5 and session policy V1.4.3 are compiled from this PR and deployed on the fork.
- Paymaster stake **2,173,913,043,478,261 wei**, delay **86,400 sec**, EntryPoint deposit **13,043,478,260,869,566 wei**. Launch cap enabled locally at the repo's 21,840,770 gas-unit cap.
- (a) zero-credit owner setup: exact approve + $2 deposit + session install, including account deployment;
  (b) session boost; (c) session boost plus exact hidden approve/deposit top-up;
  (d) session sell, using actual purchased coin balance and a real route quote with nonzero 99% min-out;
  (e) owner launch (`launchWithMode`, normal mode, no creator buy);
  (f) normal owner send: release a $0.10 shortfall from hidden credit, then transfer wallet USDG + shortfall.
- On-chain signed payloads follow the client encoding, nonce layout, session SDK install, funding/send helpers and static trade limits. Warm sessions use the allowance signature domain; setup/launch/send use exact-operation signatures. Setup and launch use explicit valid gas envelopes, not a remote bundler gas estimate. This is not a full frontend/API integration test.
- Each admitted op is included through `handleOps` on the fork. Success requires `UserOperationEvent.success`, paymaster charge emission and zero remaining reservation. Gas is extracted from the **included transaction** call tree, not Solar or a guessed cost.
- Each validation trace is parsed with the pinned reference legacy `tracerResultParser` and canonical `ERC7562Parser`, once with actual stake and again with paymaster stake/delay zero.

## Exact rule tooling and limitations

Reference: `eth-infinitism/bundler` commit `aae77140e5c2b1386d04eaeba2d23fc17a62bd87`.
Its `BundlerCollectorTracer` is used unchanged through Anvil's `debug_traceCall` JavaScript tracer, stopping at `BeforeExecution()`.

Anvil does not supply the native `erc7562Tracer`. `validator/normalize.cjs` adapts the reference JS collector to the canonical parser's ERC7562Call shape: real call edges/values/CREATE destinations/returns are retained; per-entity opcode and code-access aggregates remain per-entity, and storage accesses are attached under their actual storage addresses. This is **not** native Geth/Rundler or an Alchemy admission API response. Keep the raw collector traces for independent review.

The rule engines are bundled from unmodified upstream sources. Two explicitly documented runtime adapters avoid building the whole monorepo: `utils.cjs` provides the pure ethers/RpcError utilities imported by the parsers; `diagnostics.cjs` replaces pretty-printing and identifies only depositTo/fallback/other selectors for the EntryPoint-call rule. No opcode/storage/stake rule is changed.

All six require a staked paymaster. The canonical parser rejects their unstaked counterfactuals with **EREP-050** (nonempty context) and its generic **STO-010** storage violation (the own-storage exception requires stake under STO-031). Reference `isStaked` uses stake >=1 and delay >=1; this does **not** prove an operator's separate stake/reputation/mempool thresholds.

## Critical frontend caveat

`site-preflight.mts` also reproduces an independent defect in this exact head: `paymasterClient.ts:27-31` (`withPaymasterApprove`) removes **every** USDG approve targeting the paymaster. `payGasInUsdg` applies it in its allowance, stub and final paths (lines 107, 115, 120). This strips the required funding approval from both setup and auto-top-up, leaving a deposit with no matching approval. `classifyCreditCalldata` then returns `{kind:"bad"}`. The actual site flow is therefore **not certified ready**, even though the intended complete on-chain batches pass ERC-7562.

Proposed fix only (NOT applied): preserve a paired exact approve+deposit funding leg; strip only obsolete standalone legacy precharge approvals. Add a client regression test proving setup/top-up survive `payGasInUsdg` unchanged. No contract redesign is proposed or performed.

## Outputs and gas definitions

- `results.json`: six intended on-chain operation verdicts, gas, effective fee and charged USDG.
- `gas.csv`, `run.log`: table / human-readable log.
- `site-preflight.json`: actual client-helper defect reproduction (pure local data shaping; no broadcast).
- `traces/{a..f}-op.json`, `*-collector.json`, `*-normalized.json`, `*-rules.json`, `*-included-calltree.json`.
- `versions.txt`: exact Anvil/Forge/Node/bundler versions; `forge-build-small.log`.

Account validation and factory gas are inclusive call-frame measurements; paymaster validation and postOp are separate call-frame measurements; execution is the single EntryPoint-to-account execution frame. These columns do not sum to final billed gas: EntryPoint overhead, preVerificationGas and unused-gas penalties also apply. `actualGasUsed` is the EntryPoint event's billable gas; `receiptGasUsed` is whole handleOps transaction gas after refund. `usdgCharged` is the actual **UserOperationCharged** event amount, 6 decimals, not a price estimate or a credit delta contaminated by deposits/releases. Each row includes the actual effective wei/gas. Fees follow the site's base-fee-plus-tip calculation; the upstream's advertised `eth_gasPrice` is recorded separately and is not used as an invented flat bill.

Only a local fork was modified. No commit, push, PR comment, merge, live deployment or live broadcast was performed.
