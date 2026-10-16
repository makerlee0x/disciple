# DISCIPLE FLOW — internal security review (2026-10-15)

- **Scope:** `contracts/src` on `flow/snipe-split` (#16) plus this branch: BondingCurve, Launchpad, FeeRouter (70/30 and 33/33/33/1), DiscipleHook, DiscipleRouter, TrampWallManager, LockedLP, Migration, QuotePricer, RewardsVault, AnonLauncher and MarketLens.
- **Method:** manual review; new fuzz/invariant tests in `test/security/`; Slither 0.10.x (`--exclude-dependencies`, src only); a fork PoC against the live testnet.
- **Limits:** this is an internal pass, not an audit. A professional audit is still required before mainnet (see `mainnet-plan.md`).

## Summary
| ID | Severity | Title | Status |
|---|---|---|---|
| SEC-01 | **High** | `LockedLP.addLockedLiquidity` unauthenticated: anyone can brick any coin (all trades revert) | **Fixed** in source; **live testnet v2 is vulnerable** (PoC) until the redeploy |
| SEC-02 | Medium | JIT liquidity can capture hook LP donations (1/3 of LP share) | **Fixed in source** (PR #44): donation removed (no LP yield to capture) + hook LP-add allowlist; needs redeploy |
| SEC-03 | Medium | QuotePricer uses the v4 spot price at launch (flash-manipulable); bakes into curve USD targets | **Fixed in source** (PR #44): QuotePricer lagged truncated TWAP + poke; needs redeploy |
| SEC-04 | Medium | Admin centralization: FeeRouter/Launchpad/LockedLP/hook owner can repoint core wiring (`setLaunchpad`, `setLockedLP`, `setMigration`, `setTrustedRouter`, `setPricer`) | Open; Safe multisig + timelock (mainnet plan) |
| SEC-05 | Low | Trusted UniversalRouter → `hookData` trader attribution is caller-chosen (spoofable Trade attribution / referral destination) | Open; document or attribute only via DiscipleRouter |
| SEC-06 | Low | TrampWallManager `pull` is permissionless: a whale can force-fill a range by pushing price through it (owner still gets their range price) | By design; document |
| SEC-07 | Low | Reentrancy via custom quote tokens (BondingCurve `_buy`/`_graduate`, Migration) | Mitigated by QuoteProbe; only affects the launcher's own coin |
| SEC-08 | Low | AnonLauncher: signed relayer fee is paid to *any* submitter (mempool copy) | By design (signer consented to that fee) |
| SEC-09 | Info | Hook pricer is try/catch, but a gas-griefing pricer could make swaps OOG | Admin-only; pin pricer address |
| SEC-10 | Info | Slither noise triaged (below) | — |

## SEC-01 (High): LockedLP escrow poisoning DoS
**Issue:** `addLockedLiquidity(token, quote, tokenAmount, quoteAmount)` had no caller check. `escrowQuote` is a plain counter, and it doesn't check which asset was deposited. An attacker can:
1. deploy a worthless ERC-20 and mint `2^256-1`;
2. call `addLockedLiquidity(targetCoin, junk, 0, type(uint256).max - escrowQuote)`.

**Impact:**
- Every later `FeeRouter._route` → `lockedLP.addLockedLiquidity(token, quote, 0, lpShare)` overflows and reverts. That covers every curve buy/sell (each pays the 1% fee) and every post-grad hook swap.
- Graduation (`Migration` adds the escrow to the seed amount) also overflows.
- Coin addresses are CREATE-predictable, so new coins can be poisoned **before launch**.
- Cost to the attacker: about 100k gas per coin.

**PoC:** `test/security/LockedLPForkPoC.t.sol` (`RH_FORK=1 forge test --match-contract LockedLPForkPoC`). On a fork of the live testnet it poisons the v2 coin TEST (`0x8461…9408`); after that a 100 STRATEGY buy reverts with `panic 0x11`. It's a read-only simulation; nothing was sent.

**Fix (this branch):**
- LockedLP gets an owner-set `feeRouter`. `addLockedLiquidity` now reverts `Unauthorized()` unless the caller is the FeeRouter or Migration.
- The deploy script and tests call `lockedLP.setFeeRouter(feeRouter)`.
- Tests: `test/security/LockedLPAuth.t.sol` and `testFuzz_lockedLP_add_only_feeRouter_or_migration`.

**Live stack:** LockedLP is immutable in Migration, the hook and TrampWallManager, so the live v2 cannot be patched in place. It is fixed by the combined redeploy (`docs/redeploy-migration.md`). Until then, any testnet coin can be bricked by anyone.

## SEC-02 (Medium): JIT capture of hook donations
- The hook donates 1/3 of the LP share to **in-range** liquidity through `PoolManager.donate`, and the pool allows anyone to add liquidity: there's no `beforeAddLiquidity` gate.
- A searcher can add concentrated liquidity right before a large swap (same block, or atomically via a router), then remove it, collecting most of the donation.
- The 2/3 LockedLP portion and other fee shares are unaffected.
- **Options:** donate on a delay (accumulate and donate on the next swap, or per block); gate adds with a minimum lock/cooldown via `beforeAddLiquidity`/`beforeRemoveLiquidity`; or restrict LP adds to LockedLP and TrampWallManager.

## SEC-03 (Medium): spot-price oracle at launch
- `QuotePricer.quotePriceUsd(quote)` reads the STRATEGY/USDG v4 pool `slot0`, gated by `minLiquidity` (0 on testnet).
- A flash swap around `Launchpad.launch` changes `quotePriceUsd`. That value is immutable per curve, so the coin's USD targets ($7K → $33K) end up mis-scaled.
- The impact falls mostly on that coin's buyers, through mis-stated USD mcap and an earlier or later graduation.
- **Recommendation:** set `minLiquidity` on mainnet; add a TWAP (an oracle hook or an observation ring) or a max-deviation bound against an owner-set reference.

## SEC-02 / SEC-03 fix (PR #44, revised 2026-10-16)
- **JIT:**
  - `DiscipleHook.beforeAddLiquidity` only accepts `isLiquidityManager` senders (LockedLP, TrampWallManager), so nobody can add raw v4 positions around a swap.
  - **Root cause removed (revision 3):** the hook no longer calls `PoolManager.donate`; the pool LP fee is 0, so in-range liquidity earns nothing and JIT has no payoff. The full 33% LP share goes to LockedLP (permanent).
  - The TrampWallManager min hold and fee vesting are therefore unnecessary and removed: cancel any time, pull immediately. Test `test_jit_same_block_add_swap_cancel_earns_no_yield` checks a same-block place→swap→cancel returns 0 fees and emits no donation.
- **Tramp/wall auto-close:** `pull` is permissionless once the range is fully crossed. It pays the owner proceeds minus `keeperTipBps` (default 0.1%, max 1%) to the caller. SEC-06 still applies: a whale can force-fill a range by pushing price through it, but the owner always gets their range price.
- **TWAP (`libraries/TwapOracle.sol`):**
  - Used **only by QuotePricer** (lagged mode). It records one observation per block via permissionless `poke` (also called by `Launchpad.launch`), and each write is truncated to ±`maxTickDelta`.
  - A flash move + poke + launch in one tx has zero effect; a held move is rate-limited.
  - This covers the launch-time quote price baked into curve USD targets, and the hook/curve live mcap.
- **Spot by decision:** altitude/tier breaks (`AltitudeUpdate`/`TierBreak`), `Trade.mcapAfterUsd`, `mcapNow`, MarketLens. These are game/display signals, not fund-safety checks: a single-block pump can trigger a tier break.
- **No oracle needed:** anti-snipe tax is time-based; graduation triggers on tokens sold (72%); QuoteProbe is an allowlist.
- Tests: `test/security/JitTwap.t.sol`.

## SEC-04 (Medium): admin powers
- **FeeRouter owner:** `setLaunchpad` (the creator lookup, which redirects creator fees), `setLockedLP`, `setTreasury`, `setRewardsVault`, `setAuthorized`.
- **Launchpad owner:** pricer, probe, curve deployer, default quote, creator-buy cap.
- **Hook admin:** trusted routers and pricer.
- **LockedLP owner:** migration, poolManager, feeRouter.
- Each can redirect funds or break trading. **Mainnet:** a Safe multisig owner, and a timelock on the wiring setters. Consider making the wiring one-shot, as `DiscipleHook.setMigration` already is.

## SEC-05 (Low): UniversalRouter hookData attribution
- The hook credits `abi.decode(hookData, (address))` as the trader when the sender is a trusted router.
- With UniversalRouter trusted, any UR user supplies their own hookData. They can attribute swaps to any address, which skews Trade events, indexer counters and leaderboards, and pick whose referrer gets the 1% leftover.
- Funds aren't at risk; the referral share is 1% either way.
- **Recommendation:** trust only DiscipleRouter for attribution; treat UR swaps as `trader = sender`.

## SEC-10: Slither triage (src only)
- High `arbitrary-send-erc20` / `unchecked-transfer` in `CurrencySettler.settle`: false positive. The payer is always `msg.sender` of the outer call (DiscipleRouter / TrampWallManager) or `address(this)`. PoolManager's settle accounting reverts the unlock if a transfer silently fails, because `CurrencyNotSettled`.
- Medium `reentrancy-no-eth` (BondingCurve `_buy`/`_graduate`, Migration, LockedLP seed): see SEC-07. Calls go only to the coin's own quote/token and protocol contracts.
- Medium `uninitialized-local` (defaults intended: `bought`, `leftoverTo`, `kolFromCreator`, `sqrtBefore`) and `incorrect-equality` (AntiSnipe `t0 == 0` sentinel): false positives.
- Medium `unused-return` (27, v4 calls): reviewed; ignored values are not security-relevant.
- Low and Info (`missing-zero-check`, `calls-loop`, `timestamp`, `reentrancy-events`): accepted.

## New tests (`test/security/`)
| Test | Property |
|---|---|
| `LockedLPAuth` | SEC-01 fix: attacker add reverts; FeeRouter/Migration paths still work; setter onlyOwner |
| `LockedLPForkPoC` | SEC-01 on the live v2 stack (fork) |
| `testFuzz_hook_fee_split_33_33_33_1` | post-grad buys/sells: creator 33%, LP 33% (all to LockedLP), treasury 33% + 1% residual, nothing lost |
| `testFuzz_twm_round_trip_and_auth` | place→cancel returns ≤ deposit and ≥ deposit−4 wei; non-owner cancel and early pull revert; no double cancel |
| `testFuzz_lockedLP_never_removable` / `_add_only_feeRouter_or_migration` | locked LP can never be removed; add is caller-restricted |
| `AnonSigFuzz` | wrong key never claims; nonce bump and replay; the digest binds owner, token order, nonce and relayer fee |
| `FeeRouterSolvencyInvariant` | under random curve buys/sells/claims/warps (incl. snipe window and referred trader): FeeRouter quote balance ≥ all creator + referrer liabilities; RewardsVault accounted == balance (70% leg) |
| existing | `InvariantHandler` (curve), `SnipeSplit` (70/30 exact), `CreatorBuyCap`, `AnonLauncher` |

Full suite: **128 tests pass** (`forge test`).
