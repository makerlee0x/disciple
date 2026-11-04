# DISCIPLE launchpad repository — security and mainnet readiness review

**Revision:** `makerlee0x/disciple`, branch `main`, commit **`d0ebb2004455c5fdfe24b73de6be5781359a2161`**.

**Recommendation: do not treat this revision as mainnet-ready.** This review identified eight actionable findings: three High, four Medium, and one Low. Two High findings concern protocol-funded gas services; those services are presently testnet-oriented, and must not be carried over to valuable mainnet deposits/relayers with these behaviors. No critical exploit or complete drain of ordinary bonding-curve/locked-LP reserves was confirmed.

The separate hook product reviewed at `6b13f72` on `claude/project-thread-lei7eb` is excluded. This report does not repeat that product's findings. The original launchpad's `contracts/src/DiscipleHook.sol` is a different, integral part of this launchpad and was included.

## Findings summary

| ID | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| F-01 | High | Disposable accounts can consume paymaster ETH without paying USDG | Real local EntryPoint reproduction |
| F-02 | High | Public callers can make the fast relayer trust forged operations naming a funded sender | Actual relay-module reproduction and submission-path review |
| F-03 | High | Locked production dependencies include an affected Next.js runtime and other vulnerable packages | Registry advisory/version matches; feature-specific exploitability varies |
| F-04 | Medium | A transient source spot can be treated as a price held over time by the TWAP | Real local PoolManager swaps, restoration and subsequent launch |
| F-05 | Medium | Revocation does not invalidate an already signed login attestation | Contract reproduction |
| F-06 | Medium | One malformed HTTP request terminates the indexer process | Raw request against the actual local HTTP server |
| F-07 | Medium | RPC code-query failure re-enables a former owner's authentication shortcut | Actual signature-verification function with injected RPC failure |
| F-08 | Low | Indexer omits current sniper-escrow release/migration events from rewards reporting | Event catalog and ingestion-path check |

## F-01 — Unsecured paymaster debt is not Sybil-resistant

**Locations:** `contracts/src/paymaster/DisciplePaymaster.sol:161`, `:225`, `:258`; `web/lib/server/paymasterCore.ts:124`, `:168`.

Validation checks the sender's current USDG balance and an existing allowance or a first-call approval. It does not secure the payment before executing arbitrary account calls. Execution can approve the paymaster and then move all USDG elsewhere. `postOp` deliberately lets a failed collection become `debtOf[sender]` without reverting the successful operation.

The debt/reservation logic limits exposure for one account; it does not limit exposure for one attacker. The attacker abandons the indebted address, moves the same USDG to another address, obtains another public quote/allowance, and repeats. The quote service's allowance endpoint checks balance/debt/bounds, not an ownership template or collateral escrow. An op-bound quote also does not solve collection after the balance has been spent. No compromised signer is required under the current issuance policy.

**Reproduction:** `test/PaymasterDebt.t.sol` uses the repository's local EntryPoint v0.7 and account harness. Three separately validated operations approve and transfer their full USDG balance to the attacker. All three execute successfully, treasury receives **zero USDG**, the same **1,000 USDG** capital is reused, and the paymaster deposit falls by **0.0012028515 ETH**. Each abandoned sender has debt. The test pre-creates the minimal accounts; deployment/setup transaction costs are not included in that loss measurement. It is not a complete live attack-cost/profit benchmark.

**Impact:** repeated unpaid gas consumption can exhaust the deposit and deny service to other users. A per-sender cap, IP limit, or future repayment requirement does not bound an attacker who can change accounts. The API is currently explicitly testnet-only; this finding concerns the implementation and the risk of enabling it with real value, not evidence that a current mainnet deposit was attacked.

**Fix:** secure payment before arbitrary user execution, such as a prepaid USDG balance held by the paymaster or a safe maximum precharge with an unused-amount refund. A bootstrap approval may need a separate owner-paid or permit/collateral flow. Do not rely on an approval inside a batch that can later revert or empty the balance. Add global budget/circuit-breaker controls as defense in depth, and test account rotation and arbitrary owner calls through the actual public quote policy and EntryPoint.

## F-02 — Sender trust is not authentication of the submitted operation

**Locations:** `web/lib/server/fastRelay.ts:137`, `:153`, `:165`, `:178`, `:297`; `web/lib/server/relayTrust.ts:68`; `web/app/api/bundler/route.ts:29`.

