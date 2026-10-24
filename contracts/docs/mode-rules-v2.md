# Mode rules v2 (Easy / Hard / TRENCH), approved by Maker lee on 2026-10-23

Status: PR "Mode rules v2: Easy/Hard caps, partial fill, sniper escrow, creator lock, crew tip". **Not merged, not deployed.**
It ships in **one combined testnet redeploy** together with the paymaster (#106) and the 6-decimal USDG. **Needs AUDIT** before mainnet.

Mode ids are unchanged: `TRENCH = 0`, `PVE = 1` (**Easy**), `PVP = 2` (**Hard**). The creator picks the mode at launch
(`Launchpad.launchWithMode`, or `DiscipleRouter.launchWithUsdg`). Every rule below applies **on the bonding curve
only** and switches off at graduation (the hook, the v4 pool, LockedLP and the router's v4 paths contain no mode logic).
Curve facts: 1M supply (no burn, LOCKED #7 rev. 2026-10-23), 72% sold on the curve (pending lee's pick: 72% / 67.4% / 50%), $7,777 → $33,333 mcap.

## Rules at a glance

| | Easy (PVE, 1) | Hard (PVP, 2) | TRENCH (0) |
|---|---|---|---|
| Login | LoginGate attestation required to **buy** (sells never) | none | none |
| Holding cap (NET curve position) | **1% → 3.33%** linear in mcap $7,777 → $33,333 | **3.33% → 7.77%** linear in mcap $7,777 → $33,333 | legacy owner `walletCapBps` (default 0 = none) |
| Over-cap buy | **partial fill** + refund | **partial fill** + refund | partial fill + refund (if a legacy cap is set) |
| Max single buy / sell | none | none | none |
| 7-min window / launch-block rule | **removed** | — | — |
| Profit tax | **crew tip**: 0.777% of sell proceeds, only if realized profit > threshold (default 0.5% of mcap) → holders claim pool | none | none |
| First BOOST (creator launch buy) max | **1.2%** of supply | **3.33%** | `creatorBuyMaxBps` (default 0.77%) |
| Creator lock | First BOOST tokens locked until graduation (later buys free) | none | none |
| Sniper tax | 99% → 0 over 7 s (per-second table), First BOOST exempt, escrowed | same | same |

Constants: `src/libraries/Constants.sol` (`PVE_CAP_START_BPS=100`, `PVE_CAP_END_BPS=333`, `PVP_CAP_START_BPS=333`,
`PVP_CAP_END_BPS=777`, `FIRST_BOOST_MAX_BPS_PVE=120`, `FIRST_BOOST_MAX_BPS_PVP=333`, `PVE_CREW_TIP_PPM=7770`,
`CREW_TIP_THRESHOLD_BPS_DEFAULT=50` (bounds 10–500), `ANTI_SNIPE_START_BPS=9900`, `ANTI_SNIPE_DURATION=7`, `ANTI_SNIPE_TABLE=[9900,2500,300,100,30,10,3]`,
`SNIPE_ESCROW_TIMEOUT=30 days` (bounds 1–365 days)).

## Holding cap (Easy and Hard)

* `cap(mcap) = start + (end − start) × clamp(mcap − $7,777, 0, $25,556) / $25,556`, in bps of total supply, applied to the
  wallet's NET curve position (`balanceOnCurve`: bought − sold, transfers follow it in Easy, see bonding-modes.md).
* `mcap` is the curve's mcap **before** the trade (`marketCapUsd()`, quote/USD price fixed at launch).
* Views: `curve.netCapNow()` (tokens), `curve.capRoom(wallet)` = `min(cap − NET, curve supply left)`,
  `MarketLens.capNow(token) → (capBps, capTokens)` and `MarketLens.capRoom(token, wallet)`.

### Partial fill

* A buy whose output would push the trader above the cap fills **exactly up to the cap** and refunds the unused input.
  No revert. The fill is computed by a bounded binary search on the input (same construction as the graduation
  refund; ≤ 1e-12 relative overpay, fuzz-tested for minimality).
* Event `BuyRefunded(token, trader, tokensOut, quoteRefund, capped)` (`capped = true` for a cap / First BOOST limit,
  `false` when the curve supply ran out at graduation). The trade's `Trade` event carries only the filled part.
* `minTokensOut` applies to the **filled** amount. A UI that sizes buys to `capRoom` never hits it.
* Router USDG path (`buyWithUsdg`): the refund in the pair coin is swapped back to USDG through the registered pool and
  sent to the trader (`UsdgRefund`). USDG-paired coins refund USDG directly.
* **Room 0:** if the wallet's room is 0 at the pre-trade mcap (NET ≥ cap), the buy **reverts `WalletCap()`** (no
  zero-token fill). Because a capped buy raises mcap, a wallet that just hit its cap normally has a little room again;
  room 0 happens when other sellers push mcap down (the cap shrinks below the wallet's NET). Selling frees room.
* `quoteBuyFor(trader, quoteIn)` returns the partial fill and `refund`; it reverts with the trade's error
  (`NotVerified`, `WalletCap`).

## Crew tip (Easy only; replaces the 77% profit tax)

* On an Easy sell: `profit = netProceeds − costBasisOfSold` where cost basis is the pro-rata cost of the sold NET
  tokens (unchanged bookkeeping; tokens beyond NET carry zero basis).
* Tip = **0.777% of net proceeds** iff `profit > crewTipThresholdBps × mcapQuote / 10000` (mcap in the pair coin at the
  time of sale, **before** the sale; the USD conversion cancels out so it is compared in quote units).
* The tip goes to the holders claim pool (MasterChef accumulator, seller excluded, sole holder → treasury, unchanged).
* Threshold: `Launchpad.setCrewTipThresholdBps(bps)` (owner, 10–500 bps, default 50 = 0.5%), snapshotted per coin
  as `curve.crewTipThresholdBps()`. Existing coins keep their value.
* ABI kept: event `ProfitTaxCharged(token, seller, tax, grossQuote, costBasis)` and `SellQuote.profitTax` now mean
  "crew tip". `MarketLens.crewTipEstimate(token, seller, tokensIn) → (tip, quoteOut, profit, threshold)`.

## First BOOST and creator lock

* `Launchpad.firstBoostMaxBps(mode)`: Easy 120, Hard 333, TRENCH `creatorBuyMaxBps`. A larger First BOOST
  **partial-fills** to the max (refund to the payer); `CreatorBuyTooLarge` only fires when the max is 0.
* The First BOOST is exempt from the holding cap **for that buy only**; it counts in NET afterwards. Easy: 1.2% is
  above the 1% start cap, so the creator has no buy room until the cap grows past their NET (they can always sell
  unlocked tokens).
* It still needs a login in Easy, and it is sniper-tax exempt in every mode.
* Easy creator lock: `Token.creatorLocked()` = the First BOOST amount, enforced in `Token._update`: until graduation
  the **original creator** (`Token.creator`, immutable) cannot move their balance below the locked amount (transfer
  or sell → `CreatorLocked()`). Tokens bought later stay free. Graduation lifts it (`creatorLockActive()` false).
  `transferCreator` does not move the lock. `MarketLens.creatorLock(token) → (creator, locked, unlocked)`.

## Sniper tax (all modes)

* Buy-side fee by elapsed second t: 99% · 25% · 3% · 1% · 0.3% · 0.1% · 0.03% for t = 0..6, 0 from second 7 (rev. 2026-10-24, was linear over 77s) (`curve.currentSnipeFeeBps()`), on top of the 1%
  protocol fee and creator tax. First BOOST exempt. `MarketLens.sniperTax(token) → (bps, secondsLeft)`.
* Taken in the pair coin and held in `curve.snipeEscrow()`, **outside** `quoteReserve` and the price math.
* At graduation it is passed to migration (event `SnipeEscrowToLP`). Migration marks it non-floor, so it is **not**
  used for the graduation floor: LockedLP credits it to the coin's locked **compound bucket** (as with the curve-phase
  fee LP escrow), which compounds into the locked full-range position over time.
* If the coin has not graduated `curve.snipeEscrowTimeout()` (default 30 days) after launch, **anyone** can call
  `releaseSnipeEscrow()` to send it to `FeeRouter.rewardsVault()` (event `SnipeEscrowReleased`). It reverts
  `EscrowLocked` before the timeout, `Graduated` after graduation, `ZeroRecipient` if no vault is set. Graduation
  and release race: whichever happens first takes the escrow. The timeout is owner-tunable for future launches
  (`Launchpad.setSnipeEscrowTimeout`, 1–365 days, event `SnipeEscrowTimeoutSet`), snapshotted per curve.
  `MarketLens.snipeEscrow(token) → (amount, releasableAt, releasable)`.
* Removed: the 70/30 RewardsVault/treasury routing (`FeeRouter.routeSnipeFee` is no longer called by v2 curves) and
  the launch-block rule.

## Add-on: USDG launch and creator-fee claim (approved 2026-10-23)

* `DiscipleRouter.launchWithUsdg(LaunchParams p, uint8 mode, uint256 usdgIn, uint256 minQuoteIn) → (LaunchResult, usdgRefund)`:
  pulls `usdgIn` USDG, swaps it to the pair coin through the registered pool (`minQuoteIn` end-to-end slippage; 1:1
  for USDG-paired coins), and launches via the **router-only** `Launchpad.launchFor(creator = msg.sender, p, mode)`
  with that amount as the First BOOST. The coin's creator is the caller; the router pays, receives any First BOOST
  refund and swaps it back to USDG for the caller. `p.creatorBuyQuoteIn` is ignored (set to the swapped amount); `p.creatorBuyMinTokensOut` and `p.deadline` apply. Event `UsdgLaunch`.
  `usdgIn = 0` launches without a First BOOST. Reverts `Expired`, `Slippage`.
* `Launchpad.launchFor` reverts `NotRouter` unless `isTrustedRouter[msg.sender]`.
* `DiscipleRouter.claimCreatorFeesToUsdg(token, minUsdgOut)`: claims the caller's creator fees in the coin's pair coin
  (`FeeRouter.claimCreatorFeesFor`, router-only) and swaps them to USDG (`UsdgCreatorFeesClaimed`). Quote side only.
* **Session policy:** these selectors are deliberately **not** session-key selectors (pinned by
  `test_v2_usdgLaunchAndCreatorClaimNotSessionSelectors`). Launches and creator-fee claims stay an owner wallet
  confirm; a session key calling them reverts `NotAllowed`. Consequence: a "quick launch" with a session key is not
  possible with these entry points, and the session policy's USDG approve rule does not count them.

## Ambiguities resolved in this PR

1. Caps use the **pre-trade** mcap; room 0 reverts `WalletCap` instead of a zero fill.
2. TRENCH's legacy `walletCapBps` also partial-fills (one code path).
3. `minTokensOut` is checked against the filled amount.
4. Crew-tip profit = net proceeds − pro-rata cost basis; threshold in quote units; snapshotted per coin; event and
   field names kept for ABI compatibility.
5. Escrow at graduation goes into the locked LP via migration; excess → locked compound bucket.
6. Escrow timeout release goes to `FeeRouter.rewardsVault()`; races graduation.
7. First BOOST needs login in Easy and counts in NET; it can exceed the start cap (creator then has no room).
8. Creator lock is keyed on the immutable `Token.creator`.
9. `launchFor`: the router is the payer and receives the refund (swapped back to USDG).
10. Kept as compat stubs: `maxBuyNow()` / `maxSellNow()` return `type(uint256).max`, `launchBlock` stays. `AntiSnipe`
    (and its Launchpad constructor arg) and `FeeRouter.routeCurveFees`/`routeSnipeFee` are legacy/unused by v2 curves.

## SITE UI checklist

- [ ] **Buy presets limited to capRoom**: quick-buy presets and MAX use `MarketLens.capRoom(token, wallet)` (convert
      with `quoteBuyFor`). Disable a preset that exceeds room; show "max X tokens".
- [ ] **Partial-fill toast**: on `BuyRefunded(capped = true)` (or `quoteBuyFor(...).refund > 0` before sending), show
      "Filled to your cap: got N tokens, refunded R USDG". Router path: read the USDG refund from `UsdgRefund`.
- [ ] **Room-0 state**: if `capRoom == 0`, disable Buy with "You're at your cap. Cap grows with market cap, or sell
      to free room." (the tx would revert `WalletCap`).
- [ ] **Cap meter**: NET position vs `MarketLens.capNow(token)` (bps + tokens), with the next step (cap at $33,333:
      Easy 3.33%, Hard 7.77%). Hide for TRENCH unless a legacy cap is set.
- [ ] **Sniper countdown**: `MarketLens.sniperTax(token) → (bps, secondsLeft)` for the first 7 s: "Sniper tax 74% —
      45 s left"; warn before a buy. Show the escrow (`MarketLens.snipeEscrow`) as "goes to locked liquidity at graduation" (compound bucket).
- [ ] **Crew-tip estimate** (Easy sells): `MarketLens.crewTipEstimate(token, wallet, tokensIn)`; show "Crew tip 0.777%
      (X USDG) to holders" only when `tip > 0`, plus the threshold in plain words ("profit above 0.5% of mcap").
- [ ] **Creator-lock badge** (Easy): `MarketLens.creatorLock(token)` → "Creator's First BOOST locked until
      graduation (N tokens)"; on the creator's own sell form, cap the sellable amount at balance − locked.
- [ ] **Create-mode descriptions**: Easy — "Login to buy · cap 1%→3.33% · crew tip on big profits · First BOOST ≤1.2%,
      locked until graduation". Hard — "No login · cap 3.33%→7.77% · First BOOST ≤3.33%". TRENCH — "No caps ·
      sniper tax only". All: "99% sniper tax decays to 0 in 7 s (your First BOOST is exempt)". First BOOST field
      max from `Launchpad.firstBoostMaxBps(mode)` and `quoteCreatorBuy(quote, in, tax, mode)`.
- [ ] **USDG launch**: create flow can call `DiscipleRouter.launchWithUsdg` (wallet confirm, not a session key).
      Creator fee claim button: `claimCreatorFeesToUsdg`.
- [ ] **Remove old messaging**: the 7-minute window, the 0.25% per-buy cap, the 0.5% max sell, the 77% profit tax
      trigger, the launch-block notice, the 70/30 snipe split, and the old 4%→12% PVP cap / 3.33% max buy.
- [ ] Re-export ABIs (curve, Launchpad, Token, router, lens) to web / sdk / indexer (`BuyRefunded`,
      `SnipeEscrowToLP`, `SnipeEscrowReleased`, `UsdgLaunch`, `UsdgCreatorFeesClaimed`, new views).
