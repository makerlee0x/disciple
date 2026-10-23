# DISCIPLE USDG token paymaster (EntryPoint v0.7)

Status: **design + build in progress (PR draft, nothing deployed)** · approved by maker lee, Fri Oct 23 2026 · RH testnet only (chain 46630).

## Locked rules
- Users never need ETH. Gas is paid **out of the user's own USDG**. We do **not** sponsor gas.
- Self-hosted: our own contract, our own signer, our own bundler. **No Pimlico hosted service** (their v0.7 singleton at
  `0x7777…834C` on 46630 is reference only).
- Testnet only until review; no deploys in this PR; merge nothing.

## Base contract: fork Pimlico `SingletonPaymasterV7` (ERC-20 mode), trimmed → `DisciplePaymaster`

| | Pimlico SingletonPaymaster (ERC-20 mode) | eth-infinitism `TokenPaymaster` |
|---|---|---|
| Pricing | **signed off-chain quote** (exchangeRate, validUntil/After) — exactly our "signed quote" requirement | on-chain oracle (Chainlink + Uniswap swap helper); no oracle for USDG/ETH on RH chain |
| Charge | postOp on actual gas (+ v0.7 unused-gas penalty accounted) | pre-charge max in validation, refund in postOp (needs a standing allowance → breaks our exact-approve rule) |
| v0.7 | yes (`SingletonPaymasterV7`), audited, MIT | yes, MIT, but sample-grade |
| Fit | strip verifying mode, multi-signer, manager role, constantFee/recipient/preFund flags, bundler allowlist | would need oracle replacement + allowance model rewrite |

Pimlico's ERC-20 path is the closest match (signed rate + postOp billing), so we fork it and remove what we don't use.
Kept (with attribution): paymasterAndData parsing style, the signed-hash construction over the packed userOp,
`getCostInToken`, `_expectedPenaltyGasCost` (v0.7 charges the paymaster 10% of unused execution gas; we bill it).
Changed / added for DISCIPLE:
- **USDG-only**: token is an immutable; no token field in the quote.
- **Quote = (validUntil, validAfter, rate, maxTokenCost)** signed by one owner-set `signer`. `rate` = USDG raw units per
  1e18 wei (decimals-aware: 18-dec testnet USDG and 6-dec mainnet USDG are both just "raw units per ETH").
  `maxTokenCost` = the exact USDG allowance the batch grants the paymaster (gas max in USDG + any outstanding debt).
- **Rate cap / sanity bounds** (owner-set): `minRate ≤ rate ≤ maxRate`, `maxTokenCost ≤ maxCostCap`,
  `validUntil − validAfter ≤ MAX_QUOTE_WINDOW` (validation can't read TIMESTAMP under ERC-7562; the EntryPoint enforces
  the window), and `maxTokenCost ≥ costInToken(requiredPreFund) + debt` (the signed max must cover the worst case).
- **Validation checks USDG balance and allowance**: `balanceOf(sender) ≥ maxTokenCost` and either the existing
  `allowance(sender, paymaster) ≥ maxTokenCost` or the batch's **first call** is `USDG.approve(paymaster, maxTokenCost)`
  (decoded from `execute`/`executeBatch`, with or without the MAv2 `executeUserOp` prefix).
