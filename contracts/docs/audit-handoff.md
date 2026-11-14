# DISCIPLE smart contracts: audit handoff

You are reviewing the DISCIPLE contracts before their first mainnet deploy. This page tells you what is in scope,
how to build and test, how the system fits together, who holds which powers, what we already know about, and where we
most want a second pair of eyes. Please report findings with a severity, the file and line, a concrete exploit or
failure scenario, and a suggested fix. A Foundry PoC is very welcome.

## 1. Snapshot

| | |
|---|---|
| Repository | `makerlee0x/disciple` (private), folder `contracts/` |
| Commit to review | `eba19231` on branch `claude/project-thread-x7onqo` (PR #371: `main` + the internal audit fixes) |
| Chain | Robinhood Chain (EVM L2, Cancun). Single chain only. Centralized sequencer. |
| Compiler | solc **0.8.26** exactly, `via_ir = true`, optimizer 200 runs, `evm_version = cancun` |
| Dependencies | Uniswap v4-core **v4.0.0** (`e50237c`), v4-periphery `9969eec` (HookMiner only), OpenZeppelin **v5.7.0**, forge-std v1.17.0 (pins in `contracts/foundry.lock`, `DEPENDENCIES.md`) |
| Size | ~9,200 non-comment lines in `contracts/src` (in-scope list below) |
| Status | Not deployed to mainnet. Testnet stack exists. Contracts are **not upgradeable**: fixes ship by redeploying. |
| Earlier reviews | `contracts/docs/security-review.md` (2026-10-15) and `contracts/docs/audit-2026-11-14.md` (internal, this PR) |

## 2. Build and test

```bash
cd contracts
forge install   # or the exact commits in DEPENDENCIES.md
forge build --sizes
forge test --isolate        # --isolate matters: several tests rely on per-call transactions (transient storage)
```

Notes:
- A cold via-IR build is slow (many minutes) and can need more than 16 GB of RAM in one pass. If solc gets killed,
  build in batches: `forge build <file> <file> …`, then `forge test --isolate --match-path …`.
- Fork tests (`test/fork/*`, `*Fork*.t.sol`) need `ROBINHOOD_RPC_URL`; skip them otherwise.
- Gas benches that call `vm.lastCallGas()` need a forge build matching forge-std v1.17.
- `test/**/OpenFinding_*.t.sol` are PoCs for **known, still-open** issues (section 7). They pass while the bug exists.
- Ignore the `solar` profile in `foundry.toml`: dev loop only, never for review or deploy.

## 3. In scope

Core protocol:

| File | nSLOC | Role |
|---|---|---|
| `src/Launchpad.sol` | 353 | Permissionless coin factory. Registers coin, curve, creator; optional creator First BOOST buy (≤ 7.77%); `transferCreator`; owner config. |
| `src/CurveDeployer.sol` | 86 | Deploys a `BondingCurve` per coin (size-limited factory). |
| `src/Token.sol` | 78 | Fixed 1,000,000 supply ERC-20, 18 decimals, no further mint. |
| `src/BondingCurve.sol` | 734 | Pump-style CPAMM curve per coin. Buys/sells, 1% fee, sniper tax, wallet cap, modes (TRENCH / Easy / Hard, PVE rewards), graduation trigger at 72% sold. |
| `src/libraries/CurveMath.sol`, `McapMath.sol`, `FeeMath.sol`, `Constants.sol`, `Altitude.sol`, `FloorBands.sol`, `SqrtPrice.sol` | ~410 | Curve math, fee split, constants, tier/altitude, floor bands. |
| `src/CurveFeeVault.sol` | 286 | Holds curve-phase fees for lp-accrue curves; settle, claims, stealth-owner claims by EIP-712 signature. |
| `src/FeeRouter.sol` | 341 | Splits every 1% fee 33/33/33/1 (creator / LP / treasury / referral-or-KOL). Creator and referrer accruals, claim routers. |
| `src/Migration.sol` | 115 | Same-transaction graduation into a Uniswap v4 pool at the curve-end price ("no-jump"). |
| `src/DiscipleHook.sol` | 434 | v4 hook on every graduated pool. Pool LP fee is 0; the hook takes the 1% in the unspecified currency and routes it to FeeRouter; LP-add allowlist; EMA reference price; triggers LockedLP compounding. |
| `src/LockedLP.sol` | 548 | Owns the graduated full-range position forever (no removal path). Compounds the LP share back into it; floor bands; receives creator fees routed to "lock". |
| `src/TrampWallManager.sol` | 317 | User single-sided concentrated orders ("tramps"/"walls"); permissionless `pull` once filled, with a keeper tip. |
| `src/QuotePricer.sol`, `libraries/TwapOracle.sol`, `PoolDepth.sol`, `BasePools.sol` | ~450 | Quote-token USD price used at launch and for display; lagged, truncated TWAP with permissionless `poke`; listed quotes priced via 1-2 hop routes. |
| `src/QuoteProbe.sol` | 120 | Launch-time honeypot / fee-on-transfer probe for custom quote tokens. |
| `src/DiscipleRouter.sol`, `libraries/UsdgRouteLib.sol`, `CurrencySettler.sol` | ~1,050 | User entry point: curve and v4 buys/sells, USDG in/out via routed pools, Permit/Permit2 (gasless) paths, `launchWithUsdg`, `claimCreatorFeesToUsdg`. |
| `src/ReferralRegistry.sol` | 84 | First-touch referrer, finalized by a ≥ $10 USDG deposit; attestors. |
| `src/UsdgDepositNotifier.sol` | 96 | USDG deposit escrow / attestation feeding the referral gate. |
| `src/LoginGate.sol` | 63 | Signed login epochs required for PVE coins. |
| `src/RewardsVault.sol` | 35 | Receives timed-out sniper-tax escrow; owner distributes. |
| `src/utils/Owned2Step.sol` | 27 | Two-step ownership used by most contracts. |

Add-ons:

| File | nSLOC | Role |
|---|---|---|
| `src/addons/CreatorFeeHarvest.sol` | 472 | Launch wrapper that fixes a coin's creator-fee destination at launch: keep, lock into LockedLP, or buy-and-burn. Permissionless `route` / `routeWith` pull the fees and lock/burn them; post-graduation it sells rocket tokens for quote and burns it. **LockedLP stores this address as an immutable.** |
| `src/addons/AnonLauncher.sol` | 325 | Private launches: AnonLauncher is `creatorOf`; a stealth owner claims by EIP-712 signature; relayer fee. |
| `src/addons/MarketLens.sol` | 136 | View-only aggregation for the frontend (spot prices, never an oracle). |

Account abstraction (EntryPoint v0.7, Alchemy Modular Account v2, ERC-6900):

| File | nSLOC | Role |
|---|---|---|
| `src/paymaster/DisciplePaymasterV5.sol` | 682 | USDG gas paymaster: players pre-fund USDG credit; signer-quoted rate; reservations in validation, charge in postOp; one unsecured "setup" op per account. **This is the version that ships.** |
| `src/session/DiscipleSessionPolicyV143.sol` | 666 | ERC-6900 session-key validation + execution hooks: target/selector allowlist, calldata parsing, spend caps (cap0 = gas, per-coin caps), expiry, revocation. **This is the version that ships.** |

Out of scope: `src/AntiSnipe.sol` (legacy, not deployed), `src/paymaster/DisciplePaymaster.sol` (retired v4),
`src/session/DiscipleSessionPolicy.sol` (superseded), `src/interfaces/*` (except as they define behaviour), `script/`,
`test/`, and everything outside `contracts/` (web, indexer, SDK).

## 4. How it works

**Launch.** `Launchpad.launch*` deploys a `Token` (1M supply, minted once to the Launchpad and handed to the curve) and a `BondingCurve` through
`CurveDeployer`, registers the coin with `FeeRouter` (quote token, launch KOL) and optionally runs the creator's First
BOOST buy, capped at `creatorBuyMaxBps` (7.77%). The quote token defaults to STRATEGY; USDG, WETH and up to 12 listed
quotes are expected. `QuotePricer.quotePriceUsd(quote)` is read once at launch and baked immutably into the curve's
USD parameters and later into the hook.

**Curve phase.** Constant-product virtual-reserve curve (`CurveMath`). Every buy/sell pays a 1% fee. On lp-accrue
curves the fee is held on the curve and settled into `CurveFeeVault` (on graduation, on referred trades, or by anyone
calling `settleFees`). A sniper tax (99% falling to 0 over the first 7 seconds, per-second table) is escrowed on the
curve: it goes to LockedLP's compound bucket at graduation, or to RewardsVault if the coin hasn't graduated within
`snipeEscrowTimeout` (12 days). Modes add rules: optional wallet cap with partial fills and refunds, PVE "NET"
bookkeeping and reward claims, an Easy-mode crew tip on large profitable sells, login gating.

**Graduation.** When 72% of supply is sold, the curve calls `Migration.migrate`, which initializes the v4 pool
(only LockedLP may initialize, enforced in `beforeInitialize`) at the curve-end price and seeds LockedLP's permanent
full-range position plus single-sided floor bands. Leftover quote goes to the compound bucket.

**After graduation.** Trades go through v4 with `DiscipleHook`. The pool LP fee is 0. The hook takes 1% of the
unspecified side and sends it to `FeeRouter.routeHookFee`: 33% creator (accrues, claimable), 33% LP share (goes to
LockedLP buckets and is compounded into the locked position, rate-limited and guarded against the hook EMA), 33%
treasury, 1% to the trader's referrer or the coin's launch KOL. Only LockedLP and TrampWallManager may add liquidity.
`DiscipleRouter` is the only trusted router for trader attribution via `hookData`.

**Creator-fee routing.** If a coin was launched through `CreatorFeeHarvest` with destination 1 (lock) or 2 (burn),
the creator cannot self-claim. Anyone can call `route(token)` to pull the creator's accrued fees (FeeRouter and
CurveFeeVault) and lock them into LockedLP or burn them; destination 2 also sells accrued rocket tokens for quote
(chunked to ≤ 3% impact, floored at the hook EMA) and burns the proceeds.

