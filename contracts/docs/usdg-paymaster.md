# Prepaid USDG gas — audit F-01

Owner decision: 2026-11-05, 4:58 / 5:00 PM CT. This supersedes the earlier sponsorship-off implementation in draft #246. Players pay gas in USDG; the paymaster supplies a reimbursable ETH float, not a grant. No live changes were made.

## Payment ordering and bounds

`DisciplePaymaster.PREPAY_VERSION == 3`:

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

**Unresolved activation gate — exact final gas pricing:** EntryPoint v0.7 passes cost to postOp BEFORE the callback and BEFORE final unused-gas penalty calculation (`test/vendor/aa-v07/core/EntryPoint.sol:703–730`). Its final `UserOperationEvent.actualGasCost` is emitted after postOp returns. The existing synchronous settlement still uses conservative callback/penalty estimates; removing rate markup does NOT make that final receipt-exact. Default settlement overhead / web callback limit is **79,552 = 2 × measured 39,776 callback gas**, not 200k. This is a safety reserve but currently also enters billing. It can overcharge relative to the final receipt. **This draft must not activate under an exact-cost promise.** A receipt-authenticated later reconciliation/refund, or explicit acceptance of estimated overhead, needs an owner design decision; no automatic keeper or new receipt signer was silently introduced. Exceptional stuck-precharge reconciliation already uses a trusted owner-provided final receipt cost, but is not a general exact-settlement mechanism.

The quote's price source remains existing TESTNET-only configuration. Rate bounds protect against corrupt/stale signed prices; they add no markup and do not prove USDG peg/oracle freshness. Treasury receives USDG, NOT ETH: conversion/refill of the ETH float remains a manual owner liquidity task. No keeper or minimum-large-float guard was added. Low float or fee spikes fail closed at EntryPoint prefund; a ~$1 float cannot guarantee arbitrary concurrency or gas prices. Stake capital is separate from the spendable float.

### Runtime measurements

`PaymasterRuntime.t.sol` uses the real vendored EntryPoint v0.7, pinned canonical MAv2 factory/implementation/SingleSigner bytecode, actual DISCIPLE USDG two-hop router, curve, migration, v4 manager and unchanged hook. Only ERC20 assets/oracle price are test fixtures. It begins with an undeployed USDG-only account; first op deploys, grants validation-time allowance, installs the session and buys. The paymaster deposit is only `1 ETH / 3000` (~$1 at the example rate); the account has zero ETH throughout. Every measured op must succeed. `UserOperationEvent.actualGasUsed` includes settlement and EntryPoint's unused-gas penalty; callback gas is read from the production runtime trace.

Production solc 0.8.26 calibration:

| Path | actualGasUsed | USDG at observed gas price and example 3,000 USDG/ETH (before base-unit rounding) |
| --- | ---: | ---: |
| Deploy + deferred allowance + session install + two-hop buy | 1,777,343 | 0.05332029 |
| Warm two-hop curve buy | 1,347,741 | 0.04043223 |
| Warm two-hop curve sell | 1,304,276 | 0.03912828 |
| Graduating two-hop buy (migration + LP/floor seed) | 3,534,356 | 0.10603068 |
| Warm two-hop v4 buy | 1,513,849 | 0.04541547 |
| Warm two-hop v4 sell | 1,390,219 | 0.04170657 |

Observed **Robinhood testnet eth_gasPrice = 10,000,000 wei = 0.01 gwei**, read-only RPC, **2026-11-05 5:11:27 PM CT**; chainId checked as 46630. The RPC URL/credentials were never printed or stored. At that price and the explicitly hypothetical 3,000 USDG/ETH conversion rate, the dynamic 2× cap is **0.21206136 USDG** (0.212062 rounded up for six decimals). This is an example, not a fixed cap or a live ETH/USD price. The default is trade-derived: launches above the limit now fail closed; increasing it for coin creation would require separate measurement/owner approval.

## USDG-only first operation

Canonical Alchemy MAv2 already has native **owner-authorized deferred actions** in its validation signature. `web/lib/aa/prepayBootstrap.ts` signs exactly `account.execute(USDG,0,approve(paymaster,uint256.max))` with EIP-712 chain/account domain and full nonce/deadline/call binding. The SDK executes this in ACCOUNT VALIDATION, after initCode deployment and **before paymaster validation**. It requires neither ETH on the account, a replacement factory, a separate approval transaction nor ERC-2612/1271 permit support.

