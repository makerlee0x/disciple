# Private launch: relayer takes the dollars, leftover goes to the player

This note is for auditors and for the branch `flow/anon-launch-relayer`, which sits on `flow/anon-first-buy` (`e28d849b`). It is the smallest change that matches lee's rulings:

- The relayer takes the player's dollars and submits the private launch itself. A visible payment to the relayer is OK. Private launches are always Trench. (Option b.)
- Make a small change to the anonymous launcher so any leftover First BOOST dollars go to a player address we name, not to `msg.sender`. (Option 2.)
- The front end still blocks exactly at the First BOOST cap. The contract is not deployed and nothing is sent on-chain in this branch.

This is a contract + website branch only. No merge, no deploy, no env change, no on-chain transaction.

## Existing solutions this is based on

- **Permit2 witness (0x Gasless / 0x-settler `SettlerMetaTxn.executeMetaTxn`).** The player signs one EIP-712 `PermitWitnessTransferFrom` whose witness is the whole private launch (every launch field, the exact USDG amount, `refundTo`, and the AnonLauncher address). This is the same pattern `web/lib/trade/gaslessPermit2.ts` and `DiscipleRouter.buyWithPermit2` already use for gasless trades. The difference is that the on-chain verifier here is Permit2 itself plus the relayer's Multicall3 batch, not a new router function.
- **Multicall3 gasless-withdraw.** The relayer submits one `Multicall3.aggregate3` transaction (`0xcA11bde05977b3631167028862bE2a173976CA11`) and never holds funds across transactions. Same admission gate as a gasless trade (Privy session, revoke / strike / blocklist), same `fastRelay.sendDirect` + simulate-before-submit. See `web/lib/trade/gaslessWithdraw.ts` and `web/lib/server/gaslessWithdrawRelay.ts`.
- **Uniswap-style router "recipient / refund to".** Leftover USDG is sent to a named `refundTo`, not to `msg.sender`. That is the usual router convention (Uniswap V2/V3 `to` / `recipient`, and the way `DiscipleRouter._toUsdg(..., to)` already refunds a public `launchWithUsdg` to its caller). It is what makes a Multicall3-as-caller path safe: leftovers must not land on the shared Multicall3 contract.

Checked and not used:

- A new helper contract that holds the dollars and refunds them. That would be a new contract mechanism. Lee already chose a small change to AnonLauncher instead.
- Changing `Launchpad` or `DiscipleRouter`. Launchpad is at 24,399 bytes of runtime bytecode, 177 bytes under the 24,576-byte limit, and must not change. The router already converts leftover pair token to USDG and sends it to its caller (AnonLauncher). AnonLauncher only needs to forward that USDG to `refundTo`.
- Having the player's own wallet remain `msg.sender` (the earlier `flow/anon-first-buy` path). That does not match "the relayer takes the dollars and submits the launch."
- A new login or trade mechanism, or a change to `GASLESS_GAS_LIMIT` or any cap. The launch uses a dedicated `ANON_LAUNCH_TX_GAS_LIMIT` (8,500,000), the same way withdrawals have their own cap.

## Money flow, step by step

Private launches stay in Trench mode. The player is the signed-in wallet (the same gasless login already in use). The on-chain creator of the coin stays AnonLauncher. Bought coins go to the stealth owner.

1. The front end reads the live Trench cap (`Launchpad.firstBoostMaxBps` / `creatorBuyMaxBps` and `quoteCreatorBuy`) and refuses an amount over the cap. MAX fills the cap and never more than that. On a USDG-paired coin the dollar max is exact (1:1). On a swapped pair (the default STRATEGY pair) the dollar max is the reverse-quoted cap, haircut 1% so a live quote at the cap is not already over.
2. The player signs one Permit2 witness. The signed amount is exactly `launchFee + usdgIn`, fixed up front. Every launch field is in the witness, including `refundTo = the player` and the AnonLauncher address. If Permit2 is not yet approved for USDG, a one-time EIP-2612 permit of USDG to Permit2 is included, the same way gasless trades and withdrawals do it.
3. The website POSTs `disciple_gaslessAnonLaunch` to `/api/gasless`. The server checks the session wallet, the revoke / strike / blocklist gate, the live `launchFee` (it must still match what was signed), the witness signature, and the request rules. It then simulates the Multicall3 transaction from the relayer. Nothing is sent if simulation fails.
4. The relayer submits one transaction to Multicall3:
   1. Optional `USDG.permit(owner, Permit2, …)`.
   2. `Permit2.permitWitnessTransferFrom`: pull exactly `launchFee + usdgIn` USDG from the player to Multicall3.
   3. `USDG.approve(AnonLauncher, amount)` from Multicall3.
   4. `AnonLauncher.launchAnonWithUsdg(..., refundTo = the player)`. AnonLauncher pulls the launch fee from Multicall3 to the treasury, pulls the First BOOST USDG from Multicall3, approves the trusted router, and calls `DiscipleRouter.launchWithUsdg` in Trench mode.
   5. `USDG.approve(AnonLauncher, 0)` so no leftover allowance sits on Multicall3.