**Gas and sessions.** Players hold USDG credit in `DisciplePaymasterV5`. A backend signer quotes a USDG/ETH rate and
a max token cost per op, either exact-op or as a reusable per-sender allowance. Validation reserves credit; postOp
charges the actual cost. Session keys are installed on the player's MAv2 account with `DiscipleSessionPolicyV143`,
which limits what the key may call and how much it may spend.

## 5. Privileged roles and trust assumptions

- **Owners.** Every contract has an owner (mostly `Owned2Step`; DiscipleHook uses a one-step `admin`; LoginGate,
  ReferralRegistry, UsdgDepositNotifier, TrampWallManager and DiscipleRouter use one-step ownership). On mainnet each
  goes to a Safe, with a timelock on wiring setters. The setter list is in `docs/mainnet/SEC-04-ownership-handover.md`
  (repo root). Owner powers that can redirect funds or break trading are known and accepted (SEC-04); please report
  ones that are missing from that list, or that can brick funds even with an honest owner.
- **One-shot wiring:** `DiscipleHook.setMigration`, `Migration.setLaunchpad`, `FeeRouter.setLaunchpad`,
  `CreatorFeeHarvest.wire`.
- **Off-chain signers:** the paymaster quote signer; the LoginGate attester; ReferralRegistry and UsdgDepositNotifier
  attestors (hot backend keys). Assume a signer key can leak; tell us what that costs.
