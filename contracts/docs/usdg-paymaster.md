# Prepaid USDG gas — audit F-01

Owner decision: 2026-11-05, 4:08 PM CT. This supersedes the earlier sponsorship-off implementation in draft #246. Players pay gas in USDG; the paymaster supplies a reimbursable ETH float, not a grant. No live changes were made.

## Payment ordering and bounds

`DisciplePaymaster.PREPAY_VERSION == 2`:

1. EntryPoint validates/deploys the account, then calls paymaster validation.
2. Verify the signed quote/allowance, rate bounds, maximum one-hour quote window, `maxCostCap`, owner pause, minimum postOp gas and global outstanding exposure limit. The signed maximum must cover EntryPoint's maximum ETH prefund converted at the signed, marked-up USDG/ETH rate.
3. Require account balance and a **pre-existing ERC20 allowance**. `transferFrom` the full signed `maxTokenCost`, verifying the actual balance increase. Record collateral by userOp hash and sender, with an exact context commitment. Only then may execution begin.
4. `postOp` pays treasury from collateral and returns the remainder to the account, for successful or reverted user calls. It NEVER collects from the account after execution. Revoking approval, draining remaining USDG, reverting the buy, replaying a quote or concurrent nonces cannot create unsecured gas debt.

The leading `approve(paymaster,uint256.max)` in execution is only a session-accounting marker and replenishment, not security for the current operation. Policy **1.4.2** debits the signed gas cap, not uint256.max. Its immutable paymaster must match the new contract. Existing policy addresses/old sessions must not be silently reused.

Each treasury/refund transfer has a 75k gas budget and copies at most one return word. Failure records a fully backed `creditOf(recipient)`; anyone can retry `claimCredit`, but funds always go to that recipient. Credits are not unsecured debt. Fee-on-transfer precharges are rejected. Token blacklist/pause/upgrade risk remains.

EntryPoint v0.7 does **not** retry a failing callback with `postOpReverted`. If postOp unexpectedly reverts/OOG, validation collateral survives; user execution is rolled back and no USDG is released. After quote expiry + one day, while paused, the owner can call `settleStuckPrecharge` with the exact committed context and FINAL cost from `UserOperationEvent`. It cannot change the committed sender/rate/maximum or settle twice. This is explicitly trusted, publicly emitted administrative reconciliation, not an on-chain proof of receipt cost.

Settlement includes configured conservative postOp overhead and the v0.7 unused-execution-gas penalty estimate, bounded by collateral. `postOpGas` deployment default is 200k and the web readiness guard rejects lower values. Owner must calibrate overhead, markup and price bounds with the real token/provider before activation; tests demonstrate reimbursement, not an economic guarantee against stale oracle/configuration or USDG depeg. No ETH replenishment swap is run automatically: treasury receives USDG; the float's conversion/refill is an owner-operated liquidity task.

## USDG-only first operation

Canonical Alchemy MAv2 already has native **owner-authorized deferred actions** in its validation signature. `web/lib/aa/prepayBootstrap.ts` signs exactly `account.execute(USDG,0,approve(paymaster,uint256.max))` with EIP-712 chain/account domain and full nonce/deadline/call binding. The SDK executes this in ACCOUNT VALIDATION, after initCode deployment and **before paymaster validation**. It requires neither ETH on the account, a replacement factory, a separate approval transaction nor ERC-2612/1271 permit support.

The production web prepares this authorization off-tap during login/warm. Its existing owner-signed deploy/session-install operation uses USDG gas. Subsequent taps use the local session key and standing allowance. No additional transaction or wallet wait is added to warm taps. The Foundry `PaymasterBootstrap` test additionally combines deploy, native approval, real session installation and first buy in one operation, followed by a session-key buy. The account starts with only USDG and zero ETH throughout. A normal callData approval without the deferred authorization fails.

That test uses a real vendored EntryPoint v0.7 and pinned runtime bytecode of the deployed canonical Alchemy factory, semi-modular implementation and SingleSigner module. `test/fixtures/mav2-rht.json` records the public RH testnet block/source. Trade/token are mocks; this is not a live bundler acceptance or real-USDG blacklist test.

The repo's DevToken uses OpenZeppelin `ERC20Permit`, and the bootstrap mock exposes ordinary ERC20. Paxos USDG interfaces support permit (v2.1.0 adds bytes/ERC-1271 signatures), but that release does not prove the Robinhood deployment's version. An EOA permit is insufficient for smart-account-held funds; permit deadlines can also violate ERC-7562 timestamp rules. The chosen design avoids this dependency entirely.

## Bundler, staking and activation decisions

The code targets Alchemy Rundler on `robinhood-testnet.g.alchemy.com`; `/api/bundler` remains only a standard RPC proxy. Alchemy's external bundler fronts its own outer handleOps transaction and is reimbursed from the paymaster deposit; the player's USDG secures that deposit cost before execution. No protocol relayer, drip, custom sync method or automatic funding keeper is restored.

ERC-7562 permits the external token accesses only with the appropriate entity staking/storage associations. The paymaster returns context and uses shared storage: **it must be staked**. Alchemy also requires staked factories; the account's validation-time approval during deployment makes the canonical factory stake particularly relevant. Quote issuance checks paymaster readiness; the cold-estimate readiness guard checks both for bootstrap, active stake, no pending withdrawal and at least a one-day delay. Alchemy lists 0.1 ETH for many ETH chains, but omits Robinhood: the amount and canonical factory readiness are **OWNER / PROVIDER DECISIONS**, not guessed defaults. `PAYMASTER_MIN_STAKE_WEI` must be explicitly approved; no stake was posted. Optional deployment-script stake path exists, with one-day delay.

Other owner decisions: new paymaster + policy deployment/binding; explicit positive `PAYMASTER_MARKUP_BPS`; price source/rate bounds (current existing env-based source is TESTNET ONLY); per-op cap (script default 10 USDG), global exposure (starts at one cap; configure for concurrent users), treasury, ETH float and conservative settlement overhead. No env or key was changed. The guard rejects legacy paymasters, paused contracts, wrong token/EntryPoint, insufficient settlement overhead and unstaked entities. Mainnet oracle/provider rollout is not implemented here.

Sources opened during this work:
- https://ercs.ethereum.org/ERCS/erc-7562
- https://www.alchemy.com/docs/wallets/reference/bundler-faqs.md
- https://github.com/paxosglobal/usdg-contract/releases/tag/v2.1.0
