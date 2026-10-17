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
* Owner `revoke(wallet, coin)` clears the gate entry. A curve caches at most `min(expiry, now + 10 min)`
  (`PVE_LOGIN_CACHE_TTL`, audit round-2 L1), so a revocation bites within 10 minutes on every curve.
* `attest` rejects `expiry > now + 24 h` (`LoginGate.MAX_TTL`, error `TtlTooLong`, audit round-2 L2).

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
* If nobody else holds (denominator 0) the tax goes straight to the treasury (`FeeRouter.accrueTreasury`, audit
  round-2 L6). `rewardsHeld` tracks the quote owed to holders (claimed amounts are subtracted).
* Claim: `BondingCurve.claim()` or `Launchpad.claim(token)`. Event `HolderRewardsClaimed(token, holder, amount)`.
* **Graduation:** the reward quote is held by the curve outside `quoteReserve`, so migration never touches it. NET
  positions and the accumulator freeze at graduation (no more curve trades), so `pendingRewards` stays exactly
  claimable forever.

## 2) PVP (medium)

| rule | value |
|------|-------|
| per-wallet NET cap | linear from **4%** at launch to **12%** at graduation: `4% + 8% × tokensSold / 5.04B` (progress before the trade) |
| max single buy | **3.33%** of supply (`PVP_MAX_BUY_BPS = 333`) |
| login | none |

## 3) TRENCH WARFARE (hard)

No mode caps — the pre-existing behaviour, bit for bit (the legacy owner `walletCapBps`, default 0, still applies to
TRENCH coins only; PVE/PVP use their own caps instead). Gas overhead: one immutable comparison per trade.

## PVE: NET follows transfers (audit round-2 M1)

PVE tokens are constructed with `pveHooks = true` and told their curve once (`Token.setPveCurve`, Launchpad-only).
Until graduation, every PVE token transfer where neither side is the curve calls
`BondingCurve.onTokenTransfer(from, to, amount)` (token-only):

* `moved = min(amount, NET[from])` moves from the sender's NET to the receiver's NET. Cost basis moves pro rata
  (`cost[from] × moved / NET[from]`). Tokens beyond the sender's NET (e.g. received pre-hook) carry nothing.
* Both sides are settled at the current accumulator first and their `rewardDebt` is reset, so neither side gains or
  loses already-accrued rewards (no phantom rewards from receiving NET).
* The receiver's 1% NET cap is enforced (`WalletCap`): a transfer that would push the receiver over 1% reverts.
  So the old "buy to cap, transfer to a fresh wallet, buy again" dodge is gone in PVE.
* Excluded: the curve itself (buys/sells already account), and the curve's cached `trustedRouter` (the router
  forwards tokens in `routerSell`). Graduation calls `Token.endPveHooks()`, after which transfers are plain ERC20
  (pool, LockedLP, routers unaffected). Mint/burn and zero-value transfers skip the hook.