- **Keepers:** a minutely `QuotePricer.poke` cron, an hourly `CreatorFeeHarvest.route/routeWith` cron, tramp/wall
  `pull` bots. All are permissionless functions; assume anyone (including MEV searchers) can call them at any time.
- **Tokens:** USDG is Paxos USDG (6 decimals on mainnet, upgradeable, can freeze). Quote tokens are assumed to be
  plain ERC-20s that transfer exact amounts; QuoteProbe is the only defence for custom quotes.
- **Chain:** centralized sequencer, low fees, short blocks. Consider multi-block price manipulation as cheap.

## 6. Invariants we rely on

1. Locked liquidity can never be removed, by anyone, including the owner.
2. FeeRouter and CurveFeeVault always hold at least the sum of what they owe (creators, referrers, treasury), per token.
3. A curve's quote balance always covers `quoteReserve` + escrows; rounding always favours the curve.
4. Every wei of a fee goes somewhere (the split is exact; dust goes to the 1% leg).
5. Nobody but LockedLP can initialize a DISCIPLE pool; nobody but LockedLP/TrampWallManager can add liquidity to it.
6. Graduation can't be blocked or front-run into a bad price, and a failing graduation can't brick the curve.
7. A session key can never spend more than its caps, and can never move funds to an address the owner didn't allow.
8. The paymaster's ETH deposit can't be drained faster than players pay USDG for it.
9. `minOut` / slippage on every user path bounds what the user actually receives.

