# Prepaid USDG gas — audit F-01

Owner decision: 2026-11-05, 4:58 / 5:00 / 8:37 PM CT. This supersedes the earlier sponsorship-off implementation in draft #246. Players pay gas in USDG; the paymaster supplies a reimbursable ETH float, not a grant. No live changes were made.

## Payment ordering and bounds

`DisciplePaymaster.PREPAY_VERSION == 4`:

1. EntryPoint validates/deploys the account, then calls paymaster validation.
2. Verify the signed quote/allowance, rate bounds, maximum one-hour quote window, `maxGasPerOp`, owner pause and minimum postOp gas. The signed token ceiling must cover EntryPoint's maximum ETH prefund converted at the unchanged price-source rate (1.0x; no markup).
3. Require account balance and a **pre-existing ERC20 allowance**. `transferFrom` the operation's required maximum cost, NOT the reusable quote's larger token ceiling, verifying the actual balance increase. Record collateral by userOp hash and sender, with an exact context commitment. Only then may execution begin.
4. `postOp` pays treasury from collateral and returns the remainder to the account, for successful or reverted user calls. It NEVER collects from the account after execution. Revoking approval, draining remaining USDG, reverting the buy, replaying a quote or concurrent nonces cannot create unsecured gas debt.

The leading `approve(paymaster,uint256.max)` in execution is only a session-accounting marker and replenishment, not security for the current operation. Policy **1.4.2** debits the signed gas cap, not uint256.max. Its immutable paymaster must match the new contract. Existing policy addresses/old sessions must not be silently reused.

Each treasury/refund transfer has a 75k gas budget and copies at most one return word. Failure records a fully backed `creditOf(recipient)`; anyone can retry `claimCredit`, but funds always go to that recipient. Credits are not unsecured debt. Fee-on-transfer precharges are rejected. Token blacklist/pause/upgrade risk remains.

EntryPoint v0.7 does **not** retry a failing callback with `postOpReverted`. If postOp unexpectedly reverts/OOG, validation collateral survives; user execution is rolled back and no USDG is released. After quote expiry + one day, while paused, the owner can call `settleStuckPrecharge` with the exact committed context and FINAL cost from `UserOperationEvent`. It cannot change the committed sender/rate/maximum or settle twice. This is explicitly trusted, publicly emitted administrative reconciliation, not an on-chain proof of receipt cost.

### Dynamic limit, no aggregate budget

The deploy default is **7,068,712 gas units = 2 × 3,534,356 measured gas**. Validation sums account verification + call + preVerification + paymaster verification + paymaster postOp limits and rejects above this. Its ETH ceiling is `maxGasPerOp × uint128(op.gasFees)` (the signed maxFeePerGas). USDG maximum is `ceil(ETH ceiling × signed USDG/ETH rate / 1e18)`. The actual validation precharge uses the op's own EntryPoint maximum prefund, not the whole gas-unit ceiling. PostOp uses the effective gas price supplied by EntryPoint. No static USDG cap or new gas-price sanity ceiling exists. No exposure counter, aggregate budget or aggregate-budget setter remains; `reservedOf` only accounts for each sender's secured collateral.

A cached quote can authorize a larger token ceiling than the current dynamic limit: that ceiling is consent, never the collected amount. This preserves warm, zero-extra-RPC taps when gas prices fall. Session policy 1.4.2 conservatively debits the signed ceiling; it does not overcharge tokens.

**Owner-accepted estimated settlement (8:37 PM CT):** EntryPoint v0.7 passes cost to postOp BEFORE the callback and BEFORE final unused-gas penalty calculation (`test/vendor/aa-v07/core/EntryPoint.sol:703–730`). The callback therefore uses a conservative callback/penalty estimate, not receipt-exact billing. Settlement overhead / web callback limit is **79,684 = 2 × the newly measured 39,842-gas cold callback**, not 200k. Zero markup means the signed price-source rate is unchanged; it does not remove the small estimated gas overcharge. Lee explicitly accepted this estimate and rounding **UP to one USDG base unit** (0.000001 USDG for a six-decimal token), not up to a whole dollar. The callback budget was recalibrated for the v4 dispatcher (the preceding callback baseline was 39,776). Measured launch settlement overcharge is **0.00231666–0.00316335 USDG** at the observed 0.01 gwei and EXAMPLE 3,000 USDG/ETH, before six-decimal rounding. No exact-billing activation block or general receipt-refund keeper remains. Exceptional stuck-precharge reconciliation still uses a trusted owner-provided final receipt cost.