`disciple_warm` is publicly callable and can prime any claimed sender. Priming reads ETH balance; the first clean prime grants verified status. For a purported global-owner nonce key, `sessionOpLooksAllowed` immediately returns true, without validating the operation's call data or signature. `trusted` then consults the sender-level balance/trust record. On the fast path, `relayOnce` skips the `handleOps` simulation and signs a relayer transaction.

A caller can name a funded third-party sender and submit invalid account data/signatures. The EntryPoint rejects validation, so its beneficiary reimbursement does not occur and the relayer pays the reverted transaction's gas. In particular, a balance-bearing EOA is not even a deployed ERC-4337 account, but the priming function does not check account bytecode. Strikes apply to the **claimed sender**, not authenticated caller. Rotating among sender addresses defeats a per-sender loss bound and can also degrade victims' fast-path service.

**Reproduction:** `relay-trust.mts` imports the actual fast-relay module, supplies only a local mock `eth_getBalance` response, and calls the same balance-only prime helper used by warmup. An operation with an arbitrary sender, `0xdeadbeef` call data and signature changes from untrusted to **`trusted(op) === true`**. No legitimate account signature, private key, on-chain transaction or live RPC was used. The reproduction establishes the actual skip-simulation decision; it does not broadcast a complete HTTP attack or measure a live relayer's loss.

**Fix:** default to per-operation `handleOps` simulation before spending relayer funds. If an optimized path remains, authenticate the exact operation and validate account implementation, current validation configuration, signature, nonce and required funding; a cached balance or a past successful operation is insufficient. Merely removing the first-prime grant does not protect already trusted users from forged submissions. Add a global loss circuit breaker, and charge caller limits only under a meaningful authenticated identity. Verify behavior for forged owner/session signatures, expired modules, stale nonces, EOAs and concurrent requests. The current relay is testnet-pinned; enabling a mainnet relay requires both this fix and explicit chain-aware configuration.

## F-03 — Production runtime has outstanding dependency advisories

**Locations:** `web/package.json:142`, `pnpm-lock.yaml`, `web/next.config.mjs`.

The web application pins **Next.js 14.2.35** and uses the App Router/Server Components. The registry audit of the locked production graph returns outstanding high-severity runtime advisories, including App Router/Server Components denial-of-service advisories. It also identifies affected transitive dependency versions. The exact registry output was retained with the local audit workpapers.

Examples:

