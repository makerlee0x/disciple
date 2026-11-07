# Self-bundler lockdown — preflight results (NOT implemented / NOT release-ready)

Recorded 2026-11-06 20:03:10 CT.

## Outcome

No self-bundler implementation was restored, no live matrix was run, and no security/latency claim is established. A new worktree/branch `flow/self-bundler-lockdown` was created from current `origin/main` (`9e1abc0986104988a6c14c8b43cf36a014f6bbd5`). This branch contains this preflight documentation only. Historical code and PR #245 were read; they were **not copied into the runnable app**. Hosted BSO remains unchanged on `flow/gasless-bso-phase2` (`f1bc2c70947d680fc0506dceb08124c6b75ba360`); it has not yet been integrated into this branch.

**Successful authenticated fixture preparation remains unresolved.** Every reused Phase 2 wallet currently has LoginGate `verifiedUntil == 0`. Existing installed trading sessions are not evidence of LoginGate authentication. Passing them as authenticated, adding a test bypass, or minting attestations without the real login prerequisite would undermine the requested lockdown. No such bypass was attempted. The existing fixture wallets also have no native balance, EntryPoint deposit, or v5 gas credit. Do not interpret this report as proof that a new contract or fee change is needed: neither has been established.

## Read-only chain evidence

Chain ID confirmed **46630**. Initial read block **149787907**; subsequent credit/balance reads used latest state (not an atomic same-block snapshot). Evidence is recorded in the local task report; this document contains public chain reads only.

- Policy `0xD2cF85dd7cDC3c3e53EA0472BF6Bf006de45E4d2` reports `disciple.session-policy.1.4.3`.
- Its immutable `paymaster()` is **`0x5C3f7400ED41aCd7409D213caB2909e3b1E31136`**, a deployed contract reporting `PREPAY_VERSION() == 5`.
- Paymaster `getDeposit()` = **12505277122969566 wei = 0.012505277122969566 ETH**.
- `SETUP_DEPOSIT()` = **2,000,000 raw USDG = 2 USDG**.
- Main's default zero paymaster configuration does **not** mean that no v5 paymaster is deployed. Do not deploy another one based on that stale inference.

| Existing smart account | Liquid USDG | Native wei | EP deposit wei | PM credit raw | LoginGate verifiedUntil |
|---|---:|---:|---:|---:|---:|
| `0x1f505Cd8bd9aF695d304E82eB4b24779106195ab` | 0.598010 | 0 | 0 | 0 | 0 |
| `0x64a9904b9Dc4835C4a68B3Fde7C84ED081aFd941` | 0.950000 | 0 | 0 | 0 | 0 |
| `0x47954dC954801481a2C4c1A7A4bD16c6b9430764` | 0.950000 | 0 | 0 | 0 | 0 |
| `0xcEA3A784Df107B879203fBe78C86E25fffA58BD1` | 0.950000 | 0 | 0 | 0 | 0 |
| `0x4B9BD01DAE35F9259bD17D2f5d04D1eC4F0d8143` | 0.950000 | 0 | 0 | 0 | 0 |

Liquid USDG totals **4.398010**; other previously spent USDG became existing coin positions, not additional funding. No individual wallet has the 2 USDG bootstrap minimum. `reservedOf == 0` and `bootstrapUsed == false` for every wallet. Credit/bootstrap behavior cited below is from current repository source plus the matching public getters; runtime/source equivalence was not independently verified.

## Gas repayment: exact distinction

1. **Unchanged BSO envelope:** signed maxFee/maxPriority/PVG all zero, no paymaster. EntryPoint beneficiary reimbursement is **zero**; simply moving this same envelope from Alchemy to our EOA turns it into EOA-funded gas, not a repaid fast path.
2. **Native-paid envelope:** EntryPoint charges the account's native deposit (or obtains missing prefund from account ETH) and compensates the beneficiary at the operation's effective gas price. All five reused wallets currently have zero in both sources. Funding only the server EOA does not fund the account's prefund.
3. **Existing v5 paid envelope:** with a valid paymaster authorization, required funded credit/bootstrap, and positive signed fees, EntryPoint charges **the paymaster's native EntryPoint deposit** and pays the beneficiary EOA. v5 settles the user's pre-funded USDG credit; the USDG ledger does not itself reimburse ETH to the EOA. This is an already-existing contract mechanism, not a new invented gas balance. See `contracts/src/paymaster/DisciplePaymasterV5.sol:245–305` and `web/lib/server/paymasterCore.ts:143–157`. Warm paid operations require available credit; zero-credit bootstrap requires the existing 2 USDG deposit shape. None of these fixture wallets currently meets that prerequisite.

