# F-01 prepaid USDG gas / F-02 no public relayer

Owner decisions (2026-11-05, through 8:37 PM CT): keep one-tap and let players reimburse ETH gas in **prepaid USDG**. This updates the SAME draft #246, not a stacked PR. The earlier bring-ETH-only plan is superseded; draft #245's public-relayer auth hardening is superseded by disabling that relayer.

## Exactly what an AA tap does

1. Login derives the same canonical MAv2 address. Read-only warmup prepares a native owner-authorized deferred USDG approval when no standing maximum allowance exists. Nothing funds the account with ETH.
2. Existing background one-tap setup sends one owner-signed operation: initCode deploys the account if necessary; native account validation executes the narrowly bound USDG approval; paymaster validation then collects the operation's required maximum USDG prefund (not a reusable quote's larger consent ceiling); execution installs the session. The account needs USDG for gas AND trade, not ETH. Foundry also proves deploy/install/first buy combined in one operation, then a real session-key second buy.
3. Warm taps select the browser's session key, reserve trade cash + signed USDG gas cap synchronously, allocate independent nonce keys, and build/sign locally. Cached signed sender allowances make **zero pm_* requests and zero chain reads before submission**. Factory/deferred operations never reuse operation templates; each warm template overwrites all quote fields. Cold/launch/graduation quotes may require estimates; real SDK estimates carry paymaster data before simulation, avoiding an ETH-less AA21 simulation.
4. `/api/paymaster` signs only bounded player-paid USDG quotes, requiring balance and standing allowance or the exact native owner-validation approval shape. This shape check is NOT signature authentication; the real account verifies it and the real paymaster always collects actual USDG. A forged shape cannot obtain free gas.
5. Browser posts standard `eth_sendUserOperation` through `/api/bundler` to the external Alchemy bundler. Alchemy submits handleOps with its own EOA; EntryPoint reimburses it from the paymaster's ETH deposit, already collateralized in player USDG. The protocol's EOA does not submit or front the userOp transaction. No working/staked external provider means fail closed, not fallback to protocol gas.
6. postOp settles treasury and refunds unused collateral; unsuccessful token transfers become backed credits. Exceptional callback failure retains all collateral for paused, delayed, trusted owner reconciliation. See [contract design](../../contracts/docs/usdg-paymaster.md).

There is still NO USDG-to-native-ETH converter inside the buy, and none is necessary for this ordering. The account never needs prefund ETH. The paymaster ETH float is reimbursed in USDG, not automatically swapped back to ETH. Owner-managed conversion/refill and price accuracy are liquidity/economic prerequisites, not protocol sponsorship.

## What stays off

- `/api/drip`: unconditional 410; no account deployment/login/failure ETH refill.
- Public fast/standard self-bundlers and stream entry points: reject before fetching or signing. Custom `disciple_*` and external sponsorship RPCs remain rejected.
- No private relayer fallback on upstream auth/network errors or stale `AA_SELF_BUNDLER` flags. No automatic paymaster funding keeper.
- Legacy/unknown paymasters cannot be attached. Embedded accounts without explicit prepaid configuration cannot silently switch to bring-ETH gas, but read-only login/address/signature functions still work.
- Mainnet deployment/quote support is not introduced. No v4 market hook changes.

## Latency / rollout decisions / residual risks

- No extra wait/prompt/approval transaction on warm taps. The former 10M launch call limit OOG'd on valid warm launches with richer metadata; ONLY the launch envelope is raised to the measured budget. First deployment/session install retains the existing setup wait, now payable from USDG. External queue/inclusion and receipt polling replace the former one-response sync relayer: provider latency is not proven equivalent. Alchemy documents unstaked-account parallel-nonce limits; GAME's three in-flight operations still need provider confirmation/simulation.
- Staked paymaster AND canonical factory, at least one-day delay, are required. Lee approved approximately $5 of ETH as the starting paymaster stake: the deploy operator supplies positive `PAYMASTER_STAKE_WEI` at the deploy-time ETH/USD price, with no invented ETH price or default wei amount. Robinhood's Alchemy minimum remains unconfirmed and $5 may be rejected; owner-only `addStake` is additive and can top up later. Unlock makes the entity unstaked immediately; withdrawal requires waiting the delay. No staking/unlock/withdrawal transaction was made. Canonical factory readiness and ERC-7562 provider acceptance remain unverified live.
- Gas-rate markup is **zero**, with **no aggregate exposure budget**. Trade cap stays 7,068,712 gas units; launches use a separate **21,840,770 gas-unit limit = 2 × measured worst 10,920,385**, both scaled by signed maxFeePerGas and rate (never a fixed USDG cap). The distinct exact-op launch signature is issued only for configured launch targets/selectors/batches; cached trade allowances never escalate. The 79,684 settlement budget is exactly 2× the newly measured 39,842 callback. Lee accepted conservative estimate-based settlement rounded UP to a USDG base unit; receipt-exact billing is not an activation blocker. Owner approval remains for rate bounds/testnet price input, manual ETH float/treasury conversion and actual deployment. New policy **1.4.2**, v4 paymaster, matching immutable address/module config and session reinstall are required. No config changed in this PR.
- Existing deployed legacy paymasters/deposits are NOT deactivated by source changes. No live pause/withdraw/unstake was performed. They retain the old F-01 risk if accessed directly; retirement needs a separate owner-approved action. New source must never reactivate those contracts.
- USDG blacklist/pause/upgrade/depeg, signer/admin control, stale rate, token transfer gas changes and trusted exceptional recovery are residual risks. Unlimited standing allowance is granted only to the non-upgradeable configured paymaster through exact owner authorization, not arbitrary session calls.
- Non-AA protocol maintenance/attestation/test-mint jobs may still spend operational gas; no userOp relay/drip is among them.

No new product copy in this update; existing plain unavailable/insufficient-USDG messages are reused. The earlier #246 help-copy deletion remains unchanged.

## Tests

Full Foundry suites run with production solc 0.8.26 and Solar, serial isolated mode (production suite split by test directories for memory). `PaymasterDebt` now asserts a fixed pre-execution precharge, including same-batch approval and revocation/drain/revert attacks. Added real EntryPoint/canonical MAv2 first-trade proof and gas/return-data grief/exceptional recovery coverage. Web tests cover quote/hash/payment caps, native bootstrap binding, zero-markup/stake gates, no relayer/drip fallback, warm USDG taps, synchronous reserves, bounded estimators and rapid-tap/retry. Read-only canonical address/ERC-6492 check is separate from live transaction e2e, which was NOT run.