5. Inside `launchWithUsdg`, the router swaps USDG to the pair token when needed (skipped when the pair is USDG), calls `Launchpad.launchFor(AnonLauncher, …)`, and if the buy is over the cap or the swap leaves unused pair token, it swaps that leftover back to USDG and sends the USDG to its caller (AnonLauncher).
6. AnonLauncher then forwards every leftover USDG it holds above its prior balance to `refundTo` (the player). `address(0)` means `msg.sender`, so a direct call from the player's wallet still refunds the player. `refundTo` cannot be the launcher itself.
7. AnonLauncher forwards bought coins to the stealth owner (or `buyRecipient`).

If any step reverts, the whole transaction reverts. The Permit2 transfer, the approve, and the launch never commit. That is the refund path: the player's dollars never move, and the relayer never holds funds across transactions.

## Every failure case

| Case | What happens |
| --- | --- |
| Simulation fails (bad signature, missing USDG, cap already exceeded at current price, slippage, fee too high, etc.) | Nothing is sent. The player's dollars do not move. |
| The included transaction reverts | The whole Multicall3 batch reverts. The player's dollars do not move. The existing strike policy may strike the sender only when the revert is sender-caused, same as a gasless trade. |
| First BOOST over the cap, but the tx is included (front end bypassed or the cap moved) | The curve fills only up to the cap. Unused USDG is refunded to the player (`refundTo`). Nothing stays on AnonLauncher or Multicall3. |
| Swap slippage / `minQuoteIn` | `DiscipleRouter` reverts `Slippage`. Whole tx reverts. Dollars do not move. |
| Owner raises `launchFee` after the player signs | Admission re-reads the live fee and rejects (`launch fee changed, please retry`) if it no longer matches. If it still changed in the same block after simulation, AnonLauncher reverts `FeeTooHigh`. Whole tx reverts. |
| Owner lowers `launchFee` in the same block after simulation | AnonLauncher pulls the lower live fee, not `maxFee`. The difference would otherwise stay on Multicall3. Admission already requires the signed `maxFee` to equal the live fee, so this only happens if the owner changes the fee in the same block. Residual risk, see below. |
| `refundTo` is the launcher | Reverts `BadRefundTo`. |
| `refundTo` is `address(0)` | Treated as `msg.sender`. For the relayer path the server requires `refundTo` to be the player, so this default is only for a direct wallet call. |
| Permit2 nonce already used / allowance missing | Simulation fails. Nothing is sent. |
| Session missing, revoked, struck, or blocklisted | Refused `notSent`. Nothing is sent. |
| Relayer / Multicall3 path is off (`clientGaslessMode()` false) | The existing wallet-submitted path is used, still with `refundTo = the player`. No new login. |

## Trust assumptions

- The relayer is lee's server. Permit2 authorizes Multicall3 to pull the signed USDG amount once; the `to` of that transfer and the later `launchAnonWithUsdg` call are not enforced by a dedicated on-chain verifier the way `DiscipleRouter.buyWithPermit2` enforces a trade witness. A compromised relayer could pull the signed USDG in one Multicall3 transaction and send it somewhere other than the launch. This is the same trust model as gasless withdrawals, which also use Multicall3 as the Permit2 spender. The signed witness still binds the player's intent, the server rebuilds the batch from those fields, and simulation runs before submit.
- The player trusts the front end to set `refundTo` to their own address and to block amounts over the cap. The server also requires `refundTo == signer`.
- USDG, Permit2, Multicall3, DiscipleRouter, Launchpad, and AnonLauncher behave as in this repository. No new token or new verifier contract.