- **postOp never reverts** (a reverting postOp makes the EntryPoint revert the user's call *and* bill our deposit):
  it tries `transferFrom(sender → treasury, min(actualCostInToken, maxTokenCost))`; if that fails (user moved the USDG,
  or the batch reverted and took the approve with it) the amount is recorded as `debtOf[sender]`. Validation requires
  the next quote's `maxTokenCost` to include the debt, so it is collected on the next op. Loss is bounded to one op per
  abandoned account, and every quote is gated by our signer, which only signs after simulation.
- **Owned2Step** (same as the rest of the stack): owner sets `signer`, `treasury`, rate bounds, `maxCostCap`,
  `postOpGas`; owner-only `withdrawTo` (EntryPoint deposit), `addStake` / `unlockStake` / `withdrawStake`, `forgiveDebt`.

## Flow (one userOp, session key or owner)
1. Client builds the trade calls (unchanged) and asks `/api/paymaster` `pm_getPaymasterStubData` with the unsigned op
   (gas limits + fees). The API returns `paymaster`, `paymasterVerificationGasLimit`, `paymasterPostOpGasLimit`, the
   quote (`rate`, `maxTokenCost`, `validUntil`, `validAfter`) and stub `paymasterData`.
2. Client prepends `USDG.approve(paymaster, maxTokenCost)` to the batch (exact amount), sets the paymaster fields.
3. Client calls `pm_getPaymasterData` with the final op; the API re-derives the same quote, checks the approve, the
   user's USDG balance (trade spend + maxTokenCost), simulates, and signs → `paymasterAndData`.
4. Session key / owner signs the userOp (covers paymasterAndData). Self-bundler relays: **no ETH-prefund check** for
   paymaster ops; instead it checks the paymaster's EntryPoint deposit ≥ op max cost and the paymaster gas caps.
5. EntryPoint: account validation (policy hook) → `validatePaymasterUserOp` (sig, bounds, balance, allowance) →
   execution: `approve(paymaster, maxTokenCost)`, the trade (policy exec hook counts `maxTokenCost` against the USDG
   session cap) → `postOp`: pull actual USDG cost to treasury.
6. Keeper tops up the EntryPoint deposit from the relayer/treasury (testnet) and, on mainnet, swaps collected USDG→ETH.

paymasterAndData (v0.7): `paymaster(20) | pmVerificationGas(16) | pmPostOpGas(16) | validUntil(6) | validAfter(6) |
rate(32) | maxTokenCost(32) | signature(65)` = 193 bytes. Signed hash = `toEthSignedMessageHash(keccak256(abi.encode(
sender, nonce, keccak(initCode), keccak(callData), accountGasLimits, pmGasLimits(bytes32 of [20:52]), preVerificationGas,
gasFees, chainid, paymaster, validUntil, validAfter, rate, maxTokenCost)))`.

## Session policy change (minimal)
`DiscipleSessionPolicy` gets a second constructor immutable, `paymaster` (like `referralRegistry`; **SessionConfig ABI
unchanged**). In the execution hook (which sees the full userOp through MAv2's `executeUserOp` buffer):
- `USDG.approve(paymaster, amt)` is allowed only if the op's `paymasterAndData` names this paymaster and
  `amt == maxTokenCost` from it (exact-amount rule); `amt == 0` (revoke) is always fine; any other path → `SpenderNotAllowed`.
- `amt` is counted against the USDG spend slot (quote0/quote1 == USDG). It is the **upper bound** of the gas fee (the
  hook runs before gas is known); the actual charge is ≤ it. Sessions that don't list USDG as a capped quote can't use
  the paymaster (refused like any other uncapped outflow).
- `moduleId` → `disciple.session-policy.1.4.0`. Requires policy redeploy + session reinstall (SITE handoff below).

## File list
Contracts
- `contracts/src/paymaster/DisciplePaymaster.sol` (new) · `contracts/src/paymaster/IEntryPointV07Min.sol` (min interfaces)
- `contracts/src/session/DiscipleSessionPolicy.sol` (paymaster spender + cap)
- `contracts/script/DeployPaymaster.s.sol`, `contracts/script/DeploySessionPolicy.s.sol` (new arg)
- `contracts/test/paymaster/DisciplePaymaster.t.sol` (local EntryPoint v0.7 + SimpleAccount), `contracts/test/session/SessionPaymaster.t.sol`
- test-only dep: eth-infinitism `account-abstraction` v0.7.0 vendored under `contracts/test/vendor/aa-v07/` (EntryPoint, SimpleAccount)
Web
- `web/lib/aa/paymaster.ts` (pure: encode/decode paymasterAndData, hash, cost math — shared client/server)
- `web/lib/server/paymasterQuote.ts` (rate source, signer from `PAYMASTER_SIGNER_KEY`), `web/app/api/paymaster/route.ts`
- `web/lib/aa/gasPolicy.ts` (paymaster gas limits), `web/lib/server/selfBundler.ts` + `fastRelay.ts` (skip ETH prefund,
  check paymaster deposit), `web/lib/aa/mav2.ts` (prepend exact approve, fetch paymasterAndData), `web/lib/server/relayTrust.ts`
- `web/scripts/paymaster-keeper.mts` (deposit top-up), `web/scripts/test-paymaster.mts` (unit tests)

## Pricing (`/api/paymaster`)

`rate` = USDG base units per 1 ETH (1e18 wei); `tokenCost(wei) = ceil(wei * rate / 1e18)`. Decimals come from
`USDG.decimals()` on-chain (18 on testnet mUSDG, 6 on mainnet USDG `0x5fc5…d168`) — no `1e18` assumption anywhere.

**Testnet (implemented):** fixed, configurable rate from server env — `PAYMASTER_RATE` (integer base units per ETH)
or `PAYMASTER_USD_PER_ETH` (e.g. `3000`, scaled by the on-chain decimals). The server refuses to sign if the rate is
outside the contract's `[minRate, maxRate]`.

**Mainnet (design only — not implemented, not deployed):**
1. Source: the USDG/WETH Uniswap v3 pool on RH mainnet. Read `observe([1800, 0])` → 30-minute arithmetic-mean tick
   → TWAP price, converted to USDG base units per 1e18 wei using `USDG.decimals()` (6) and WETH decimals (18), with
   token0/token1 ordering handled.
2. Sanity: read `slot0` spot; refuse to quote if |spot − TWAP| > 2% (manipulation or a fast move) or if the pool's
   in-range liquidity is below a floor; require the pool's observation cardinality to cover 30 min.
3. Margin: quote `rate = TWAP × (1 + 1%)` so a move inside the quote TTL (≤ 3 min) can't make the paymaster pay.
4. Clamp: the contract's `minRate`/`maxRate` (owner-set, e.g. ±25% of the launch price, reviewed weekly) are the
   hard backstop; the server never signs outside them even if the TWAP says so.
5. Cache the TWAP for ~15 s per server instance; the quote still re-reads the sender's debt and balance per op.
6. Fallback: if the pool read fails or a sanity check trips, answer `-32003` (paymaster unavailable) — never fall back
   to a stale fixed rate on mainnet.

## Risks
1. **Absorbed gas on reverted ops** — mitigated by validation balance/allowance checks, signer-gated quotes after
   simulation, debt carry-forward; residual: one op per abandoned account. Monitor `DebtRecorded` events.
2. **Rate staleness / manipulation** — testnet fixed rate; mainnet TWAP (≥30 min) from the USDG/WETH v3 pool with
   `minRate/maxRate` on-chain clamps and short quote windows (≤ 2 min). A bad rate only mis-prices one op ≤ maxCostCap.
3. **Signer key compromise** — signer can only issue quotes within on-chain bounds; it cannot move funds. Owner rotates
   `signer`. Key only in env (`PAYMASTER_SIGNER_KEY`), never committed.
4. **Deposit drain / exhaustion** — bundler checks deposit before relaying; keeper tops up; owner `withdrawTo`.
5. **ERC-7562** — validation reads `balanceOf[sender]` (associated) and `allowance[sender][paymaster]` (associated with
   the staked paymaster); paymaster must be **staked** (context is non-empty). Our own bundler doesn't enforce 7562 but
   we stay compliant so a third-party bundler works later.
6. **Policy redeploy / session reinstall** — every user must reinstall their session; old sessions keep working without
   the paymaster (ETH path) until SITE flips the flag.
7. **Decimals** — all amounts raw-unit; 18 on testnet, 6 on mainnet. Site has hard-coded `/1e18` for USDG display
   (`web/lib/protocol-viem.ts` `tradeViaUsdg` "not enough cash" message, line ~538) — flagged, must use USDG decimals.
8. **Penalty math** — v0.7 bills the paymaster 10% of unused execution gas; we bill the user for it (Pimlico's formula),
   so over-estimated callGasLimit costs the user a little. STATIC_GAS (1.8M call) should be tightened for paymaster ops.

## Estimate (realistic)
| Day | Work |
|---|---|
| Fri Oct 23 | design doc, draft PR, contract + Foundry suite on local EntryPoint v0.7 |
| Mon Oct 26 | session policy change + tests; deploy scripts (not run) |
| Tue Oct 27 | `/api/paymaster` + shared encoder + unit tests; bundler changes (skip prefund, deposit check, gas caps) |
| Wed Oct 28 | client wiring in mav2 (approve-prepend, stub/final), keeper script; testnet dry run on a fork |
| Thu Oct 29 | review fixes; testnet deploy (after approval) + policy redeploy + session reinstall by SITE |
| Fri Oct 30 | e2e on testnet, monitoring (DebtRecorded, deposit), buffer |
Realistic code-complete: **Wed Oct 28**; testnet live after review: **Fri Oct 30, 2026**. Mainnet TWAP pricing: design only.
