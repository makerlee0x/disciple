> Preview enablement correction (Nov 6, 2026, CT): the branch now honors `AA_SELF_BUNDLER` and defaults to self when the introduced mode vars are absent. Explicit `bso` is preserved; `AA_SELF_BUNDLER=0` disables self. Production is still rejected. Preview is permitted with its normal Node production runtime, without bypassing exact simulation/authentication. The server publishes only `{chainId, mode}` in an inert JSON bootstrap before client hydration and at `GET /api/aa/config`; no new public env var or hot-path configuration fetch is needed. The earlier local-only/default-OFF notes below are historical, not current selector behavior. No Vercel env edit was made.
>
> Targeted coverage is now 56 Vitest cases, including mode precedence, bootstrap, Preview acceptance, Production rejection and Preview simulation failure. Browser timing and valid authenticated live matrix remain unmeasured; no performance or gas-neutrality approval is implied.

# Self-bundler lockdown — implemented for local testnet, NOT live-matrix validated

Branch: `flow/self-bundler-lockdown`, off main `9e1abc0986104988a6c14c8b43cf36a014f6bbd5`.
Compare: https://github.com/makerlee0x/disciple/compare/main...flow/self-bundler-lockdown?expand=1

## Current status and exact authentication obstacle

The sync/warm/stream implementation and pending-on-tap changes are restored, with F-02 restrictions; hosted BSO is preserved as an explicitly selected fallback. No new contract or fee change was made. This is **not a finished or release-approved live restoration**.

Actual normal LoginGate request against the local branch (`:46631`), `POST /api/pve/attest`, returns **HTTP 503 `{"error":"pve_attester_not_configured"}`**, complete-response time 60.665 ms. Current normal flow is Privy ES256 access-token verification, linked owner plus verified email/Google/Twitter identity, server EIP-712 LoginAttestation, then the normal on-chain LoginGate attestation. A wallet signature alone is not this repository's current login flow. Local Privy/PVE server configuration and an interactive verified identity are not available in this executor. All reused fixtures had `verifiedUntil == 0`. No fake JWT, direct administrator attestation, authentication bypass or new identity was created. No extra Vercel secrets were pulled.

The blocker is **unavailable normal local LoginGate authentication**, not a demonstrated contract or fee limitation. Existing USDG consolidation is completed below; split balances are no longer the obstacle. No relayer was funded and no paid self-bundler UserOp was sent while authentication is unavailable.

## Historical solution, checked before restoring