The quote's price source remains existing TESTNET-only configuration. Rate bounds protect against corrupt/stale signed prices; they add no markup and do not prove USDG peg/oracle freshness. Treasury receives USDG, NOT ETH: conversion/refill of the ETH float remains a manual owner liquidity task. No keeper or minimum-large-float guard was added. Low float or fee spikes fail closed at EntryPoint prefund; a ~$1 float cannot guarantee arbitrary concurrency or gas prices. Stake capital is separate from the spendable float.

### Runtime measurements

`PaymasterRuntime.t.sol` uses the real vendored EntryPoint v0.7, pinned canonical MAv2 factory/implementation/SingleSigner bytecode, actual DISCIPLE USDG two-hop router, curve, migration, v4 manager and unchanged hook. Only ERC20 assets/oracle price are test fixtures. It begins with an undeployed USDG-only account; first op deploys, grants validation-time allowance, installs the session and buys. The paymaster deposit is only `1 ETH / 3000` (~$1 at the example rate); the account has zero ETH throughout. Every measured op must succeed. `UserOperationEvent.actualGasUsed` includes settlement and EntryPoint's unused-gas penalty; callback gas is read from the production runtime trace.

Preceding production solc 0.8.26 **trade** calibration (retained because the owner explicitly kept the trade cap unchanged):

| Path | actualGasUsed | USDG at observed gas price and example 3,000 USDG/ETH (before base-unit rounding) |
| --- | ---: | ---: |
| Deploy + deferred allowance + session install + two-hop buy | 1,777,343 | 0.05332029 |
| Warm two-hop curve buy | 1,347,741 | 0.04043223 |
| Warm two-hop curve sell | 1,304,276 | 0.03912828 |
| Graduating two-hop buy (migration + LP/floor seed) | 3,534,356 | 0.10603068 |
| Warm two-hop v4 buy | 1,513,849 | 0.04541547 |
| Warm two-hop v4 sell | 1,390,219 | 0.04170657 |

Observed **Robinhood testnet eth_gasPrice = 10,000,000 wei = 0.01 gwei**, read-only RPC, **2026-11-05 9:11:01 PM CT**; chainId checked as 46630. The RPC URL/credentials were never printed or stored. At that price and the explicitly hypothetical 3,000 USDG/ETH conversion rate, the dynamic 2× cap is **0.21206136 USDG** (0.212062 rounded up for six decimals). This is an example, not a fixed cap or a live ETH/USD price. The **trade** limit remains unchanged; launches have the separately measured launch limit below.

### Separate launch budget — owner approved 8:37 PM CT

Default **`maxLaunchGasPerOp = 21,840,770 gas units = 2 × 10,920,385`**. The trade default stays **7,068,712**; no aggregate budget or fixed USDG cap returns. A dedicated **`DisciplePaymaster.LaunchQuote(v1)`** domain authorizes the launch tier, binding the entire operation (sender, nonce, initCode, calldata, account/paymaster gas limits, PVG, fees), quote window, rate, chain and paymaster. Ordinary op quotes and reusable trade allowances ALWAYS retain the trade limit. The quote service issues the launch domain only for configured launch targets/selectors, approvals, LoginGate attestations and optional **self-targeted** session installation. Unknown targets or extra arbitrary calls do not qualify. Classification is an explicit responsibility of the existing trusted quote signer, not a new on-chain target registry. Quote wire remains 193 bytes; v4 readiness rejects legacy paymasters. Owner can set the launch limit to zero to disable launch-tier quotes.

For either tier: `dynamicMaxUSDG = ceil(tierGasUnits × signed userOp.maxFeePerGas × unmarked rate / 1e18)`. Validation precharges only the op's required maximum prefund within that ceiling, and postOp uses EntryPoint's effective fee plus the accepted conservative settlement estimate. No new gas-price ceiling was invented. Larger launch gas is NOT a sponsorship allowance.

`PaymasterLaunchRuntime.t.sol` measures **25 launch configurations × bootstrap/warm = 50 successful real EntryPoint operations**. It combines the canonical MAv2 runtime, actual Launchpad/AnonLauncher/USDG router/QuotePricer/curve deployment, session policy and a stateless ERC-5564 announcement-event fixture. ERC20 assets, the **EXAMPLE** price and stateless announcer are fixtures; this is not live bundler acceptance. The account always has zero ETH; public USDG-router launches need only USDG. Legacy direct/private pair-denominated First BOOST requires existing pair tokens, as the current client already does. Bootstrap includes account deployment, native allowance approval, session installation, and the launch; Easy includes its login attestation. Warm launches are genuinely session-key signed and can cost MORE because execution-policy checks also run. First BOOST is 1,000 quote/USDG units, covering mode caps/partial-fill/refund paths; metadata is a valid 31-byte name, 10-byte ticker, 96-byte image, 512-byte description, 256-byte socials, and anonymous cases include a conservative 64-byte announcement payload. These are **worst measured supported fixtures**, not a claim that arbitrarily long metadata or future contracts have a finite universal worst-case. The runtime test fails if any path exceeds the calibrated worst; future changes require review/recalibration.