## 7. Known issues: please don't re-report these as new

Full details and PoCs are in `contracts/docs/audit-2026-11-14.md` and `contracts/docs/security-review.md`.
**We do want to hear if a proposed fix below is wrong, or if you find a cheaper or worse variant.**

Still open, fix pending:
- **SK-1 (High):** a stolen session key can sweep the whole wallet into paymaster credit (deposits aren't counted
  against the cap) and burn it with ops that pass validation and revert in execution (the gas debit lives in the
  execution hook, which a revert rolls back). PoC: `test/paymaster/OpenFinding_SK1.t.sol`.
- **SK-2 (Medium):** the session policy doesn't check who pays gas; ops paid by other paymasters or by the account
  aren't capped.
- **HK-02 (Medium):** flash pump → `QuotePricer.poke` → dump persists in the lagged TWAP. PoC: `OpenFinding_HK02`.
- **LB-01 / HK-03 (Medium):** listed quotes are priced from live 1-2 hop spot at launch (depth floor uses in-range
  liquidity) and that price is fixed into the curve forever. PoC: `OpenFinding_LB01`.
- **RT-01 (Medium):** USDG buys of non-USDG-quoted coins have no minimum on the USDG→quote and refund legs; when the
  curve output is capped, `minTokensOut` can't protect it. PoC: `OpenFinding_RT01`.
- **PM-3 (Medium):** the unsecured setup op is sybil-able while bootstrap codehash enforcement is off.
- Low/Info: LB-02 crew tip avoidable by splitting sells; CH-05 refund swap `minOut = 1`; HK-06 auto-discovered price
  pool squatting; HK-07 no TWAP staleness bound; HK-08 no minimum tramp/wall size; RT-03 router owner powers / one-step
  ownership; FR-03 vault applies config changes to already-owed fees; FR-05 pending referrer never expires; PM-4
  failed postOp freezes credit until a global pause; PM-5 retired v4 paymaster still funded; AN-01 batch claim fails
  whole on one bad entry; LB-04 exact-transfer quote assumption; LB-05 one-step `transferCreator`; HK-09 QuoteProbe
  outcome forgeable by a token's `balanceOf` revert; HK-10 EMA speed limit stalls compounding after big moves;
  CH-07 no keeper reward; AN-02/AN-03/RT-04/RT-05/FR-06..08 minor.

Already fixed on this commit (please check the fixes):
- **HK-01:** `PoolManager.donate` to a DISCIPLE pool used to brick LockedLP compounding forever (positive delta
  reverted). Now credits are taken into the bucket (`LockedLP._compound`, `_split`).
