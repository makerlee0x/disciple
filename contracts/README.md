# /contracts

Owned by the **DISCIPLE FLOW** workstream (smart contracts, bonding curve, Uniswap v4 graduation, indexer).

Do not add application or game UI files here. The web front end lives in `/web`.

---

# DISCIPLE Smart Contracts (scaffold)

**Product:** DISCIPLE (formerly ANYPAIR)  
**Scope:** v0 — Robinhood Chain (EVM)  
**Stack:** Foundry (forge) + Solidity 0.8.26 (pinned; see DEPENDENCIES.md) + OpenZeppelin v5  
**Source of truth:** [`docs/protocol-constitution.md`](docs/protocol-constitution.md)

Working scaffold (Pump-style CPAMM + real Uniswap v4 graduation); **not audited** production. Deps: `lib/v4-core`, `lib/v4-periphery` (forge install).

## Frontend API

The events (`Launched`, `GraduatedToV4`, unified `Trade`), quoters, permit and recipient paths, `DiscipleRouter`, `QuotePricer` trust assumptions and deploy env are all covered in [`docs/frontend-api.md`](docs/frontend-api.md).

## Quick start

```bash
export PATH="$HOME/.foundry/bin:$PATH"
forge build
forge test
```

Deploy stub (anvil / RH RPC):

```bash
forge script script/Deploy.s.sol --tc Deploy --rpc-url "$ROBINHOOD_RPC_URL" --broadcast
```

## File → constitution map

| Path | Role | Constitution |
|------|------|----------------|
| `src/libraries/Constants.sol` | Named protocol constants (7B, $12K→$77K, fees, anti-snipe, caps) | LOCKED #6–#12, #18, #27; §2, §3, §4, §9 |
| `src/libraries/FeeMath.sol` | 33/33/33/1 split, tax, wallet/curve caps | §3 Fees; LOCKED #11–#12 |
| `src/Token.sol` | ERC-20, 18 dec, 7B fixed, no further mint, CREATE | §2; LOCKED #7, #10 |
| `src/BondingCurve.sol` | Pump-style CPAMM curve; optional per-wallet cap (`Launchpad.walletCapBps`, default 0 = off); graduate trigger | §2 Option B; LOCKED #5–#8 |
| `src/libraries/CurveMath.sol` | Single CPAMM buy/sell math; quotePriceUsd scaling | §2; LOCKED #5–#7 |
| `src/QuotePricer.sol` | Launch-time quote/USD oracle (USDG=$1, else quote/USDG v4 spot) | §2 |
| `src/TrampWallManager.sol` | Tramps & walls: single-sided concentrated v4 ranges (support/resistance) | #42 |
| `src/CurveDeployer.sol` | BondingCurve factory (Launchpad size) | — |
| `src/DiscipleRouter.sol` | Post-grad exact-in buy/sell + quoteExactIn via v4 unlock | §3 |
| `src/interfaces/ITradeEvents.sol` | Unified `Trade` event (curve + hook) | — |
| `docs/curve.md` | Curve formula, worked table, rounding | §2 |
| `src/Launchpad.sol` | Permissionless factory; metadata; optional creator buy ≤0.77% | §5; LOCKED #23–#27 |
| `src/FeeRouter.sol` | Fee split routing; creator/referrer accrue; treasury push; LP auto-add | §3; LOCKED #11–#15, #20–#22 |
| `src/AntiSnipe.sol` | Buy fee 77.7%→0% over 7s | §2; LOCKED #9 |
| `src/ReferralRegistry.sol` | First-touch; $10 USDG gate hooks | §4; LOCKED #18–#19 |
| `src/Migration.sol` | Real same-tx v4 migrate (no-jump sqrtPrice, full-range → LockedLP) | §2; LOCKED #5, #17 |
| `src/DiscipleHook.sol` | Post-grad 1% swap fee → FeeRouter 33/33/33/1 (**pool LP fee = 0**) | §3; LOCKED #11,#16 |
| `src/QuoteProbe.sol` | Quote probe (honeypot/FoT reject; STRATEGY/WETH/USDG always-pass) | §6; LOCKED #31–#32 |
| `src/LockedLP.sol` | Forever v4 LP owner; removeLiquidity reverts; unlock-seed | §3; LOCKED #16–#17 |
| `src/LockedLP.sol` | Permanent lock + fee collect stub; `removeLiquidity` reverts | §3; LOCKED #16–#17 |
| `src/interfaces/*.sol` | Protocol interfaces | matching sections |
| `src/interfaces/v4/*` | Minimal PoolManager / Hooks stubs | §2 (deps deferred) |
| `src/interfaces/IQuoteProbe.sol` | Quote probe interface (honeypot/FoT) | §6; LOCKED #31–#32 |
| `test/FeeMath.t.sol` | Smoke: fee shares, supply, Pearly Gates, anti-snipe consts | §2–§3 |
| `test/Launchpad.t.sol` | Smoke: permissionless launch + metadata/tax guards | §5 |
| `test/Curve.t.sol` | Curve: worked table, fuzz round-trip/monotonic, graduate | §2 |
| `test/Migration.t.sol` | v4: pool created, price continuity, LP locked, post-grad 1% fee | §2 |
| `script/Deploy.s.sol` | Deploy wiring stub | ops |