- [#140](https://github.com/makerlee0x/disciple/pull/140): session-only trade hot path and warm caches (merged).
- [#141](https://github.com/makerlee0x/disciple/pull/141): `[rawTx]`-only `eth_sendRawTransactionSync`, same-byte ordinary-send fallback only for method/parameter unsupported errors, streamed receipts and paid USDG paymaster. This PR itself was not merged; do not treat its draft measurements as this branch's live results.
- [#150](https://github.com/makerlee0x/disciple/pull/150): integrated paid-paymaster stack (merged).
- [#174](https://github.com/makerlee0x/disciple/pull/174) / [#181](https://github.com/makerlee0x/disciple/pull/181): sent/rollback bridge and optimistic state (#174 not merged, replacement #181 merged). Historical `ok:true`/“done” at send time is deliberately **not restored**.
- Actual historical implementation: `f07ac2c6` lineage before `51c1a4bb`; F-02 exact-account checks and exact pending simulation from [#245](https://github.com/makerlee0x/disciple/pull/245), head `f22d37247d25d57585f5c38bda5869703c7b4ec2`.
- Hosted BSO code copied as a patch from `flow/gasless-bso-phase2` at `f1bc2c70947d680fc0506dceb08124c6b75ba360`. No branch merge or PR was performed. @account-kit/@aa-sdk remain 4.88.5.

### Repayment — actual receipt, not an invented gas balance

Repository golden fixture `web/scripts/fixtures/sgrad-grad-receipt.json` transaction:
`0x22f3d37afc18e8c4e80d8745b670ccaa3c35cf1c8714963a4f19d47540cc1843`.
A public transaction/receipt decode identifies:

| Item | Historical actual value |
|---|---:|
| Block / timestamp | 142139099 / **Oct 24, 2026, 8:10:52 PM CT** |
| EOA and EntryPoint beneficiary | `0xCE2B0BF288Bf37bE1E77DC05Fadd0D0a9c674C6b` |
| Paymaster funding EntryPoint reimbursement | `0xB3DB53C1E94F146194756FF456479ea0577E7d7E` |
| Signed PVG / verification / call gas | 60,000 / 350,000 / 4,218,708 |
| Signed maxPriority / maxFee (wei/gas) | 1,100,000 / 50,200,000 |
| Outer gas × effective price | 3,091,087 × 10,000,000 |
| EOA gas spent | **0.000030910870000000 ETH** |
| EntryPoint actualGasCost paid to beneficiary | **0.000038080281600000 ETH** |
| Reimbursement minus spend | **+0.000007169411600000 ETH** |
| Golden-fixture USDG postOp collection | **0.092457 USDG (92,457 raw)** |

The fixture was checked around Oct 26, but the transaction itself is Oct 24. It proves the historical **paid** reimbursement mechanism, not an Oct 26 sync RPC invocation or its latency. The old paymaster validated USDG balance/allowance and collected USDG in postOp. We do not redeploy or restore the old contract.

For current accounts the existing equivalent is v5 **`0x5C3f7400ED41aCd7409D213caB2909e3b1E31136`**, bound by SessionPolicy **`0xD2cF85dd7cDC3c3e53EA0472BF6Bf006de45E4d2`** (`disciple.session-policy.1.4.3`). Read-only getters reported **0.012505277122969566 ETH in its EntryPoint deposit** and setup deposit **2.000000 USDG**. Main's default zero paymaster configuration is stale, not proof of absence.

Paid path: EOA fronts outer transaction ETH → EntryPoint validates account and paymaster → EntryPoint deducts **paymaster native prefund/deposit** and compensates beneficiary EOA → v5 reserves and settles **existing prepaid USDG credit**, paying treasury. See `contracts/src/paymaster/DisciplePaymasterV5.sol:245–380`. v5 charges credit on successful or reverted account execution; no automatic new credit ledger was introduced. Bootstrap/top-up remain the existing owner-authorized preparation, not an exception to the trade-only self endpoint. Credit has not yet been deposited for these fixtures.

An operation **without** paymaster would require the account's native EntryPoint deposit/account ETH; fixture accounts have neither, so that is not the proposed paid mechanism. The zero-fee/no-paymaster BSO envelope is **hosted fallback only**. Sending it via our EOA would provide zero beneficiary reimbursement and is rejected by existing paid fee floors.

### Gas exposure / worst-case loss

Unchanged `gasPolicy.ts`: `RELAYER_TIP=1,000,000`, `relayerPrice(base)=2×base+tip`; signed op fee floors are checked, and outer fees cannot exceed signed op fees. Historical 60,000 PVG is reused only for ready private session trades; hosted BSO retains zero signed PVG and fees. No fee schedule changed.

Read-only chain block 149794249 had baseFee **10,000,000 wei/gas**. At the unchanged derived outer maxFee **21,000,000 wei/gas**, historical hard outer gas cap **32,000,000** gives conditional maximum all-gas-lost exposure:

`32,000,000 × 21,000,000 = 672,000,000,000,000 wei = 0.000672 ETH/op`.

This is a conservative **gas-limit × signed fee-cap ceiling at that fee**, not an observed restored-path loss or a universal bound under a different base fee. Actual per-op ceiling uses that op's signed outer gas and fee caps. A state race can make outer handleOps revert after simulation: the EOA then loses outer gas and receives no EntryPoint payment. Price-floor equality alone does not guarantee cost neutrality; ArbOS L1 overhead and exact PVG/beneficiary accounting need live measurement. Current restored-path gas spent/reimbursed per trade: **unmeasured, no paid trade submitted**.

## Admission, send semantics and mode switch

- Explicit `GAS_SPONSORSHIP_MODE=self` / `NEXT_PUBLIC_GAS_SPONSORSHIP_MODE=self`; default OFF. Self endpoint rejects every Vercel context, production Node runtime, and chains other than 46630. Process-only local configuration; no Vercel edits.
- LoginGate `verifiedUntil` checked against chain time; installed non-global/non-deferred active session entity required, policy exactly 1.4.3, paymaster must equal policy-bound paymaster.
- Router `0x688160633b22012717661545df6299d3d3174ad2`, registry-confirmed DISCIPLE USDG curves, approved selectors, zero call value, exact paired approve and bounded trade intents. No withdraw, transfer, owner/account management, unknown target or arbitrary selector.
- Every operation checks supported factory implementation and exact account proxy runtime/storage, then pending-state `eth_call` of the **exact packed EntryPoint.handleOps operation with the actual beneficiary**. This executes validation plus execution. No sender-trust, cached simulation, or `FAST_RELAY_SIM` bypass.
- EntryPoint can absorb an **inner trade revert** while handleOps succeeds: the simulation is not proof of a successful fill. Real `UserOperationEvent.success`/receipt drives final settlement and rollback.
- Shared fail-closed IP cap 120/min; after exact simulation, shared sender cap 20/min and global cap 60/min. These rate limits are not a replacement for the test harness's cumulative 60-operation ledger.
- Shared per-sender 90 s lease; rapid taps wait up to 5 s, retrying lease acquisition every 25 ms, **not resending operations**. Admission rechecked after waiting. Ambiguous sends quarantine until TTL. Atomic token-checked release.
- Restored warm gas/nonce machinery and NDJSON receipts; sync unsupported fallback submits only the same signed raw bytes. No ambiguous re-sign or automatic hosted retry. Legacy EOA `eth_sendUserOperation` route remains disabled.
- `bso` explicitly selects the inherited hosted policy-header fallback, zero signed fee/PVG and no v5 paymaster. Switching mode is deliberate, never an automatic response to uncertain submission.
- Pending tap event uses existing `disciple:op` sent/rollback bridge **before** build/sign. Early bridge result is pending/unknown, not `ok:true`; existing engine late/settled handling waits for the real outcome. Acceptance is not a final fill.

## Validation and before/after timing

- Targeted Vitest **40/40** (18 BSO, 5 route, 15 lockdown/auth, 2 tap-pending).
- TypeScript `tsc --noEmit`: **pass**.
- ESLint all **29 changed/new web TS/TSX/MTS files**, max warnings zero: **pass**.
- Existing sync-send/paymaster-policy/relay-policy/trade-failure/relay-op regressions: **102 pass, 0 fail, 1 skipped**; security-aligned legacy trust ledger: **13/13 pass** (115 Node regressions pass combined, one skipped); existing rapid-click harness: all OK. Legacy trust tests were updated because their old first-prime grant assertions intentionally contradict F-02; production trust shortcuts were not restored.
- Existing `sendRaw` build/sign timing fields are zero placeholders, not measurements; use complete tap/receipt timing and add comparable stage instrumentation before interpreting those fields. Browser paint, valid authenticated end-to-end self receipts, live concurrent queue, and v5 repayment remain **not measured**, so the requested trading-path before/after comparison is incomplete. No Foundry run.

| Metric | Before / historical | After on this branch |
|---|---:|---:|
| BSO warm action→submit | 973.7 ms mean | Self unmeasured |
| BSO submit→accept | 922.8 ms mean | Self unmeasured |
| BSO accept→observed receipt | 2,125.5 ms mean | Self unmeasured |
| Full warm action→receipt | **4,022.0 ms mean** | **Unmeasured** |
| Oct 26 buy / sell | Supplied 500–750 / 300 ms; not independently reverified | Unmeasured |
| Tap→pending event (Node proxy) | No equivalent pre-change event measurement | **p50 0.000382, p95 0.002725, max 1.810708 ms**, n=10000 |
| Browser tap→paint | Not measured | Not measured |

The event-dispatch proxy is **not browser paint or chain inclusion** and cannot be compared as a 4-second-to-microseconds fill improvement.

## Matrix and abuse evidence

| Case | Outcome | Tx hash | User charge USDG / ETH | Tap→receipt |
|---|---|---|---|---|
| First buy | Not run: normal LoginGate unavailable | — | 0 / 0, no send | — |
| Sell | Not run: normal LoginGate unavailable | — | 0 / 0, no send | — |
| Failed trade | Full-simulation rejection covered in mocked tests; live trade not run | — | 0 / 0, no send | — |
| Expired/revoked session | Unit rejection passes; authenticated live case not run | — | 0 / 0, no send | — |
| Insufficient USDG | Live case not run | — | 0 / 0, no send | — |
| Blocked withdrawal | Unit allowlist rejection passes; authenticated live case not run | — | 0 / 0, no send | — |
| Concurrent rapid taps | Lease queue/revalidation unit tests pass; live queue not run | — | 0 / 0, no send | — |
| Budget exhausted | Not provable on testnet; traces unavailable | — | — | — |

| Abuse | Actual evidence | Submission / hash |
|---|---|---|
| Unauthenticated operation | Local endpoint NDJSON `unauthenticated LoginGate session`, `notSent:true`; complete response 167.077 ms | **0 / none** |
| Unknown target/selector | Mocked admission tests reject arbitrary target and ERC20 transfer; authenticated endpoint case unavailable | 0 / none |
| Failing simulation | Mocked exact EntryPoint callback throws AA24; broadcast spy never called; authenticated endpoint case unavailable | 0 / none |

Queue before (BSO medians): one-account sequential **4006.8 ms**, one-account concurrent **4572.8 ms**, four accounts concurrent **3941.3 ms**. Self-bundler queue numbers **unavailable**, not inferred from unit timers.

## Existing-fund consolidation and cumulative budget

Existing liquid USDG **4.398010 conserved**. Wallets now **2.198010** and **2.200000 USDG**, both above existing 2-USDG setup minimum; other three are zero. No new USDG. Owner-signed native account transfer transactions were pre-simulated, not relay authorization bypasses.

**21 prior UserOp attempts + 6 new native transactions = conservative 27/60 total**, 33 remaining. New self/hosted UserOp broadcasts: **0**. Local rejected unauthenticated HTTP probes did not broadcast. Funding **0.000030 ETH** total to three owner EOAs, no server EOA funding; all six native transactions together cost **0.000002334650 ETH**. Existing-funds USDG relocation: **2.850000 USDG** across our accounts; total unchanged. Consolidation ledger is `/workspace/self-bundler-lockdown-ledger.json`; do not blindly rerun fixture prep.

| Action | Amount | Transaction |
|---|---:|---|
| ETH to owner for transfer gas | 0.000010 ETH | `0xebd4c3cfdfc3b9cfa7bb182476d412ba404cab533c142d52169e3dc19c6080b9` |
| Existing USDG consolidation | 0.950000 USDG → `0x1f505Cd8bd9aF695d304E82eB4b24779106195ab` | `0x9feb7d321229e65273c184c32f3763b21e336ad7cfb929b120b76dc0eec46709` |
| ETH to owner for transfer gas | 0.000010 ETH | `0x8093405e5b19ddc90f25664d69a9f1af4c1d373aaf8ffcde8df5a9fb06212143` |
| Existing USDG consolidation | 0.650000 USDG → `0x1f505Cd8bd9aF695d304E82eB4b24779106195ab` + 0.300000 USDG → `0x64a9904b9Dc4835C4a68B3Fde7C84ED081aFd941` | `0xd6dc6043212620494caa3213c1a821f318d61a80991622cebb77d27d2b50860c` |
| ETH to owner for transfer gas | 0.000010 ETH | `0x5a4cd36610805b764b7c0442371b305e8010f47061c6dec246f7be5f5750ad64` |
| Existing USDG consolidation | 0.950000 USDG → `0x64a9904b9Dc4835C4a68B3Fde7C84ED081aFd941` | `0x24add5ba752399b8c4718bf94e969edfa67b63bdb49f8e43a3ef7c0c53168a94` |

Donor value plus funding gas: 0.000030630000 ETH. Consolidation transactions used 0.000001704650 ETH of funded owner balances; remaining 0.000028295350 ETH across those owner EOAs. No new v5 deposit or LoginGate transaction was sent. Individual gas costs and submission times (CT) are in the ledger.

## AUDIT focus / completion requirements

1. F-02 exact simulation and immutable factory/runtime checks are mandatory on **every** signed op; ensure no alternate EOA send path remains. Validate account implementation allowlist, hooked policy binding, and signed nonce entity.
2. Establish the real Privy→PVE→LoginGate flow locally without fake identities/admin attestation. HTTP503 is not a successful sign-in. Obtain valid authenticated fixture operations before approving live results.
3. Exact target/selector/recipient/paired-approval rules, session revocation races, full validation failures versus inner execution reverts, and paymaster matching.
4. Shared fail-closed rate/mutex semantics across instances, queued expiry/revocation, ambiguous quarantine, lease TTL versus receipt wait, nonce allocation and same-bytes-only fallback.
5. Real v5 positive-fee receipts: reconcile EOA balance delta/outer fee, EntryPoint beneficiary payment, PM native deposit delta and USDG credit delta. Check PVG60k against ArbOS L1 charges. Conditional ceiling is not measured cost neutrality.
6. Browser engine pending/late handling, reservation accounting, final receipt success and rollback, and unknown-result recovery; acceptance must never be booked as final fill.
7. Complete the matrix, abuse endpoints and queue timing within remaining 33 conservative transactions/operations, with no new USDG. Time every hot-path change before/after with comparable instrumentation; current live after timings are absent.

No Production, Preview, Vercel env/policy changes, mainnet, cloud agent, new contract, fee change, Foundry, merge or PR. Branch push only.
