# DISCIPLE smart contract audit handoff

**Code:** commit `9ca52f1`, private repo makerlee0x/disciple, PR #461 (`contracts/`). The source is attached as one text file: `disciple-contracts-9ca52f1.sol.txt` (45 files, about 9,100 lines). A smaller core-only file is `disciple-core-9ca52f1.sol.txt`.
**Stack:**
- Solidity 0.8.26, via-IR, optimizer 200 runs, EVM cancun.
- Uniswap v4-core v4.0.0, v4-periphery 9969eec, OpenZeppelin v5.7.0.
**Chain:** Robinhood Chain mainnet (chain id 4663), which is an FCFS sequencer, using the canonical Uniswap v4 PoolManager. Nothing is deployed on mainnet yet.

## What we want from you

You are auditing a memecoin launchpad before its mainnet launch. Please do these things:

1. **Find bugs that lose or lock funds, or let anyone take value they shouldn't.** The main risks are:
   - draining fee balances or the locked liquidity;
   - bricking trading or graduation;
   - bypassing the curve caps or the anti-snipe rules;
   - taking creator fees.
2. **Check every invariant below.** For each one, say whether it holds and point to the code.
3. **Review every owner or admin power,** including any we've missed, and say whether it can hurt holders.
4. **Report each finding** with severity (Critical/High/Medium/Low/Info), file:line, a concrete exploit or failing scenario, and a fix. Leave out style nits unless they hide a bug.

Assume the attacker is any EOA or contract, including one that calls the v4 PoolManager directly instead of using our router.

## How a coin works

1. **Launch.** Anyone calls `Launchpad.launch` (or AnonLauncher / CreatorFeeHarvest for hidden or fee-routed launches).
   - This deploys a `Token`: 1M supply, no mint, holders can burn.
   - It also deploys a `BondingCurve` via `CurveDeployer`.
   - The pair ("quote") is USDG or one of 12 listed coins. QuotePricer prices them in USD; QuoteProbe test-buys a coin when it's listed.
2. **Curve phase.** People trade on the curve.
   - The market cap starts at $3,333. The coin graduates at $33,333, once 84.24% of supply is sold.
   - Every trade pays a 1% fee, plus an optional creator tax of 0–7% fixed at launch.
   - Anti-snipe: a 99% fee at launch that falls to 0 over 7 seconds. The snipe fee is escrowed, and released through FeeRouter / RewardsVault if the coin doesn't graduate within 12 days.
   - Wallet caps depend on mode:
     - Easy (PVE): 1% rising to 3.33%. Login is checked in the app only (maker 2026-11-14); there is no on-chain login check and no LoginGate is deployed.
     - Hard (PVP): 3.33% rising to 7.77%.
     - Trench: no mode cap.
   - The creator's first buy is capped at 7.77%.
   - Curve-phase fees accrue in `CurveFeeVault`.
3. **Graduation.** In the same transaction, `Migration`:
   - creates the v4 pool (token/quote, LP fee 0, tickSpacing 60, `DiscipleHook`) at the curve's end price;
   - seeds full-range liquidity plus 16 single-sided floor bands into `LockedLP`, which can never remove liquidity.
4. **Pool phase.** `DiscipleHook.afterSwap` takes 1% of the unspecified amount, via `poolManager.take` to FeeRouter, and returns it as the hook delta.
   - `FeeRouter.routeHookFee` splits it: 33% creator, 33% LP, 33% treasury, 1% referral.
   - The 33% LP share sits in a LockedLP bucket. **Anyone** can call `LockedLP.flush(token)` to add it to the locked position. Caps: one add per block, at most 0.5% of the position's liquidity per 60 s, and only while the pool tick is within 200 ticks of a reference tick that follows the pool at 100 ticks per minute at most (no keeper, no caller input).
   - Trades normally go through `DiscipleRouter` (exact-in only, USDG multi-hop routes). Direct PoolManager swaps are allowed and pay the same fee.
5. **Creator fee destination,** fixed at launch:
   - **0 Keep:** the creator claims.
   - **1 Lock:** `CreatorFeeHarvest.route` adds the fees to LockedLP.
   - **2 Burn:** the quote half goes to `0x…dEaD`. After graduation, the rocket-token half also goes straight to `0x…dEaD` with no sell.
   - `route` / `routeWith` can be called by anyone, and the caller receives nothing.
6. **Other parts:**
   - **TrampWallManager:** user one-sided limit bands in graduated pools.
   - **ReferralRegistry + UsdgDepositNotifier:** first-touch referral, gated by a $10 USDG deposit.
   - **DisciplePermitForwarder:** Permit2 spender for gasless withdrawals and relayed actions. No owner, holds no funds between calls.