Both first and warm operations use 500k account validation, 100k PVG, 250k paymaster validation, **14M call gas**, and 79,684 postOp gas. The former web 10M-call envelope OOG'd on several valid warm session launches with these metadata fields; its launch-only call/total envelope now follows the measured budget (20,840,770 call / 21,840,770 total). Trade/graduation envelopes and zero-extra-RPC warm taps are unchanged. Every operation asserts success, zero account ETH, no gas debt and a paymaster gas bill at least its final EntryPoint receipt cost. The float remains only `1 ETH / 3000` (~$1 at the EXAMPLE fixture price), without a keeper.

Production solc 0.8.26 `UserOperationEvent.actualGasUsed` (includes settlement and unused-gas penalty):

| Launch path | Deploy + approve + install + launch | Warm session launch |
| --- | ---: | ---: |
| `directEasyBoostPair` | 9,374,310 | 9,744,902 |
| `directEasyBoostUsdg` | 9,217,006 | 10,505,288 |
| `directEasyNoBoostUsdg` | 8,691,299 | 9,102,215 |
| `directHardBoostPair` | 9,270,858 | 9,669,925 |
| `directHardBoostUsdg` | 9,113,553 | 10,430,311 |
| `directHardNoBoostUsdg` | 8,635,083 | 9,078,524 |
| `directTrenchBoostPair` | 9,252,746 | 9,651,813 |
| `directTrenchBoostUsdg` | 9,095,442 | 10,412,199 |
| `directTrenchNoBoostUsdg` | 8,616,972 | 9,060,412 |
| `launchAnonBoostPair` | 9,413,731 | 10,920,385 |
| `launchAnonBoostUsdg` | 9,233,034 | 10,737,780 |
| `launchAnonNoBoostPair` | 8,839,901 | 10,366,240 |
| `launchAnonNoBoostUsdg` | 8,686,916 | 10,237,661 |
| `launchWithUsdgEasyBoostTwoHop` | 9,562,589 | 9,769,402 |
| `launchWithUsdgEasyBoostUsdg` | 9,302,690 | 9,520,294 |
| `launchWithUsdgEasyNoBoostTwoHop` | 8,863,547 | 8,710,354 |
| `launchWithUsdgEasyNoBoostUsdg` | 8,710,562 | 8,581,702 |
| `launchWithUsdgHardBoostTwoHop` | 9,458,571 | 9,695,099 |
| `launchWithUsdgHardBoostUsdg` | 9,199,236 | 9,445,316 |
| `launchWithUsdgHardNoBoostTwoHop` | 8,807,331 | 8,686,662 |
| `launchWithUsdgHardNoBoostUsdg` | 8,654,346 | 8,558,011 |
| `launchWithUsdgTrenchBoostTwoHop` | 9,440,390 | 9,676,750 |
| `launchWithUsdgTrenchBoostUsdg` | 9,181,125 | 9,427,205 |
| `launchWithUsdgTrenchNoBoostTwoHop` | 8,789,220 | 8,668,550 |
| `launchWithUsdgTrenchNoBoostUsdg` | 8,636,235 | 8,539,899 |

At the read-only **Robinhood testnet** `eth_gasPrice` observation above (0.01 gwei), and explicitly **EXAMPLE 3,000 USDG/ETH**, worst launch receipt gas converts to **0.32761155 USDG** and the 2× launch ceiling to **0.65522310 USDG**, or **0.655224** with six-decimal ceil. This is NOT a live ETH/USD price or a fixed USDG cap. It assumes the signed fee equals that observed gas price; browser fee headroom can raise the maximum prefund/ceiling, while settlement uses the effective price. A ~$1 float can therefore reject a heavy launch at buffered fees or high concurrency; the code fails closed rather than assuming or silently supplying a larger float. Actual float sizing and manual conversion/refill remain owner liquidity operations. Stake is separate and cannot pay gas.

## USDG-only first operation

Canonical Alchemy MAv2 already has native **owner-authorized deferred actions** in its validation signature. `web/lib/aa/prepayBootstrap.ts` signs exactly `account.execute(USDG,0,approve(paymaster,uint256.max))` with EIP-712 chain/account domain and full nonce/deadline/call binding. The SDK executes this in ACCOUNT VALIDATION, after initCode deployment and **before paymaster validation**. It requires neither ETH on the account, a replacement factory, a separate approval transaction nor ERC-2612/1271 permit support.

The production web prepares this authorization off-tap during login/warm. Its existing owner-signed deploy/session-install operation uses USDG gas. Subsequent taps use the local session key and standing allowance. No additional transaction or wallet wait is added to warm taps. The Foundry `PaymasterBootstrap` test additionally combines deploy, native approval, real session installation and first buy in one operation, followed by a session-key buy. The account starts with only USDG and zero ETH throughout. A normal callData approval without the deferred authorization fails.