- **CH-01:** harvest burn sell was one unbounded swap; now chunked by `quoteExactIn` impact and floored at the EMA.
- **CH-02 / CH-03 / CH-04 / CH-06:** harvest USDG launch underflow, anon fee+boost approval, middle-creator fees
  (`routeWith`), pre-graduation token locks.
- **FR-01 / LB-03:** `FeeRouter.setLaunchpad` is one-shot (a repoint bricked every live curve).
- **FR-02:** `registerTokenQuote` / `registerTokenLaunch` are write-once; harvest pointer must be a contract.
- **HK-04 / HK-05:** LockedLP refuses pre-graduation token deposits and mismatched quotes from the harvest.
- **PM-1 / PM-2:** dust deposit no longer blocks the setup op; owner gas price caps (`setGasPriceCaps`).
- **RT-02:** zero minimums refused on `claimCreatorFeesToUsdg` and the `launchWithUsdg` swap leg.
- Earlier: SEC-01 (LockedLP add auth), SEC-02 (JIT, donation removed + LP-add allowlist), SEC-03 (TWAP for unlisted
  quotes), SEC-05 (UniversalRouter attribution), SEC-09 (pricer removed from swap path).

By design (please don't report unless you show real harm beyond what's described): permissionless `pull`
force-filling a tramp/wall at its own range price (SEC-06); quote sent directly to a curve is stuck (R-5); sybil
self-referral captures the 1% leg (FR-07); the AnonLauncher relayer fee goes to whoever submits (SEC-08);
display-only values (altitude, tier breaks, `Trade.mcapAfterUsd`, MarketLens) read spot and can be moved for a block.

## 8. Where we most want your attention

1. **Session policy V143 + paymaster V5 together.** Anything that lets a session key, a self-bundler, or a stranger
   drain a player's USDG or the paymaster's ETH. Calldata parsing of `execute` / `executeBatch` / `executeUserOp`,
   approve/recipient pinning, cap accounting across validation vs execution, ERC-7562 rule compliance in validation.
2. **Hook delta accounting and LockedLP compounding.** Sign conventions in `beforeSwap`/`afterSwap` for all four
   exact-in/exact-out directions, unlock-callback reentrancy, the compound guard (EMA, block reference, per-window
   cap), and the new `_compound` credit path.
3. **Graduation.** Front-running or griefing `Migration.migrate`, the no-jump price, floor-band seeding, and any way
   to make `_graduate` revert forever.
4. **Oracle and pricing.** QuotePricer TWAP, listed routes, the depth floor, and anything that mis-scales a coin's
   USD parameters at launch.
5. **Fee solvency.** FeeRouter, CurveFeeVault, the harvest's pulls, claim routers, and KOL/referral resolution:
   double claims, claims for others, stranded fees, and accounting that diverges from balances.
6. **CreatorFeeHarvest sell path.** Sandwich exposure that remains within the 3% band, the chunking loop, and
   interactions with the hook's `swappedInTx` and EMA.
7. **Router USDG routes and Permit2 witness.** Every path where the router spends, refunds, or holds funds.
8. **Gas.** Hot paths are the curve buy/sell (~178k warm), the v4 swap through the hook, and the 2-hop USDG v4 buy
   (~319k warm). Our own estimates are in `audit-2026-11-14.md` ("Gas"); tell us about anything larger.

## 9. Useful docs in the repo
- `contracts/docs/protocol-constitution.md`: product rules (the "LOCKED" table is the spec).
- `contracts/docs/curve.md`, `bonding-modes.md`, `mode-rules-v2.md`: curve formula and modes.
- `contracts/docs/frontend-api.md`, `usdg-router.md`, `usdg-paymaster.md`, `session-keys.md`, `anon-launch-v0.md`.
- `contracts/docs/mainnet-plan.md`, `redeploy-runbook.md`, `docs/mainnet/SEC-04-ownership-handover.md`: deploy and
  ownership plan.
- `contracts/docs/security-review.md`, `contracts/docs/audit-2026-11-14.md`: earlier findings.