## Encoded constants (selected)

| Constant | Value |
|----------|-------|
| `TOTAL_SUPPLY` | 7_000_000_000e18 |
| `START_MCAP_USD` | $7,000 (Launch Pad) |
| `PEARLY_GATES_MCAP_USD` | $33,000 (graduation) |
| `CURVE_SOLD_BPS` | 7200 (72% exactly at grad) |
| `WALLET_CAP_BPS_DEFAULT` | 0 (no cap; owner-settable via `Launchpad.setWalletCapBps`, snapshotted per coin) |
| `TRADE_FEE_BPS` | 100 (1%) |
| Fee shares | 33 / 33 / 33 / 1 |
| `CREATOR_TAX_MAX_BPS` | 700 (≤7%, immutable) |
| Anti-snipe | 7770 → 0 BPS over 7s; excess → 70% RewardsVault / 30% treasury |
| `CREATOR_BUY_MAX_BPS` | 77 (0.77%) |
| `REFERRAL_USDG_GATE` | 10e18 USDG |

## Bonding curve (Pump-style CPAMM)

See [`docs/curve.md`](docs/curve.md).

- **Single** constant-product virtual-reserve curve (steep / Pump-like).
- Start **$7K** → Pearly Gates **$33K** exactly at **72%** supply sold.
- **Quote:** any ERC-20 with a registered quote/USDG pool; USD targets scaled by the on-chain `QuotePricer` price at launch (see docs/frontend-api.md).
- **Rounding:** floor against user on buy and sell (fuzzed no round-trip profit).
- Raise to grad (net of fees on curve) ≈ **$10,943**.

Worked mcaps at 0 / 10 / 25 / 50 / 72% sold: **$7K / ~$8.2K / ~$10.6K / ~$17.9K / $33K**.

## Explicit stubs / TODOs

1. **KOL 3% of creator fees** on coins created by referred wallets — not yet wired (§4 #21).
3. **Quote probe** — interface only (§6).
4. **Upgradeable / multisig** — constitution LOCKED #35; scaffold is non-upgradeable for clarity.

## Layout

```
contracts/
  foundry.toml
  remappings.txt
  README.md
  src/
    libraries/Constants.sol
    libraries/FeeMath.sol
    libraries/CurveMath.sol
    Token.sol
    BondingCurve.sol
    Launchpad.sol
    FeeRouter.sol
    AntiSnipe.sol
    ReferralRegistry.sol
    Migration.sol
    LockedLP.sol
    interfaces/...
    interfaces/v4/...
  test/
    FeeMath.t.sol
    Launchpad.t.sol
    Curve.t.sol
  docs/
    curve.md
  script/
    Deploy.s.sol
  lib/
    forge-std/
    openzeppelin-contracts/
```

## Target chain

Robinhood Chain (EVM). RPC placeholder: `foundry.toml` → `[rpc_endpoints].robinhood`.


## Default quote (STRATEGY)

- `Launchpad.defaultQuote` — owner/multisig settable (STRATEGY on Robinhood Chain).
- `launch` / `launchCoin` with `quote = address(0)` resolves to `defaultQuote`.
- Custom quotes still allowed when `quote != 0` and `QuoteProbe` does not hard-reject.
- Verified mcap **tiers are off-chain/indexer**; contracts emit `Launched` + `LaunchTierContext` (no on-chain tier hooks).


## Dependencies (not vendored in this PR)

`lib/` is **excluded** from the repo. After clone:

```bash
cd contracts
forge install foundry-rs/forge-std uniswap/v4-core uniswap/v4-periphery OpenZeppelin/openzeppelin-contracts --no-commit
```

See `foundry.toml` remappings and `DEPENDENCIES.md`. Optional `.gitmodules` appears after a maintainer runs `forge install` without `--no-commit`.

**Note:** deps are pinned (see DEPENDENCIES.md); solc 0.8.26 compiles v4-core unpatched.
