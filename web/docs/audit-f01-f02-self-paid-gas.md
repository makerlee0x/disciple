# F-01 / F-02: self-paid gas only

## Scope and disabled paths

Owner decision, 2026-11-05: no sponsorship on testnet or mainnet. This supersedes the stopped prepay/circuit-breaker attempt and draft #245's relay-auth design. Legacy paymaster/session-policy contracts remain unchanged from main; no hook changes.

- `/api/paymaster` and `/api/drip`: unconditional HTTP 410; no quote, signer, top-up, RPC, or env dependency.
- MAv2/session: removed paymaster config, quotes, allowance caches, gas approvals, paymaster attachment, custom sync relay and server warm requests. Removed login/deploy/failure ETH refills. All chain paymasters are zero regardless of stale public env.
- Gas policy, legacy client and proxy: reject sponsorship RPCs and packed/split paymaster fields. Browser and GAME USDG gas reserves are zero.
- `/api/bundler`: standard external-bundler proxy only. Missing key, upstream 401, network failure and old self-relay flags never trigger protocol signing/funding. Fast/standard self-bundler and streaming public entry points reject; userOp handleOps signing/broadcast code is deleted.
- Deleted quote/deposit/signer/wire modules and funding keeper. `DeployPaymaster.run()` always reverts before env/broadcast/deploy/deposit/stake. Future session policies use paymaster zero; redeploy postprocessing never records a new paymaster. Historical sponsored anonymous-launch smoke entry point also fails closed.

## Exact AA tap / funding / submission trace

1. `aaSend` still checks session policy and pending spend, chooses the browser-held one-tap session key and calls MAv2 `sendCalls`. Session installation/renewal is an owner-signed, **user-paid** operation.
2. Parallel nonce cursor, warmed fee/gas caches, execution-prefix memoization and operation templates remain. A warm tap builds/signs locally and submits standard `eth_sendUserOperation`; cold/launch/graduation uses SDK estimate/send. No new gas approval, signature prompt, sponsorship request or deliberate wait is added to taps. Definite validation errors can retry once; ambiguous sends never resend.
3. Default `/api/bundler` forwards standard ERC-4337 methods to the existing Alchemy RH-testnet endpoint using the server-only key. The **external bundler** submits EntryPoint `handleOps`, fronts its own outer transaction and receives reimbursement from the user's prefund. The protocol never submits it. A separately configured browser bundler URL remains possible but self-paid. No user-EOA fallback was added. No working external provider means AA unavailable, not protocol-funded.
4. With no paymaster, EntryPoint validation needs the smart account's **existing native ETH and/or EntryPoint deposit**. Its account validation pays `missingAccountFunds` before calls execute; actual gas is charged and unused prefund remains/refunds to its EntryPoint deposit.
5. Confirmation uses external bundler/chain receipt polling: SDK interval 250 ms; warm signed-op chain lookup existing 170 ms cadence. Provider queue/inclusion and extra receipt round trips replace one-response sync relay. Old latency cannot be promised; no extra wait timer/refill is introduced.

## Critical bootstrap mismatch

There is **no implemented native USDG-to-ETH gas replenishment inside the current buy**. `protocol-viem` emits ERC20 approval + `DiscipleRouter.buyWithUsdg`; router USDG hops buy ERC20 pair tokens and do not unwrap/pay native ETH into the sender's prefund.

An ETH-less smart account cannot deploy/install/trade under the no-sponsorship rule until the **user** funds its counterfactual/account address with native ETH or an EntryPoint deposit. USDG holdings alone are insufficient. Even a new conversion during execution could fund only future ops: the current operation's prefund is required first. The old paymaster/drip masked this gap; both are removed. A seamless zero-ETH USDG-only first trade is **not solved by this PR**. No converter/router redesign or transaction was introduced.

## Owner decisions / residual risks

- Decide user-funded native-ETH onboarding and, separately, any replenishment/conversion design. Existing generic prefund/setup error copy is unchanged; owner-approved funding guidance is still needed.
- Confirm an external bundler supports this chain, MAv2/session policy, estimates/limits and desired latency. Mocked tests prove local signing/routing, not live inclusion. No live transactions were sent. Mainnet AA availability remains unchanged (currently testnet-only).
- Existing deployed/funded paymasters are **not deactivated on-chain by this PR**. No pause/withdraw/unstake/key/env action was authorized. Existing signed quotes may remain usable until their encoded expiry; callers can bypass web routes. The unchanged legacy F-01 contract must never be re-enabled/funded. `PaymasterDebt.t.sol` intentionally demonstrates its historical unpaid debt as non-deployed-contract coverage, not a hardening claim.
- Draft #245 is superseded by this combined disable change; do not merge its auth-hardening approach as the relay plan.
- Retained `sendWithRelayerNonce` is for non-AA protocol jobs (pricer maintenance, PVE attestations, test-token mint), not public userOp bundling or ETH top-ups. Their protocol transaction costs remain; this is not a claim of zero protocol operational gas expenditure.

## User-facing copy

Only removed the misleading second sentence from existing help: `You hold your own keys. Gas is paid in USDG, so no ETH is needed.` becomes `You hold your own keys.` No new product copy.

## Verification intent

Disabled-service tests prove no fetch/sign/quote at retired endpoints, no reactivation by old flags, no fallback on absent/auth-failed/unreachable external provider, rejection of all sponsorship encodings, and local warm session signing via standard submission. ETH-less bootstrap fails without requesting a top-up. Deployment tests reject mainnet/testnet/local alike. Historical PaymasterDebt intentionally records the legacy exploit.