## Contracts in scope

| Contract | Role | Privileged roles |
| --- | --- | --- |
| Token | ERC-20, 1M fixed | none |
| Launchpad | factory, per-coin settings snapshot | owner (Safe) |
| CurveDeployer, BondingCurve | curve trading, caps, anti-snipe, graduation trigger | none (Launchpad can kill a curve's router path) |
| CurveFeeVault | curve-phase fee ledger | none |
| Migration | graduation into v4 + LockedLP | owner: one-time `setLaunchpad` |
| LockedLP | owns all pool liquidity forever, permissionless `flush` | owner renounced at deploy |
| DiscipleHook | beforeInitialize lock + afterSwap 1% fee | admin renounced at deploy |
| FeeRouter | fee split, claims, creator tax, snipe escrow | owner (Safe) |
| DiscipleRouter | post-graduation exact-in buy/sell, USDG routes | owner (Safe) |
| QuotePricer | pair-coin USD price (TWAP of USDG pools) | owner + pokers |
| QuoteProbe | listing-time buy/transfer simulation (always reverts) | owner |
| TrampWallManager | limit bands | owner: keeper tip ≤ 1% |
| ReferralRegistry, UsdgDepositNotifier | referrals | owner + attester key |
| RewardsVault | sniper-escrow pool | owner pays out |
| AnonLauncher | hidden launches (stealth owner, EIP-712) | owner: fee ≤ $5 (set to 0), treasury, harvest pointer |
| CreatorFeeHarvest | lock/burn creator fees | owner renounced at deploy |
| DisciplePermitForwarder | Permit2 gasless flows (not deployed by Deploy.s.sol; deployed separately) | none |
| Owned2Step, libraries/* | two-step ownership, curve/fee/mcap/floor/TWAP math | n/a |

**Out of scope (not deployed):** LoginGate (no longer deployed), DisciplePaymaster, DisciplePaymasterV5, DiscipleSessionPolicy (all versions), AntiSnipe.sol (legacy), MarketLens (read-only), scripts and tests. `script/Deploy.s.sol` is useful context for the wiring order and the deploy-time renounces.

## Locked vs tunable

These are **locked at deploy**, in this commit:
- **LockedLP:** owner renounced, so the treasury address and stacking caps are fixed. The FeeRouter, Migration and PoolManager pointers are write-once.
- **CreatorFeeHarvest:** owner renounced, so the fee vault and AnonLauncher pointers are fixed. Its wiring is one-shot.
- **DiscipleHook:** admin renounced after Migration and the pricer are set.
- **FeeRouter:**
  - `setLaunchpad`, `setLockedLP` and `setCreatorFeeHarvest_51` are write-once.
  - The owner gets exactly one `setAuthorized` grant (the hook). After that, only the Launchpad authorizes its own curves.
- **Migration:** `setLaunchpad` is one-time.
- **Launchpad:** `setCurveDeployer` is write-once (contracts only). Launch modes are fixed to Trench / Easy / Hard.
- **FeeRouter settings:** `lockSettings()` runs at the mainnet deploy, after which the KOL share, referral sink and claim-router list can never change.
- **AnonLauncher:** the harvest pointer is write-once.
- **Deploy on 4663:** the renounces and the fee-settings lock can't be turned off by env. `SAFE` and `PRICER_POKER` are required. Every contract that keeps an owner is nominated to the Safe (two-step), and the script reads the wiring back before it finishes.
- **Per coin:** mode, pair, creator tax, fee destination and caps are fixed at launch.

**Still tunable** by the owner, which the deploy nominates to the protocol Safe. A timelock is operational (the Safe's own setup), not enforced in these contracts. Unless noted, these only affect new coins, routes or price reads:
- **Launchpad:**
  - pair coin, pricer, probe;
  - trusted router, plus a router kill switch on curves (existing curves read the trusted list live);
  - creator buy max (≤ 7.77%), wallet cap (≤ 100%, off by default);
  - crew-tip threshold (0.1–5%), snipe escrow timeout (1–365 days).
- **FeeRouter:** treasury (also redirects already-accrued treasury balances) and rewards vault (contracts only; ungraduated coins' escrows follow it).
- **DiscipleRouter:** max impact (1% to 10x, default 50%), USDG routes, owner (two-step).
- **QuotePricer:** allowed quotes, price pools and routes, TWAP window and clamp, min liquidity, warm-up, pokers, `allowAnyQuote`.
- **QuoteProbe:** probe size, `setAlwaysPass`.
- **AnonLauncher:** fee, treasury, harvest pointer.
- **RewardsVault:** `distribute`.
- **Attester keys:** ReferralRegistry, UsdgDepositNotifier. A stolen key can attribute an unattributed wallet to an attacker referrer (redirecting that wallet's future referral share), but can't move funds.

No contract is upgradeable or behind a proxy.

## Invariants to check

1. LockedLP liquidity can never be removed or decreased by anyone, including the owner before renounce.
2. Only LockedLP, via Migration at graduation, can initialize a pool with DiscipleHook. A pool with this hook can't be created any other way.
3. Every swap on a DISCIPLE pool, routed or direct, exact-in or exact-out, pays exactly 1% of the unspecified amount to FeeRouter. The hook never takes from the wrong currency or over-takes.
4. **FeeRouter solvency.** The sum of claimable balances (creator, treasury, referral, LP bucket, per asset) never exceeds the tokens FeeRouter holds. Only authorized callers can book fee credit.
5. Creator fees of a lock/burn coin can't be claimed by the creator or anyone else. They can only go to LockedLP or `0x…dEaD`. Exception by design (maker 2026-11-17): when the coin has a launch KOL, the KOL's cut of the creator share (KOL share bps of the 33%, about 0.66% of volume at 2%) is paid to the KOL in cash.
6. `flush` can't move value out of LockedLP or overspend its bucket. A permissionless or sandwiched flush can't extract more than the per-window cap.
7. **Curve.**
   - Graduation happens exactly once, at the configured target.
   - Price continuity holds at migration: the v4 start price equals the curve's end price.
   - Wallet caps are **per address, per purchase** (Hard / Trench): a wallet can't buy past its cap through the router or the creator buy, but transfers and many wallets can hold more (Sybil). This is accepted (maker 2026-11-17). Easy coins also track NET on transfers, so one Easy wallet can't consolidate above the cap before graduation. Anti-snipe is time-based per buy.
8. Supply is fixed at 1M. Nothing can mint.
9. Settings are snapshotted at launch: owner changes after launch never alter an existing coin's caps, tax, mode or fee destination.
10. Renounced or write-once pointers can't be reset by any path.

## Focus areas

1. **DiscipleHook.afterSwap.**
   - Fee currency and sign for all four swap directions (zeroForOne × exact-in/out).
   - The `poolManager.take` + returned delta accounting, and the interaction with `routeHookFee`.
   - Behaviour on unregistered pools, and on tiny swaps where the fee is 0.
2. **FeeRouter.** The split math and rounding dust, the authorized-caller model, claim paths (to USDG via the router, harvest self-claim block), the referral sink, the KOL share and the snipe escrow.
3. **LockedLP.** The graduation seed and floor bands, flush/compound budget accounting, the `unlockCallback` paths, and quote escrow. Also: what an attacker gains by donating to the pool, pumping before a flush, or JIT liquidity around it.
4. **Migration + BondingCurve end state.** The exact graduation trigger, leftover token/quote handling, and anything that can make graduation revert (permanently stuck coin).
5. **Launchpad.** Launch params validation, snapshotting, `transferCreator`, the trusted-router model, and the curve router kill switch.
6. **CreatorFeeHarvest + AnonLauncher.**
   - Pulling fees for current, original and past creators.
   - The EIP-712 stealth-owner signatures (replay, nonce, deadline).
   - `launchAnonWithUsdg` refunds.
7. **DiscipleRouter.** Exact-in multi-hop USDG routes, min-out and deadline, and the impact cap. Also whether any route can hit a pool that isn't ours, or leave funds in the router.
8. **QuotePricer.** TWAP manipulation of pair-coin prices (they set curve start and graduation targets in USD), and stale or zero prices.

## Known issues and design decisions (don't re-report unless you find a worse variant)

- **No MEV protection beyond min-out.** Robinhood Chain uses an FCFS sequencer with no public mempool, so sandwiching is treated as unlikely:
  - capped USDG buys accept this (RT-01, accepted);
  - `flush` and `route` are open to anyone. `route` touches no pool. `flush` adds only near its on-chain reference tick (see Pool phase), which closed the held-pump variant from the 2026-11-17 audit (A-1).
- **Burn mode never sells.** After graduation, rocket-token creator fees are transferred to `0x…dEaD`. `quoteBought` in the `CreatorFeesRouted` event is always 0.
- **The hook emits no events.** Indexers read the PoolManager `Swap` event plus the router's `PoolTrade(trader, …)`. The hook takes no `hookData` and gives no per-trader referral credit on pool trades; the referral 1% goes to FeeRouter's referral sink.
- **Pool LP fee is 0.** All pool fees come from the hook delta. Raw v4 `modifyLiquidity` by third parties is allowed but earns nothing.
- **Fixed constants:** 1% trade fee, 33/33/33/1 split, 1M supply, $3,333 → $33,333 curve. Pool depth at graduation is about $5.3k per side (deliberate).
- **Single attester keys** (referral, deposit) are hot relayer keys. The Safe can rotate them.
- **Accepted (2026-11-17 round):** the virtual-reserve depth floor is pro-cyclical (the TWAP read path and the freshness check cover the manipulation side); the hook fee rounds down below 100 wei; quote tokens are only the 12 vetted pairs (no rebasing, pausable or fee-on-transfer token may be listed, since a paused quote freezes its coins with no rescue); exact-out swaps over ~99% of a side revert.
- **Test tooling.** `vm.lastCallGas` gas-bench tests fail on the forge build we use. This is a tooling issue, not a contract bug.
- **Prior internal audit (2026-11-14)** fixed these: HK-01 (donation bricking compounding), CH-01..07 (harvest), FR-01/02, PM-1/2, SK-1 (session key, now out of scope), HK-02 (TWAP poke made keeper-only), and LB-01 (listed quotes priced from route TWAPs).
- **Fixed after the 2026-11-17 four-report round** (see the section below).
- **Changed since that audit:**
  - the hook was rewritten slim;
  - permissionless flush and route;
  - burn mode with no sell;
  - renounce on LockedLP, harvest and hook;
  - FeeRouter write-once pointers;
  - the AnonLauncher difficulty modes;
  - the 12 pair routes.
  - DisciplePermitForwarder has never been audited.

## How to run it (for reviewers with repo access)

```
cd contracts
forge build
forge test --isolate            # --isolate is required (transient storage); build in batches if memory is tight
forge test --isolate --match-path "test/audit/*.t.sol"
```

Fork tests read Robinhood Chain mainnet through its public RPC.

## Fixed after the 2026-11-17 audit round

| Finding (reports) | Fix |
| --- | --- |
| Owner swaps the curve deployer, a fake curve books fee credit and drains FeeRouter + CurveFeeVault (R461-01a, A-2, L-1) | `Launchpad.setCurveDeployer` write-once, contracts only |
| Claim routers can take creator fees after deploy (R461-01b, I-01, I-2) | `FeeRouter.lockSettings()` at deploy freezes claim routers, KOL share and referral sink (also R461-04 / L-4) |
| Held pump + one flush per window is profitable (A-1) | flush reference-tick band in LockedLP (`REF_BAND_TICKS`, `REF_TICKS_PER_MIN`, `REF_MAX_CATCHUP`) |
| Burn-mode route on Easy coins reverts at the dEaD wallet cap (A-5) | a transfer to `0x…dEaD` is a burn in `BondingCurve.onTokenTransfer`: no cap, NET leaves `totalNet` |
| Router first hop partial fill / over-consumption (M-01, L-24) | every hop must consume exactly its input |
| Stale or cold-start launch price (M-02, R461-03, L-19, L-20) | `launchPriceUsd` requires a full TWAP window and a keeper write within 2 windows (no spot check: USDG launches buy the pair coin in the same tx); route registration never wipes a populated oracle |
| Probe skips transferFrom, swap-phase outcome forgeable (M-4, L-23) | probe sells back with approve + transferFrom; swap reverts count as honeypot |
| Forwarder is a shared identity: stranded tips, approvals (A-6, L-11) | relayed calls can't call transfer / transferFrom / approve / increaseAllowance / permit / setApprovalForAll; fee-token gains always go to `feeTo` |
| `forwardTokenFees` always reverts (A-4, R461-06) | removed |
| Anon direct transfer keeps nonce (L-01); resettable pointers (L-02, L-12, L-14, L-31) | nonce bump; harvest + AnonLauncher pointers write-once with code checks; LockedLP wiring setters require code |
| Single-step ownership (L-27), zero owner (L-26) | DiscipleRouter, TrampWallManager, ReferralRegistry, UsdgDepositNotifier and the hook admin are two-step; `Owned2Step` rejects a zero owner |
| Renounces env-overridable, no Safe handover (R461-05, L-32, g) | mainnet renounces + lock are unconditional; `SAFE` required; read-back checks in Deploy |
| Dead LoginGate / maxMode (M-2, I-17) | removed from Launchpad and Deploy |
| `setRewardsVault(0)` (L-10) | contracts only |
| Stale tests (R461-08) | BaseDiscovery and FeeClaims updated |