* TRENCH/PVP tokens and graduated PVE tokens pay one immutable check per transfer (≈0 overhead).
* Residual: tokens a user sends straight to the router keep their NET at the sender (they are stuck in the router
  anyway, so this can't be turned into profit).

PVP/TRENCH: transfers still dodge NET caps (accepted, unchanged).

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
* `DiscipleRouter.quoteUsdgRouteFor(trader, token, isBuy, amountIn)` quotes for an explicit trader (audit round-2
  M2). The session policy now quotes for the **account** it validates, so PVE gates/caps/tax are those of the account.
  `quoteUsdgRoute / quoteBuyWithUsdg / quoteSellToUsdg` still quote for the **caller** (`eth_call from`)
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
6. Profit tax with no other holder goes to the treasury immediately.
7. PVP cap uses progress **before** the trade.
8. Legacy `walletCapBps` (default 0) applies to TRENCH only.
9. Sells never need a login; login attestations capped at 24 h expiry, curve cache at 10 min.

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
- Cross-block manipulation is handled by the multi-block reference below (audit round-2 HIGH-1).
- Gas (exact, `--isolate`): non-compounding swaps pay +949 when they are not the first swap of the block, and +3,902 when they are the pool's first swap of the block. Compound-ready swaps pay +2,752 / +5,685. See gas-report.md. The reference is chosen by |Δ sqrtP|, which at the 3% scale ranks deviations the same way the ratio does.

### Referral USDG escrow (UsdgDepositNotifier)

- `deposit(wallet, amount) → id` pulls `amount` USDG from the caller **into the notifier** (balance-delta checked) and
  creates a separate escrow entry for `wallet`, locked for `LOCK_PERIOD = 7 days` from that deposit. Minimum
  `REFERRAL_USDG_GATE` ($10). Anyone may fund any wallet, including itself.
- **Each deposit has its own lock** (audit round-2 L5): a third-party gift never extends the wallet's existing
  entries, so lock-extension griefing is gone.
- `withdraw(uint256[] ids)` withdraws the listed unlocked entries to the wallet (`Locked(id, unlockAt)` if any is
  still locked, `NothingEscrowed` if the total is 0). An already finalized referral stays.
- Views: `escrowCount(wallet)`, `escrowOf(wallet, id) → (amount, unlockAt)`, `escrowedOf(wallet)` (total).
  Events: `Deposited(payer, wallet, amount)`, `Escrowed(wallet, id, amount, unlockAt)`, `Withdrawn(wallet, amount)`.
- **Gate rate:** the same $10 can satisfy the gate for at most one new wallet per 7 days, i.e. ~52 gated wallets per
  year per $10 of capital (e.g. $1,000 → ~5,200 referred wallets/year). That is the cost model of the gate: it
  prices Sybil referrals in locked capital, it does not make them impossible.
- Session policy: unchanged. Funding the escrow is an owner (EOA/passkey) flow, not a session-key flow, so the policy
  does not whitelist approvals to the notifier. Session keys still can't approve it.
- The attestor path (`attest`) is unchanged and trusted, for off-chain on-ramp deposits.

## DISCIPLE audit round 2 (re-review of #75 @ c003aaa)

### HIGH-1: cross-block compound manipulation — multi-block reference

- Hook slot per pool (still ONE slot): `{uint8 tier, uint40 anchorBlock, int24 anchorTick, int32 emaTickX256,
  uint40 emaTime, uint40 refSince}`. The block-start anchor is now stored as a tick (sqrt recomputed on read).
- On the first swap of each block the hook also updates a time-weighted EMA of block-start ticks:
  `ema += (tick·256 − ema)·dt/60` (`dt ≥ 60 s` → `ema = tick`). `REF_WINDOW = 60 s`. Initialised at graduation price.
- The reference is "ready" only after `REF_MIN_AGE = 60 s` since registration.
- Compounding (in-swap and `flush`) requires spot within `maxCompoundDeviationBps` (3%) of **both** the block anchor
  (if the pool traded this block) **and** the EMA (L7). In-swap compounding also still checks the swap's own pre-price
  and the same-tx flag.
- `flush()` always uses the EMA; it returns 0 when the reference isn't ready.
- `maxCompoundPpm` lowered 2% → **0.5%** of pool liquidity per add.
- Why it holds: a pump moves the EMA only through block-start ticks weighted by time, so a 1-block pump leaves the
  EMA ≈ the pre-pump price and the add is skipped. Holding the pump long enough to drag the EMA costs the attacker the
  pump's exposure for ≥ 60 s and still adds at most 0.5% liquidity per add (see tests below).
- PoC tests (`test/audit/DiscipleAudit.t.sol`, `test_high1_*`): pump 60k/80k/150k USDG in block N, dust swap or
  `flush` in N+1, dump: attacker end balance == control (no compound happens), e.g. 60k: 59,317.85 both.
  Holding the pump 61 s then compounding: −426.8 (60k), −532 (80k), −892 (150k) USDG vs spent. Also
  `test_high1_noCompoundBeforeRefAge`.
- New views: `priceReference(PoolId) → (emaTickX256, emaTime, refSince, ready)`,
  `compoundRefs(PoolId) → (refBlock, refEma)` (0 = unavailable). `blockAnchor` keeps its ABI.
- `ILPCompounder.compoundFromHook(token, refSwap, refBlock, refEma)` (4 args).

### Other fixes

- **M1** PVE NET follows transfers (section above).
- **M2** `quoteUsdgRouteFor(trader, …)`; the session policy passes the account; curve quotes via
  `quoteBuyFor/quoteSellFor(account, …)`. SDK: `encodeQuoteUsdgRouteFor`.
- **L1** curve login cache capped at 10 min. **L2** attestation expiry ≤ now + 24 h.
- **L3** `routerBuy/routerSell` check prepaid amounts by balance delta (`NotPrepaid`): the curve's balance must be ≥
  what it already owes (quote reserve + held rewards, or unsold tokens) + the claimed amount.
- **L4** graduating-buy refund minimality fuzz (`testFuzz_audit8_refundMinimal`: creator tax 0..max, quote in
  10k..1e33, inside/outside the anti-snipe window). We could not construct an input where the old 8-step loop fails to
  converge: with the linear fee math its estimate lands within a few wei. The bounded binary search stays as the
  safer construction; the fuzz test pins minimality rather than demonstrating an old-loop failure.
- **L5** per-deposit escrow lock (section above). **L6** sole-holder profit tax → treasury. **L7** see HIGH-1.
- **GAS** the curve caches its trusted router as an immutable `trustedRouter` (set from `Launchpad.curveRouter` at
  launch). `_onlyRouter` checks the immutable and only falls back to `Launchpad.isTrustedRouter` for other routers.
  Consequence: revoking that router on the Launchpad does not revoke it for curves launched before (fallback routers
  are still revocable). L3 bounds what a misbehaving router could claim.
- Size: `CurveMath.makeParams` moved to Launchpad (curve constructor takes `Params`), constructor requires →
  `BadParams()`. CurveDeployer runtime 24,378 B (EIP-170 margin 198 B).
