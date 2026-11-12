# AscensionHook fee path

AscensionHook is the post-graduation hook. After a coin leaves the bonding curve, this hook takes the 1% trade fee. It is not the follower-pool DiscipleHook (a pool that follows a leader).

The fee path follows Doppler's Rehype / FeeTakingHook pattern: during the swap the hook takes the 1% onto itself with `poolManager.take` and records it per pool (and per trader, so the later split can still credit a referral or KOL leftover). The swap does not call FeeRouter or any other shared fee contract, so a later payout failure cannot stop trading.

Anyone may call `collectFees` later. That is when the official 33/33/33/1 split is booked through FeeRouter, unchanged. If the creator chose to keep fees, they claim when they want. For locked-pool and buy-and-burn destinations, `CreatorFeeHarvest.collectAndRoute(token, traders, pastCreators)` is public: it collects the hook fees for those traders and routes them (and `route` / `routeFrom` route what FeeRouter already holds). A keeper can call it; it is not a privileged role, and the caller is paid nothing.

Only LockedLP may initialize a pool on this hook and add the locked liquidity. Trade and altitude events, and the existing isolated compound path, are unchanged.