## What is visible on-chain

- The player's wallet appears in the same transaction as the launch: a Permit2 transfer of USDG from the player to Multicall3, then from Multicall3 into AnonLauncher. A visible payment involving the relayer's submission is expected and accepted (lee: "a visible payment to the relayer is OK"). These launches stay pseudonymous, not anonymous. That link already existed on `flow/anon-first-buy` when the player's own wallet paid in the same transaction.
- `Token.creator` and the Launchpad creator stay AnonLauncher. Fee claims later are signed by the stealth owner and can pay out to any address.
- `DiscipleRouter`'s `UsdgRefund` / `UsdgLaunch` events still index AnonLauncher as the router caller, not the player. The USDG refund transfer itself is to the player.

## What changed in the contract

`AnonLauncher.launchAnonWithUsdg` gained a final `address refundTo` argument. `address(0)` means `msg.sender`. Leftover USDG (the router's leftover-pair-to-USDG refund plus any other USDG sitting above the pre-call balance) is sent to that address. The launch fee and First BOOST USDG are still pulled from `msg.sender`. `refundTo == address(this)` reverts `BadRefundTo`. The function stays `nonReentrant`. No new storage, no new privileges, no change to `launchAnon`, Launchpad, or DiscipleRouter.

`launchAnonWithUsdg` has not been deployed yet, so changing it in place is the intended path. A new AnonLauncher deploy is already required for the First BOOST function; this branch does not deploy it.

Runtime bytecode, measured with the official solc 0.8.26 Foundry profile (not Solar): Launchpad 24,399 bytes, unchanged, 177 bytes under the 24,576-byte limit. AnonLauncher 12,134 bytes (12,019 on `flow/anon-first-buy`, +115), 12,442 bytes of room. DiscipleRouter 21,595 bytes; its source was not changed.

## Residual risks

- **Owner changes the First BOOST cap in the same block.** The front end and the pre-send cap check use the cap at sign / simulation time. If the owner lowers `creatorBuyMaxBps` in the same block, the buy can partial-fill and leftover USDG is refunded to the player. If the owner raises it, the player simply could have bought more; nothing is trapped.
- **Owner lowers `launchFee` in the same block.** Admission requires a match, so this is only a same-block change. AnonLauncher pulls the live (lower) fee; the difference could stay on Multicall3, which cannot be swept without a helper. The amount is at most the previous launch fee (capped at $5).
- **Price movement on a non-USDG pair.** Even with the cap enforced, a STRATEGY-pair swap can produce more or fewer pair tokens than the quote. Extra pair token is swapped back to USDG by the router and refunded to the player. Too little pair token reverts on `minQuoteIn` or the curve min-out, and the dollars do not move.
- **Compromised relayer**, as under Trust assumptions.
- **Selling First BOOST coins on the stealth address** still needs a later relay or withdrawal path. Unchanged from `flow/anon-first-buy`.
- **Relayer ETH cost.** The relayer pays ETH gas (a private launch with a First BOOST measured about 7.00M gas under official solc 0.8.26, plus a small Multicall3 wrapper). This path does not take a USDG network fee from the player (unlike withdrawals). The private launch fee still goes to the treasury.

## Front end

`FirstBoostField` blocks a typed amount that is already one microdollar over the USDG max, and still blocks when `quoteCreatorBuy` says the cap is exceeded. MAX never writes an amount over the cap. On a USDG pair the max is exact. Private launches call `disciple_gaslessAnonLaunch` when gasless mode is on; otherwise the player's wallet still submits `launchAnonWithUsdg` with `refundTo` set to the player. Copy is plain full sentences. The SITE switch for a Trench First BOOST showing "Pseudo" is unchanged (owned by SITE).

## Tests

Targeted forge tests in `contracts/test/AnonLauncherFirstBuy.t.sol` (no full Foundry or fuzz run): leftover goes to `refundTo` (500 units over the cap, USDG pair and STRATEGY pair), under-cap leaves zero, `refundTo = address(0)` keeps the old `msg.sender` behavior, `refundTo` cannot be the launcher, and a Multicall3-as-caller case refunds the player, not the caller. Existing first-buy tests still pass with `refundTo = address(0)`. Targeted vitest coverage of the witness, request rules, and Multicall3 batch is in `web/tests/gasless-anon-launch.test.ts`.