That test uses a real vendored EntryPoint v0.7 and pinned runtime bytecode of the deployed canonical Alchemy factory, semi-modular implementation and SingleSigner module. `test/fixtures/mav2-rht.json` records the public RH testnet block/source. Trade/token are mocks; this is not a live bundler acceptance or real-USDG blacklist test.

The repo's DevToken uses OpenZeppelin `ERC20Permit`, and the bootstrap mock exposes ordinary ERC20. Paxos USDG interfaces support permit (v2.1.0 adds bytes/ERC-1271 signatures), but that release does not prove the Robinhood deployment's version. An EOA permit is insufficient for smart-account-held funds; permit deadlines can also violate ERC-7562 timestamp rules. The chosen design avoids this dependency entirely.

## Bundler, staking and activation decisions

The code targets Alchemy Rundler on `robinhood-testnet.g.alchemy.com`; `/api/bundler` remains only a standard RPC proxy. Alchemy's external bundler fronts its own outer handleOps transaction and is reimbursed from the paymaster deposit; the player's USDG secures that deposit cost before execution. No protocol relayer, drip, custom sync method or automatic funding keeper is restored.

ERC-7562 permits the external token accesses only with the appropriate entity staking/storage associations. The paymaster returns context and uses shared storage: **it must be staked**. Alchemy also requires staked factories; the account's validation-time approval during deployment makes the canonical factory stake particularly relevant. Quote issuance checks paymaster readiness; the cold-estimate readiness guard checks both entities for bootstrap, active stake, no pending withdrawal and at least a **one-day delay**. Robinhood's Alchemy stake amount is still **unconfirmed**: Robinhood is absent from Alchemy's published mainnet AND testnet tables. Amounts for other chains are NOT a Robinhood requirement.

### Owner-approved starting stake: approximately $5 of ETH

`DeployPaymaster.s.sol` requires a positive **`PAYMASTER_STAKE_WEI`**, with **no invented default ETH amount or ETH/USD price**. The operator calculates `ceil(5 × 10^18 / deploy-time ETH price in USD)` wei and supplies that value. This is separate from the tiny spendable ETH float (about $1 initially). No env, stake, deposit, unlock or withdrawal was performed in this PR. Set the readiness threshold `PAYMASTER_MIN_STAKE_WEI` to the owner-approved starting amount; it checks local readiness, NOT proof of Alchemy acceptance. **$5 may be rejected by the external bundler.** Confirm its requirement with Alchemy; the remedy for insufficient amount is a later owner-authorized top-up, not a protocol relay or sponsorship fallback.

The owner-only paymaster wrapper `addStake(uint32)` forwards `msg.value` to EntryPoint. Vendored `StakeManager.addStake` computes **existing stake + msg.value**, so top-ups are additive, with the same or a longer delay. It also cancels any pending unlock and re-locks the total. `unlockStake()` starts the delay and immediately makes the entity unstaked (quotes fail closed). After the delay, owner-only `withdrawStake(to)` withdraws the full stake. To reduce stake, unlock, wait, withdraw, then re-stake; do not do that during normal service. These mechanics are tested against the real EntryPoint. Unit fixture amounts are NOT deployment recommendations.

Remaining rollout decisions: confirm Alchemy's minimum and canonical factory readiness, choose the **deploy-time ETH price and corresponding ~$5 stake wei**, approve price source/rate bounds, treasury and manual float liquidity, and deploy/bind the new **v4** paymaster with matching immutable session policy. Markup is zero; aggregate budget is removed; estimated ceil settlement is accepted; trade and launch caps are measurement-derived. No gas-price sanity ceiling or automatic keeper was added. Mainnet oracle/provider rollout remains out of scope. Existing live legacy paymaster code/deposits were not paused, withdrawn or migrated; its original F-01 exposure remains until separately authorized retirement.

Alchemy explicitly publishes a **one-day minimum unstake delay**. Robinhood's docs identify Alchemy as the primary AA provider but publish no stake amount. Alchemy's error reference documents `minimumStake` / `minimumUnstakeDelay` in applicable -32502 failures and -32505 for insufficient stake/delay; no live submission was made to discover them.

Sources opened during this work:
- https://ercs.ethereum.org/ERCS/erc-7562
- https://www.alchemy.com/docs/wallets/reference/bundler-faqs.md
- https://github.com/paxosglobal/usdg-contract/releases/tag/v2.1.0

- https://docs.robinhood.com/chain/account-abstraction/
- https://www.alchemy.com/docs/wallets/reference/bundler-rpc-errors.md
