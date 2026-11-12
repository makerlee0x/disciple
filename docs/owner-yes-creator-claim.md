# Owner-yes claim for normal rocket creators

Lee approved this plan on Nov 12, 2026 at 12:21 AM CT. A creator of a normal (not private) rocket must be able to claim their fees in the app. Today the app skips them when it claims for free (gasless), because the fee contracts only pay the wallet that calls them, and our relayer is the caller.

## What already exists (reused, not rewritten)

1. **Private launches sign a yes and the relayer submits it.** `AnonLauncher.claimManyBySig` and `CurveFeeVault.claimManyAsStealthBySig` take an EIP-712 `Claim(address owner,address[] tokens,address to,uint256 relayerFeeBps,uint256 nonce,uint256 deadline)` signed by the owner, and the gasless relayer submits it. This draft uses the same `Claim` struct and the same rules (deadline, per-owner nonce, relayer fee of at most 5%, an empty token list only uses up the nonce).
2. **The fee contracts already let an approved claim router pull a creator's fees.** `FeeRouter.claimCreatorFeesFor` (quote side), `FeeRouter.claimCreatorTokenFeesFor_15` (rocket-token side) and `CurveFeeVault.claimCreatorFeesToRouter` (curve-phase fees) pay the calling router. Only a router the owner has approved with `FeeRouter.setClaimRouter` may call them. Today that is `DiscipleRouter`, for `claimCreatorFeesToUsdg`, which pays whoever calls it, so the relayer cannot use it.

Fees for a normal rocket already sit under the launch wallet: `FeeRouter.creatorAccrued`, `FeeRouter.creatorTokenAccrued` and `CurveFeeVault.creatorAccrued`. `Launchpad.creatorOf(token)` is that wallet.

## What this draft adds

- `contracts/src/addons/CreatorClaimBySig.sol`, a small helper. `claimCreatorFeesBySig(ClaimReq)` checks the creator's EIP-712 `Claim` signature (domain "DISCIPLE CreatorClaim", version 1) with `ECDSA.recover`. The wallet it pays is the wallet that signed, and only that wallet's fees are pulled, through the three router functions above. It pays the pair coin and the rocket token straight to `to`, the same way a private claim pays out today. It has no owner and holds nothing between calls.
- App wiring. When the helper is configured and approved on-chain, the Rewards claim signs one `Claim` with the player's wallet and sends it through the existing gasless claim relay, next to the private-launch claims. Login, trading and the relay itself do not change. When the helper is not configured or not yet approved, the app behaves exactly as it does today.

## Later owner steps (not part of this draft)

1. Deploy `CreatorClaimBySig(feeRouter, launchpad)`.
2. The owner calls `FeeRouter.setClaimRouter(helper, true)`. Until then every helper claim reverts in `FeeRouter`, and the app does not offer it.
3. Set `NEXT_PUBLIC_<NET>_CREATOR_CLAIM_HELPER` to the helper address.

Nothing here turns on the on-chain referrer lock or the automatic fee share, and nothing changes FeeRouter, CurveFeeVault or DiscipleRouter.