The production web prepares this authorization off-tap during login/warm. Its existing owner-signed deploy/session-install operation uses USDG gas. Subsequent taps use the local session key and standing allowance. No additional transaction or wallet wait is added to warm taps. The Foundry `PaymasterBootstrap` test additionally combines deploy, native approval, real session installation and first buy in one operation, followed by a session-key buy. The account starts with only USDG and zero ETH throughout. A normal callData approval without the deferred authorization fails.

That test uses a real vendored EntryPoint v0.7 and pinned runtime bytecode of the deployed canonical Alchemy factory, semi-modular implementation and SingleSigner module. `test/fixtures/mav2-rht.json` records the public RH testnet block/source. Trade/token are mocks; this is not a live bundler acceptance or real-USDG blacklist test.

The repo's DevToken uses OpenZeppelin `ERC20Permit`, and the bootstrap mock exposes ordinary ERC20. Paxos USDG interfaces support permit (v2.1.0 adds bytes/ERC-1271 signatures), but that release does not prove the Robinhood deployment's version. An EOA permit is insufficient for smart-account-held funds; permit deadlines can also violate ERC-7562 timestamp rules. The chosen design avoids this dependency entirely.

## Bundler, staking and activation decisions

The code targets Alchemy Rundler on `robinhood-testnet.g.alchemy.com`; `/api/bundler` remains only a standard RPC proxy. Alchemy's external bundler fronts its own outer handleOps transaction and is reimbursed from the paymaster deposit; the player's USDG secures that deposit cost before execution. No protocol relayer, drip, custom sync method or automatic funding keeper is restored.

ERC-7562 permits the external token accesses only with the appropriate entity staking/storage associations. The paymaster returns context and uses shared storage: **it must be staked**. Alchemy also requires staked factories; the account's validation-time approval during deployment makes the canonical factory stake particularly relevant. Quote issuance checks paymaster readiness; the cold-estimate readiness guard checks both for bootstrap, active stake, no pending withdrawal and at least a one-day delay. Alchemy lists 0.1 ETH for many ETH chains, but omits Robinhood: the amount and canonical factory readiness are **OWNER / PROVIDER DECISIONS**, not guessed defaults. `PAYMASTER_MIN_STAKE_WEI` must be explicitly approved; no stake was posted. Deployment now REQUIRES a positive owner-supplied `PAYMASTER_STAKE_WEI` (no default), owner deployment/broadcast, and one-day delay. Nothing was broadcast or staked.

Owner decisions still open: confirm Robinhood's hosted Alchemy minimum stake (and canonical factory readiness), supply that amount and matching `PAYMASTER_MIN_STAKE_WEI`; choose exact-final-cost reconciliation design above; approve price source/rate bounds, treasury and manual float liquidity; deploy/bind the new v3 paymaster and matching immutable policy. Markup is decided: zero. Aggregate budget is decided: removed. No env/key/Vercel setting or live state was changed. Mainnet oracle/provider rollout remains out of scope. Existing live legacy paymaster code/deposits were not paused, withdrawn or migrated; its original F-01 exposure remains until separately authorized retirement.

Alchemy's published staking table omits Robinhood mainnet AND testnet. Its examples for other ETH chains (often 0.1 ETH) and ERC-7562's recommendations are NOT a confirmed Robinhood minimum. Alchemy explicitly publishes a **one-day minimum unstake delay**. Robinhood's docs identify Alchemy as its primary AA provider but publish no stake amount. Therefore the Robinhood stake amount is **unconfirmed, required owner/provider input**, not guessed. Alchemy's error reference documents `minimumStake` / `minimumUnstakeDelay` in applicable -32502 failures and -32505 for insufficient stake/delay; no live submission was made to discover them.

Sources opened during this work:
- https://ercs.ethereum.org/ERCS/erc-7562
- https://www.alchemy.com/docs/wallets/reference/bundler-faqs.md
- https://github.com/paxosglobal/usdg-contract/releases/tag/v2.1.0

- https://docs.robinhood.com/chain/account-abstraction/
- https://www.alchemy.com/docs/wallets/reference/bundler-rpc-errors.md