- [GHSA-q4gf-8mx6-v5v3](https://github.com/advisories/GHSA-q4gf-8mx6-v5v3): Server Components DoS.
- [GHSA-8h8q-6873-q5fj](https://github.com/advisories/GHSA-8h8q-6873-q5fj): Server Components DoS.
- [GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r): App Router/Server Actions DoS, with the registry reporting a fixed 15.x floor of 15.5.28.

The registry also lists critical Next.js advisories with conditions involving Windows hosting or particular image-optimization input paths. **This audit did not demonstrate those conditions or remote code execution on this deployment.** Do not interpret the advisory count as a count of proven application exploits. Middleware, rewrites, CSP-nonce and image-specific entries require separate reachability assessment.

**Fix:** upgrade to a currently supported Next.js release that closes the applicable advisories, regenerate the lockfile deliberately, update related React/tooling requirements as necessary, and rerun the complete web build and security regressions. Triage the remaining transitive advisories by exact dependency path and reachable input. Avoid blanket dependency overrides or dismissing all findings because their initial location is transitive. The fixed-version floor above is an observation from this advisory snapshot, not a permanent recommendation to stop at that version.

## F-04 — Lagged spot sampling does not prove the sampled price persisted

**Locations:** `contracts/src/QuotePricer.sol:130`, `:147`, `:157`; `contracts/src/libraries/TwapOracle.sol:65`, `:74`, `:111`.

The reference pool does not write this oracle on each swap. Permissionless `poke` records a truncated **current spot**, then the oracle treats that stored tick as applying until another poke. A caller can move the reference price, poke, and restore the pool inside one transaction. Restoration does not update the oracle. Time weighting subsequently credits the transient recorded tick as though it held over the elapsed interval.

**Reproduction:** `test/OracleTransient.t.sol` executes actual local v4 swaps, pokes at the moved price, and swaps back to the original sqrt price before advancing time. After 1,800 seconds without an intervening poke, true spot remains **1.0**, but the oracle returns **1.221390545007857464**. A subsequent launch's own mandatory poke does not repair the historical interval; its curve bakes in the inflated price. Thus the earlier SEC-03 test for an unchanged *same-transaction read* does not cover the later poisoned observation.

**Impact:** misleading launch-time USD geometry and market-cap thresholds, with an incorrect immutable quote/USD price for newly created curves. A functioning 60-second keeper reduces a single transient poke's weight relative to this no-intermediate-poke example, but does not make it zero; an attacker can contest later observations as well. The reproduction does not establish a profitable liquidity-drain trade or keeper-front-running economics.

**Fix:** derive time weighting from reliable source observations that record actual price changes, an independently secured price oracle, or a verified historical observation scheme. For v4 this may require a compatible source-oracle hook or another oracle source; hookless pools do not acquire v3-style history just because an external contract samples them. Moving the observation one block later or truncating each poke alone does not establish persistence. Test move→poke→restore, honest intervening keeper updates, repeated adversarial pokes and launches after the poisoned interval.

## F-05 — Login revocation is reversible by replay

**Locations:** `contracts/src/LoginGate.sol:57`, `:63`, `:72`.

`revoke` deletes the saved expiry. The signed `LoginAttestation` contains wallet, expiry and coin, but no nonce or revocation epoch. Until the original expiry, anyone can resubmit the original signature and restore the deleted expiry. The curve's ten-minute cache cap does not fix the underlying replay.

**Reproduction:** `test/LoginRevoke.t.sol` records a valid 12-hour login, revokes it, verifies the expiry became zero, then replays the same signature from the wallet and restores the original expiry.

**Impact:** the documented owner kill switch cannot reliably revoke an issued login during its validity window. This affects the login gate, not possession of the wallet's signing key. Also define coin-specific versus global revocation precedence: deleting a coin-specific entry alone cannot override a still-valid global entry because `verifiedUntil` returns their maximum.

**Fix:** bind attestations to an on-chain wallet/coin revocation epoch or a nonce policy that is invalidated by revocation. Specify global and per-coin precedence, and test replay after revoke, partial/global revocation and the curve-cache refresh. A fresh signature issued under a new epoch is distinct from accepting an old one.

## F-06 — Malformed request kills the indexer HTTP process

**Location:** `indexer/src/api.ts:525`.

The async HTTP callback constructs `new URL(req.url, "http://x")` before its `try/catch`. A malformed absolute-form request target such as `http://[` throws. Node's HTTP server does not consume the rejected callback promise; with the tested default Node settings the process exits.

**Reproduction:** the actual `Api.server()` listener, started locally, receives one raw request:

```
GET http://[ HTTP/1.1
Host: localhost
Connection: close
```

It exits with status **1**, `TypeError: Invalid URL`, at `api.ts:525`. An unused mock database was sufficient because the failure occurs before route/database access.

**Impact:** unauthenticated API and indexing outage if the request reaches Node. A reverse proxy that rejects malformed absolute-form targets may block this exact packet; a directly exposed service is affected. Process supervision can restart it but does not fix repeated disruption. The production image uses Node 20; the explicit process-exit reproduction used Node 24.22.1, whose default unhandled-rejection behavior produced the captured result.

**Fix:** include request-target parsing and all async callback work inside error handling, return a bounded HTTP 400, and prevent rejected response/serialization promises from escaping. Test the actual server over raw sockets, including malformed URLs and disconnects. Keep reverse-proxy validation and restart supervision as additional controls.

## F-07 — A failed bytecode lookup weakens deployed-account authentication

**Location:** `web/lib/aa/verify.ts:31` (used by chat, profile/username and guild signature authorization).

After normal account signature verification fails, the legacy shortcut checks whether the account is deployed. `getCode(...).catch(() => "0x")` converts a lookup error into evidence of no code. The shortcut then accepts a signature from the original owner if a factory still predicts that address. Factory prediction remains unchanged when a deployed account's owner rotates.

**Reproduction:** `signature-outage.mts` passes the actual verifier a rejected ERC-1271 result and a valid legacy signature from a former owner. With deployed bytecode returned, the signature is correctly rejected. With only `eth_getCode` changed to throw a temporary RPC error, the **same** signature is accepted. The reads are injected; this is not an induced live RPC outage.

**Impact:** a former/original owner can impersonate a rotated account in the affected off-chain actions during selective code-read failure. This is conditional on the legacy owner possessing their own original key, the factory prediction matching, and the bytecode query failing while prediction reads succeed. It is not arbitrary wallet theft or a bypass of on-chain account ownership.

**Fix:** return an authentication failure/service-unavailable outcome when code status is unknown. Only use the undeployed-account shortcut after a successful, explicit empty-code result. Audit the related `walletBelongsTo`/factory-prediction identity paths as well: a predicted address is not proof of current ownership of a deployed account. Retain ERC-1271/current account authorization for deployed accounts and add outage regressions.

## F-08 — Current sniper-escrow movements are missing from rewards reporting

**Locations:** `contracts/src/BondingCurve.sol:879`, `:904`; `indexer/src/abi.ts`; `indexer/src/ingest.ts:219`; `indexer/src/api.ts:226`.

Current curves release expired sniper escrow by plain token transfer plus `SnipeEscrowReleased`, or send it to LP at graduation with `SnipeEscrowToLP`. This intentionally does not use the legacy `FeeRouter.routeSnipeFee` notification path. The indexer event catalog includes `RewardAccrued` and legacy fee-routing events, but neither current curve escrow event. Its decode/apply path therefore ignores them and `/rewards` aggregation omits them.

`rewards-events.mts` confirms both current event names are absent from the actual event ABI. The existing SnipeSplit tests explicitly accept plain transfers without `RewardsVault.totalAccrued` notification; the contract's intentional transfer design is not itself the finding.

**Impact:** incomplete community-reward funding/LP-routing accounting and unreliable reconciliation under the documented operations plan. Funds still arrive at their destination; this does not show custody loss or an inability to distribute actual balances.

**Fix:** index both curve events, authenticate their emitter against the registered curve, derive asset and destination correctly, and include them in current rewards/LP reporting without double-counting legacy `RewardAccrued`. Backfill already emitted events and reconcile against actual vault balances. Add a lifecycle test from an actual curve release through index ingestion and `/rewards` output.

## Mainnet rollout requirements that remain separate from the new findings

1. **The default deployment and AA paths are testnet-only.** `contracts/script/Deploy.s.sol:118` rejects mainnet chain IDs. `web/lib/aa/session.ts:43` and `:500` disable AA/one-tap outside 46630; `selfBundler`, `fastRelay`, the Alchemy URL and paymaster quotes are testnet-pinned. This is a guarded limitation, not evidence that the UI currently sends mainnet trades to testnet. Implement and test a deliberate mainnet deployment and chain-aware service configuration; do not merely remove guards. Mainnet cron/PVE sends also need nonce allocation from their actual chain, not the testnet cursor imported from `fastRelay`.
2. **SEC-04 remains an unresolved trust/deployment requirement.** The repository already documents mutable fund-redirecting wiring controlled by owners/admins. The default deploy script keeps most roles with the broadcaster; it does not implement the full Safe/timelock handover in the mainnet checklist. Some transfers are two-step nominations requiring `acceptOwnership`. Verify actual owners, pending owners, treasury, authorizations and consumed one-shot setters on the target deployment. A Safe alone adds no delay. Decide how emergency controls remain available if delayed ownership covers all setters. This audit did not inspect a live mainnet deployment or confirm any handover.
3. **Production shared storage and proxy assumptions need enforcement.** Without KV credentials, the implementation falls back to local storage even for a serverless production process. That does not provide shared nonce allocation, leases, rate limits, invitation state or durable usernames across instances. Fail startup for missing required shared storage. `clientIp` assumes a trusted proxy overwrites forwarding headers; enforce that for self-hosting before relying on per-IP budgets.
4. **Contract-size headroom is very small.** Under the exact compiler settings, the audit build produced Launchpad runtime **24,399 bytes** (177 below EIP-170) and BondingCurve **24,199 bytes** (377 below). Recheck sizes and initcode after fixes, optimizer/linking changes and compiler changes. Larger modules may need extraction rather than an optimizer workaround.
5. **Indexer configuration regression is already failing.** Its existing suite has 54 passes and one failure: an assertion still expects the old v4 web-bundle addresses/start block while the bundle now contains the v5 deployment. Diagnose/update the fixture against the intended deployment, retaining meaningful assertions. Do not describe the suite as green or change production addresses to satisfy the stale test.
6. **Finish production integration validation.** Mainnet addresses, source pools/oracles, token decimals, account factories/modules, secrets, service budget limits and wallet/relayer flows need an end-to-end rehearsal on a fork of the target chain. No live credentials or fork RPCs were supplied in this environment. Full production web startup/build and real Privy/LayerZero/provider behavior were not validated in this audit.

## Product overview

This product is a token launchpad with a game-themed web interface. The Launchpad deploys a fixed-supply token and a bonding curve with immutable launch-time price geometry and selected game-mode rules. Buyers pay the quote asset, receive launch tokens and pay protocol/creator/sniper fees; sellers redeem through the curve. PVE adds login-gated buying, creator lock, position/cost-basis accounting and holder reward distribution.

At graduation, Migration initializes the product's v4 pool at the curve-end price and sends liquidity to LockedLP, including the configured support-floor bands. The original launchpad hook charges trading fees, FeeRouter allocates creator/referral/treasury/LP shares, and LockedLP compounds its buckets under budget and deviation guards. DiscipleRouter provides direct and USDG routes; TrampWallManager supplies cancellable one-sided limit-order-like positions. AnonLauncher holds creator rights/fee collection behind signed stealth-owner actions.

The web application supplies wallet/AA flows, API proxies, the optional self-bundler/relayer, USDG paymaster quoting, Privy login attestations, profiles, moderation and community features. The session-policy contract limits permitted account calls, recipients, approvals and quote spending. The indexer ingests authenticated deployment events into SQLite and serves market, fee, holder and activity APIs.

## Scope, method and validation

This was a repository-wide security review focused on production attack surfaces. Manual review covered the fund-moving protocol core and libraries, migration/locked liquidity/fees, launchpad hook/router, session policy/SDK, paymaster, original private-launch add-on, web authentication and gas services, image/SSRF boundaries, rate limiting/shared storage, indexer ingestion/API, configuration and deployment controls. UI/renderer code was scanned for unsafe DOM and input-to-execution paths. Generated ABIs, artifacts, images and vendored dependencies were not independently audited line by line. Existing internal security documents were treated as claims to verify, not evidence that a fix works.

- Exact dependencies were used; the solc 0.8.26 binary was SHA-256 verified against the official manifest. Default optimizer/via-IR/Cancun configuration was retained. The conclusive full run used the repository-pinned Forge 1.9.0 with isolated, single-thread execution.
- Three added Solidity reproductions passed, using actual local EntryPoint and PoolManager instances where relevant. Three server-level reproductions completed (relay trust, signature failure and indexer crash); an additional event-catalog check confirmed F-08. These assert vulnerable behavior, not post-fix safety.
- Selected existing web security/wallet regressions: **195 passes, one skipped test, zero failures across 15 scripts**. SDK: **8 passes**. Web lint passed with one existing image-performance warning; web TypeScript checking passed. The skipped paymaster case is not counted as validated live behavior.
- Indexer: **54 passes, one failed configuration fixture; typecheck passed**. Dependency advisory scan was completed against the locked production graph.
- The conclusive full Solidity run completed **645 tests with zero failures or skips**. The final validation note records a parallel-run anomaly and its resolution; do not infer full-suite success from the three added reproductions alone.
- No transactions were broadcast, no live service attacked, no secrets exposed, and no audited application source, original tests, dependency declarations, lockfiles or deployment flags changed. This Markdown report is the only tracked repository addition.

Security fixes and deployment configuration were not implemented: this task requested an audit. The remaining step is remediation followed by independent regression review and target-chain integration checks. Absence of a reported issue in another module is not a proof of safety.

## Validation completion note

The conclusive Forge 1.9.0 run using solc 0.8.26, `--isolate` and `--threads 1` completed **645 passes, zero failures, zero skips**. A preceding four-thread isolated run reported 644 passes and one generic `EvmError: Revert` in `DeployConfigTest.test_deployScriptWiring`; the same test passed immediately in a verbose isolated rerun, and the final single-thread full run passed. This appears to be parallel-run flakiness in the deployment-script test rather than a reproducible wiring failure, but CI should keep the deployment audit serialized or make its environment mutation concurrency-safe.
