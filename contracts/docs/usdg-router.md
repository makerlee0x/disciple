# USDG router (buyWithUsdg / sellToUsdg)

The frontend always pays in USDG. `DiscipleRouter` hops USDG <-> the coin's quote through an **owner-registered**
USDG/quote v4 pool, then trades the bonding curve (pre-graduation) or the coin's DISCIPLE v4 pool (post-graduation).
There is no UniversalRouter or Permit2 anywhere in the path, and the session policy only trusts DiscipleRouter.

## API
| function | notes |
|---|---|
| `buyWithUsdg(token, usdgIn, minTokensOut, deadline) → tokensOut` | tokens go to `msg.sender`; `minTokensOut` is end to end, in token units |
| `sellToUsdg(token, tokensIn, minUsdgOut, deadline) → usdgOut` | USDG goes to `msg.sender`; `minUsdgOut` is end to end, in USDG units |
| `quoteUsdgRoute(token, isBuy, amountIn) → (amountOut, maxHopImpactBps)` | simulate and revert; call it with eth_call. Also `quoteBuyWithUsdg` / `quoteSellToUsdg` |
| `launchWithUsdg(LaunchParams p, uint8 mode, usdgIn, minQuoteIn) → (LaunchResult, usdgRefund)` | mode rules v2 add-on: USDG → pair coin → First BOOST via router-only `Launchpad.launchFor(creator = msg.sender, …)`; First BOOST refund swapped back to USDG (`UsdgRefund`), event `UsdgLaunch`. `usdgIn = 0` = no First BOOST |
| `claimCreatorFeesToUsdg(token, minUsdgOut) → usdgOut` | claims the caller's quote-side creator fees (`FeeRouter.claimCreatorFeesFor`, router-only) and swaps them to USDG (`UsdgCreatorFeesClaimed`) |
| `setUsdgRouting(usdg, launchpad)` / `setUsdgPool(quote, key)` / `removeUsdgPool(quote)` / `usdgPoolOf(quote)` | owner only. The pool must pair exactly USDG and the quote, be initialized, and not be a DISCIPLE pool |

Rules: `minOut == 0` reverts (`ZeroMinOut`). Every hop must stay within `maxImpactBps` (default 50%), and this covers the USDG pool hop, the curve hop (`quoteBuy`/`quoteSell` impactBps) and the v4 hop. When the coin's quote is USDG, the trade is a single hop. Post-graduation, both swaps run inside one PoolManager unlock, so the intermediate deltas net out. Pre-graduation, the curve leg runs after the USDG unlock, which keeps it outside the unlock because a graduating buy runs migration. When a curve buy is partial-filled (mode rules v2 holding cap or First BOOST max) or graduates the coin, the curve refunds the unused quote to the router, which swaps it back to USDG through the registered pool and sends it to the buyer (`UsdgRefund`; USDG-paired coins refund USDG directly). The router keeps no balances.

## Session policy (1.3.0)
`launchWithUsdg` and `claimCreatorFeesToUsdg` are **not** session-key selectors (launches and creator-fee claims stay a
wallet confirm; a session key gets `NotAllowed`). A partial-fill refund does not reduce the session spend counted for
`buyWithUsdg` (the cap counts `usdgIn`, conservative).

The `buyWithUsdg` / `sellToUsdg` selectors on `cfg.router` reuse `P_ROUTER_BUY` / `P_ROUTER_SELL`:
- `minOut >= quoteUsdgRoute(...) * (1 - maxSlippageBps)`, measured end to end. This is tokens on buys and USDG on sells.
- The cap counts `usdgIn` against the cap slot whose quote is USDG (`router.usdg()`).
- `approve` on USDG: the spender must be `cfg.router`, and the amount must be 0 or exactly the sum of `usdgIn` across the batch's `buyWithUsdg` calls. Send the approve and the buy in **one** batch. USDG allowances for Permit2, UniversalRouter or curves are refused.
- The router pins the recipient to `msg.sender`, which is the account.

Attribution: router trades are credited to the player, not to the router. Pre-graduation, `BondingCurve.routerBuy` / `routerSell` take the `trader` explicitly, so the per-wallet caps (`balanceOnCurve`), the PVE cost basis and profit tax, and referral/fee attribution all apply to the player. Post-graduation, `DiscipleRouter` passes the payer as `hookData` on DISCIPLE-pool hops (`abi.encode(payer)`, `DiscipleRouter.sol` ~L619), and `DiscipleHook` credits that address as the trader when the swap sender is a trusted router (`DiscipleHook.sol` ~L379-391), so the fee split and referral attribution go to the player.