No contract deployment, fee change, credit-rule change, wallet consolidation, LoginGate attestation, or native account-prefund transfer was performed. Whether legitimate authentication and existing-funds preparation can be completed within the exact approved scope remains unresolved; this is not an architectural impossibility claim.

### Numeric loss evidence and limits

Prior **hosted BSO**, not a restored self-bundler measurement: first buy `0x518e2f7b6791149d283ecc54762426d554ef716ca8211f5c3db58a5f937773b5` consumed **740,183 outer gas at 10,000,000 wei/gas = 7,401,830,000,000 wei = 0.00000740183 ETH**. Its signed gas fees were zero and paymaster data empty, so user gas charge / EntryPoint reimbursement were zero. This is the largest observed outer cost in the existing reconciled case evidence, **not a worst-case bound** and not a claim about Alchemy's fiat accounting.

A failed outer transaction after a successful simulation can still cost the EOA the entire outer transaction fee (state can race between simulation and inclusion). Fee-floor equality does not prove overall cost neutrality: receipt outer gas, L1 calldata charges, and EntryPoint actualGasCost must be reconciled independently. Historical `MAX_RELAY_TX_GAS` is 32,000,000: at the prior observed 10,000,000 wei/gas that would be **0.00032 ETH**, a conditional gas-limit × price ceiling, **not a measured restored-path loss limit**. A restored operation's actual signed outer fee cap and gas limit must determine its own bound. No numeric empirical worst-case self-bundler loss has been measured here.

## Matrix — no sends, no claimed passes

| Case | Outcome | Tx hash | New user charge USDG / ETH | Tap→pending / receipt ms |
|---|---|---|---|---|
| First buy | Not run: fixture prerequisites unmet | — | 0 / 0 (no action) | — |
| Sell | Not run: fixture prerequisites unmet | — | 0 / 0 (no action) | — |
| Failed trade | Not run: fixture prerequisites unmet | — | 0 / 0 (no action) | — |
| Expired/revoked session | Not run: fixture prerequisites unmet | — | 0 / 0 (no action) | — |
| Insufficient USDG | Not run: fixture prerequisites unmet | — | 0 / 0 (no action) | — |
| Blocked withdrawal | Not run: fixture prerequisites unmet | — | 0 / 0 (no action) | — |
| Concurrent rapid taps | Not run: fixture prerequisites unmet | — | 0 / 0 (no action) | — |
| Queue: sequential one account | Not run: fixture prerequisites unmet | — | 0 / 0 (no action) | — |
| Queue: separate accounts | Not run: fixture prerequisites unmet | — | 0 / 0 (no action) | — |
| Budget exhausted | Not provable on testnet | — | — | — |

Traces unavailable. Queue numbers unavailable. Tap-to-UI and tap-to-receipt unmeasured. Oct 26 buys ~0.5–0.75 s / sells ~0.3 s remain supplied historical comparison values, not reverified measurements.

| Abuse case | Outcome | Submission / hash |
|---|---|---|
| Unauthenticated operation | Not executed against a restored endpoint; existing fixtures are unverified | None |
| Unknown target / selector | Not tested; no restored endpoint | None |
| Failing full simulation | Not tested; no restored endpoint | None |

## Tests, operations and funds

- Targeted Vitest / tsc / lint: **not run**, because no web implementation was changed. No fabricated pass count.
- New UserOp submissions: **0**. Conservative cumulative ledger remains **21 / 60**, leaving 39.
- New native/token transactions: **0**. Funds newly moved: **0 USDG / 0 ETH**; no new funding hashes.
- No relayer EOA was funded; no donor key or Alchemy key was read for these public-RPC probes.
- No Foundry, mainnet, Production, Preview, env or policy edits, cloud agent, merge or PR.

## AUDIT focus / outstanding implementation

- Authentication must be established by real LoginGate verification and valid signed session authorization. An installed session, invited sender, cached sender trust, or a harness-only auth shortcut is insufficient.
- Restore f07ac2c6 sync/warm/streaming lineage with #245's exact-account checks and a full exact signed EntryPoint pending-state simulation **on every submission**. No signature/opHash auth cache or `FAST_RELAY_SIM` bypass.
- Canonical exact target/selector/call-value/recipient/paired-approval admission, shared fail-closed rate caps, and per-sender concurrency controls before signing.
- Reconcile paymaster credit and native prefund separately; enforce fee/gas bounds. Full simulation does not eliminate post-simulation paid outer reverts.
- Tap optimism must be a pending state before build/sign, not acceptance reported as final fill; rollback on definite failure, reconcile ambiguous submissions without blind resend.
- Integrate hosted BSO without auto-switching/re-signing after an ambiguous self-bundler submission.

Only repository file changed: `docs/self-bundler-lockdown-preflight.md`. This is a preflight-only branch, not the requested finished restoration.
