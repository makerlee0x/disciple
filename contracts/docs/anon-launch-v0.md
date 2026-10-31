# Pseudonymous launches v0 (add-on, no core redeploy)

Design source: anypair/docs/anon-launch-v0.md (ideas 1-4, no ZK). UI copy: **pseudonymous**, never "anonymous".

## Contracts
- `src/addons/AnonLauncher.sol` wraps the live Launchpad. It is the on-chain `creator` of the coins it launches and keeps `stealthOwnerOf[token]`.
  1. **Sponsored gas, recouped:** the payer (an ERC-4337 smart account, EntryPoint v0.7) sends one userOp: `USDG.approve` + `launchAnon`. `launchFee` (USDG, owner-settable, capped at $5, set to $0.25 on testnet) goes to treasury.
  2. **Creator buy goes through the curve:** `Launchpad.launch` calls `curve.buyFor`, so the anti-snipe exemption and the 0.77% cap still apply. Tokens are forwarded to `buyRecipient`, a fresh address.
  3. **Stealth creator:** the creator is an ERC-5564 scheme-1 stealth address, announced through the ERC-5564 Announcer `0x5564…5564` (view tag + token in metadata).
  4. **Batch claims:** `claimMany`, `claimManyBySig` and `claimManyBySigBatch` use EIP-712 (`Claim(owner,tokens[],to,relayerFeeBps,nonce,deadline)`). They support ERC-1271 and pay out to any `to`, with an optional relayer fee of at most 5%. They pull quote fees from `FeeRouter.claimCreatorFees` and forward the coin-denominated hook fees held by the add-on.
  - The stealth owner doesn't need gas: it can call `transferCreatorBySig` or `updateMetadataBySig`.
- The fee split is unchanged: the 1% fee and the 33/33/33/1 split stay in FeeRouter.
- Trust note: the stealth-owner registry lives in AnonLauncher. AnonLauncher has no admin path to the creator role. The owner can only change `launchFee` and `treasury`.

## mcapNow fix
- `BondingCurve.mcapNow/marketCapUsd/priceNow/spotPriceWad` now read v4 slot0 after graduation and multiply by the live `QuotePricer` (through `Launchpad.pricer()`). The old version returned the frozen curve-end value of $33K.
- `AscensionHook` Trade-event mcap uses `pricer` (admin-settable) live, with a fallback to the launch-time price.
- Live contracts are immutable. The new curve code applies only after a new `CurveDeployer` is set, and the hook change needs a hook redeploy. Neither was done. Existing coins can use `MarketLens.market(token)` today.

## Privacy leaks (unchanged from design §5)
The payer of the launch fee and the buy is linked to the coin in the same tx. The bundler, sponsor and backend see metadata. Timing and `to` reuse can also link coins.
