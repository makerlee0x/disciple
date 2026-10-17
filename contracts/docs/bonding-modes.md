# Bonding-curve game modes (PVE / PVP / TRENCH WARFARE)

Status: implemented on `feat/modes-gas` (stacked on #65). **Not deployed** — the redeploy is on hold.
Constants live in `src/libraries/Constants.sol` (`MODE_*`, `PVE_*`, `PVP_*`). Every number marked *proposal* is a
default Maker lee can change before the redeploy (it is a constant, so changing it means a recompile, not a setter).

## Scope

* The creator picks the mode at launch: `Launchpad.launchWithMode(LaunchParams, uint8 mode)`.
  `launch` / `launchCoin` are unchanged and launch **TRENCH WARFARE** (0).
* Stored per coin, immutable: `BondingCurve.mode` (immutable) and `Launchpad.modeOf(token)`.
  `Launchpad` emits `LaunchMode(token, curve, mode)` at launch.
* Applies **only on the bonding curve**. Nothing changes after graduation: the hook, the v4 pool, LockedLP and the
  router's v4 paths contain no mode logic.
* Curve facts: 7B supply, 72% (5.04B) sold on the curve, $7K → $33K mcap at graduation.

| id | mode | difficulty |
|----|------|-----------|
| 0 | TRENCH WARFARE | hard (current behaviour) |
| 1 | PVE | easy |
| 2 | PVP | medium |

"NET curve position" = `balanceOnCurve[wallet]` = tokens bought on the curve − tokens sold to the curve (floored at 0).
Sells free up room. Tokens received by plain ERC-20 transfer are not part of it.

## 1) PVE (easy)

| rule | value | notes |
|------|-------|-------|
| per-wallet NET cap | **1%** of supply (70M) | `PVE_NET_CAP_BPS = 100` |
| login | verified Privy login required to **buy** | EIP-712 attestation, see below |
| launch block | no buys in the launch block **except** the creator's launch buy inside the launch tx | `launchBlock` immutable |
| launch window | first **7 minutes** (*proposal*, Maker lee set 7 min): max **0.25%** of supply per buy | `PVE_WINDOW`, `PVE_WINDOW_BUY_CAP_BPS = 25` |
| max single sell | **0.5%** of supply | `PVE_MAX_SELL_BPS = 50` |
| profit tax | **0.777%** of the sell proceeds when exit price > avg cost × 1.77 | `PVE_PROFIT_TAX_PPM = 7770`, `PVE_PROFIT_TRIGGER_BPS = 17700` |

The window is `[launchTime, launchTime + 7 min)`; at exactly +7 min the per-buy cap is gone. The launch-block rule
uses `block.number`, the window uses `block.timestamp`.

**Creator launch buy.** The Launchpad's same-tx creator buy (`buyFor`) is the one buy allowed in the launch block. It
counts against the same caps (0.25% window cap → effectively the creator can buy at most 0.25%; the 1% NET cap; it
builds cost basis like any buy). The creator must also be login-verified (attest before launching, e.g. batched).

### Login attestation (`src/LoginGate.sol`)

* EIP-712 domain `{name: "DisciplePVE", version: "1", chainId, verifyingContract: LoginGate}`.
* Type `LoginAttestation(address wallet,uint64 expiry,address coin)`. `coin = 0x0` → valid for all PVE coins,
  otherwise only that token.
* The protocol attester key is owner-settable (`setAttester`). The backend signs after verifying the Privy session.
* Anyone submits it with `LoginGate.attest(wallet, expiry, coin, sig)` (the wallet itself, a relayer, or the smart
  account batch right before its first PVE buy). The gate stores `verifiedUntil`.
* Cheap check: on a PVE buy the curve reads its own cache `verifiedUntilOf(wallet)` (1 warm SLOAD). Only when that is
  stale does it call `gate.verifiedUntil(wallet, token)` once and cache the result in the same slot as the cost basis.
* Sells never require a login (holders can always exit).
* Owner `revoke(wallet, coin)` clears the gate entry; a curve that already cached it honours the cached expiry until it
  lapses. **Proposal: 24 h expiries** so revocation/rotation takes effect within a day.

### Profit tax and holder-claim pool

* Cost basis: each PVE wallet has `costBasisOf(wallet)` = quote paid for its current NET position (the effective
  `quoteIn` of each curve buy, **including** protocol fee, creator tax and anti-snipe fee; graduation refunds are
  excluded). Avg cost = `costBasisOf / balanceOnCurve`.
* On a sell of `x` tokens: basis of the sold tokens = `cost × x / NET` (if `x ≥ NET` the whole basis; extra tokens that
  came in by transfer carry **zero** basis). Cost basis shrinks pro-rata, so the avg cost is unchanged by sells.
* Trigger: `grossQuote × 10000 > basis × 17700` ⇔ exit price (gross curve quote per token, before fees) exceeds avg
  cost by more than 77%.
* Tax = `quoteOut × 0.777%` where `quoteOut` = proceeds after the 1% fee and creator tax. The seller receives
  `quoteOut − tax`. Event: `ProfitTaxCharged(token, seller, tax, grossQuote, costBasis)`.
* Pool: standard MasterChef reward-per-token accumulator (`accRewardPerToken`, 1e18-scaled) over NET curve positions
  (`totalNet`). Per wallet: `rewardDebt`, `rewardsAccrued`; `pendingRewards(holder)` view.
* Ordering on a taxed sell (this is what makes it fair, see `test_pve_profitTaxAccumulatorFairness`):
  1. settle the seller at the **old** accumulator;
  2. reduce the seller's NET and `totalNet`;
  3. `acc += tax / (totalNet − seller's remaining NET)` — i.e. only *other* holders at that moment;
  4. reset the seller's `rewardDebt` at the **new** accumulator → the seller gets 0 of their own tax.
* Every buy settles the buyer at the current accumulator before changing NET, so a buyer who joins after a taxed sell
  starts with `rewardDebt = NET × acc` and gets 0 of it.
* If nobody else holds (denominator 0) the tax goes to `unallocatedTax` and is folded into the next distribution.
* Claim: `BondingCurve.claim()` or `Launchpad.claim(token)`. Event `HolderRewardsClaimed(token, holder, amount)`.
* **Graduation:** the reward quote is held by the curve outside `quoteReserve`, so migration never touches it. NET
  positions and the accumulator freeze at graduation (no more curve trades), so `pendingRewards` stays exactly
  claimable forever. Any `unallocatedTax` left at graduation goes to the treasury (`FeeRouter.treasuryAccrued`).

## 2) PVP (medium)

| rule | value |
|------|-------|
| per-wallet NET cap | linear from **4%** at launch to **12%** at graduation: `4% + 8% × tokensSold / 5.04B` (progress before the trade) |
| max single buy | **3.33%** of supply (`PVP_MAX_BUY_BPS = 333`) |
| login | none |

## 3) TRENCH WARFARE (hard)

No mode caps — the pre-existing behaviour, bit for bit (the legacy owner `walletCapBps`, default 0, still applies to
TRENCH coins only; PVE/PVP use their own caps instead). Gas overhead: one immutable comparison per trade.

## Known caveat: transfers dodge NET caps

A wallet can buy up to the cap and transfer tokens to a fresh wallet, which then buys more. **Accepted.** In PVE the
login requirement is the mitigation (each buying wallet must be a verified Privy login). Transferred-in tokens have
no cost basis, so selling them on a PVE curve is always "in profit" and pays the 0.777% tax.

## Router-mediated curve trades

* `DiscipleRouter.buyWithUsdg / sellToUsdg` now call `BondingCurve.routerBuy(trader, …)` / `routerSell(trader, …)`.
  These are accepted only from routers the Launchpad owner trusts (`Launchpad.setTrustedRouter`). Caps, login, cost
  basis, profit tax, NET position, Trade/fee attribution all use `trader` (= the router's `msg.sender`).
* Fixes the old side effect: router-mediated curve sells used to debit/credit `balanceOnCurve[router]` and attribute
  the fee/referral to the router. Now they hit the real trader.
* The router delivers funds straight to the curve (v4 `take` → curve, or USDG `transferFrom` user → curve; tokens
  user → curve). No router custody, no approvals; graduation refunds go to the trader.
* The router's 50% impact cap is passed in and enforced by the curve on its exact quote (same
  `PriceImpactTooHigh(impactBps, maxImpactBps)` error).
* Direct curve calls are unchanged: `buy(…, recipient)` applies all rules to `recipient`; `sell` to `msg.sender`.

## Quotes

* `BondingCurve.quoteBuyFor(trader, quoteIn)` — `quoteBuy` + every mode rule (reverts with the trade's error:
  `LaunchBlock`, `NotVerified`, `BuyTooLarge`, `WalletCap`).
* `BondingCurve.quoteSellFor(trader, tokensIn)` — `quoteSell` + PVE max sell + profit tax (`SellQuote.profitTax`,
  already deducted from `quoteOut`). `SellQuote` gained a trailing `profitTax` field.
* `DiscipleRouter.quoteUsdgRoute / quoteBuyWithUsdg / quoteSellToUsdg` quote for the **caller** (`eth_call from`)
  through `quoteBuyFor / quoteSellFor`, so they reflect caps and the PVE tax. `quoteExactIn` is v4-only (post-grad)
  and therefore unaffected by modes.
* Views for UIs: `mode`, `netCapNow()`, `maxBuyNow()`, `maxSellNow()`, `costBasisOf`, `verifiedUntilOf`,
  `pendingRewards`, `totalNet`, `accRewardPerToken`, `launchTime`, `launchBlock`.

## Decisions for Maker lee to confirm

1. PVE launch window **7 min**, window per-buy cap **0.25%** (constants).
2. Creator launch buy: allowed in the launch block; subject to all PVE caps (so ≤ 0.25%) and requires a login.
3. Cost basis includes fees (protocol 1% + creator tax + anti-snipe); exit price uses the gross curve quote.
4. Tax base = proceeds after fee & creator tax; tax stays in quote, paid out in quote.
5. Transferred-in tokens have zero basis (always taxed in PVE when sold on the curve).
6. Unallocated tax (no other holder) rolls into the next distribution; leftover at graduation → treasury.
7. PVP cap uses progress **before** the trade.
8. Legacy `walletCapBps` (default 0) applies to TRENCH only.
9. Sells never need a login; login attestations suggested at 24 h expiry.

## Graduation leftover (DISCIPLE audit #9)

At graduation the full-range v4 add at the curve-end price cannot absorb all of the curve's quote: the leftover is
**material, roughly 15% of the raise** (per the DISCIPLE audit). By design (Maker lee decision 2026-10-16) it is not
burned or sent to treasury: it goes into the coin's **compound quote bucket** in LockedLP and pairs over time with
incoming token-side fees, so it ends up as locked liquidity (`GraduationLeftover(token, quoteToCompoundBucket, …)`).
UIs should not count it as "in the pool" until compounded.

## DISCIPLE audit fixes in this PR

1. HIGH: compounding is skipped when the pool was already swapped earlier in the same tx (transient flag set in
   `beforeSwap`); the per-swap 3% guard still applies. Follow-up (approved): a **block-start anchor** closes the
   multi-tx same-block variant, see below.
2. LOW: `LockedLP._compound` returns early if any currency is synced in the PoolManager, so it never overwrites a
   swapper's pending `sync`.
3. GAS: `FeeRouter.routeHookFee` returns `compoundReady` (both buckets ≥ 2 wei); the hook only calls the compounder then.
4. MEDIUM: router-mediated curve trades use `routerBuy/routerSell(trader, …)` (see above).
5. LOW: session policy allows USDG approvals to the router, curves, TrampWallManager, Launchpad and AnonLauncher only
   for exactly the USDG the same batch's calls to that spender pull; `launchWithMode` is a P_LAUNCH selector.
6. LOW: a graduating `buyWithUsdg` refund is swapped back to USDG through the registered pool (`UsdgRefund` event).
7. MEDIUM: `UsdgDepositNotifier.deposit` now **escrows** the USDG (see below); the earlier balance check is gone.
8. LOW: graduating-buy refund uses a bounded binary search (≤ 1e-12 relative overpay), reverting rather than
   overcharging if it ever fails.

## Follow-up fixes (open risks from PR #75)

### Block-start anchored compound guard (DiscipleHook / LockedLP)

- The hook packs `{uint8 tier, uint64 anchorBlock, uint160 anchorSqrt}` into ONE slot per pool (the old
  `altitudeTierOf` slot). The pool's first swap of each block stores the pre-swap `sqrtPriceX96` (block-start price);
  later swaps in that block only read it.
- In-swap compounding passes LockedLP the reference price that deviates most from spot, comparing the swap's own
  pre-price and the block-start price. LockedLP's existing `maxCompoundDeviationBps` (3%) guard then skips the add. So
  "tx1 pump → tx2 dust swap → tx3 dump" in one block can't compound at the pumped price. The same-tx flag
  (audit #1) stays in place.
- `LockedLP.flush` (permissionless) uses the block-start anchor as its reference when the pool already traded in the
  current block. Otherwise it behaves as before.
- New views: `DiscipleHook.blockAnchor(PoolId) → (uint64 block, uint160 sqrtPriceX96)`.
  `altitudeTierOf(PoolId)` keeps its ABI (it is now a function instead of a public mapping).
- Out of scope: manipulation that spans blocks (pump in block N, compound in N+1). A short multi-block oracle could
  be added later from the same anchor slot. Builders who control consecutive blocks are the residual risk, bounded
  by the 3% guard per block.
- Gas (exact, `--isolate`): non-compounding swaps pay +949 when they are not the first swap of the block, and +3,902 when they are the pool's first swap of the block. Compound-ready swaps pay +2,752 / +5,685. See gas-report.md. The reference is chosen by |Δ sqrtP|, which at the 3% scale ranks deviations the same way the ratio does.

### Referral USDG escrow (UsdgDepositNotifier)

- `deposit(wallet, amount)` pulls `amount` USDG from the caller **into the notifier** and counts it for `wallet`.
  The caller needs an exact approve to the notifier. The minimum is `REFERRAL_USDG_GATE` ($10). The deposit is locked
  for `LOCK_PERIOD = 7 days`, and each new deposit re-locks the wallet's escrow. Anyone may fund any wallet,
  including itself. The USDG stays locked, so the same $10 can't satisfy the gate for two wallets at once; cycling it
  costs 7 days per hop.
- `withdraw()` lets the wallet take its whole escrow (to itself) once `block.timestamp ≥ unlockAt`. An already
  finalized referral stays.
- `escrowOf(wallet) → (uint192 amount, uint64 unlockAt)`. Events: `Deposited(payer, wallet, amount)`,
  `Escrowed(wallet, total, unlockAt)`, `Withdrawn(wallet, amount)`. Errors: `BelowMinimum(min)`, `Locked(unlockAt)`,
  `NothingEscrowed`, `NotTransferred`.
- Griefing: a third party can extend a wallet's lock, but each extension costs them $10 locked for 7 days (credited to
  the victim's escrow, so the victim gains the USDG).
- Session policy: unchanged. Funding the escrow is an owner (EOA/passkey) flow, not a session-key flow, so the policy
  does not whitelist approvals to the notifier. Session keys still can't approve it.
- The attestor path (`attest`) is unchanged and trusted, for off-chain on-ramp deposits.
