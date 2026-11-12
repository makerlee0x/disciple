# Docs check and polish: copy notes (Nov 12 2026)

Not rendered. The docs reader only reads `web/content/docs/v1/`.

## Proposal, not approved: the Deposit line

The Wallet page says: "Send USDG to your account address:" (`web/components/profile/CashPanel.tsx`, `CASH_COPY.depositHow`). That line was never decided. The docs quote it as it is today and do not change the site.

Proposed plainer line, for lee to decide:

> Send USDG to this address. Use Robinhood Chain only.

Nothing in the app was changed.

## Second pass: lee's answers (Nov 12 2026, 12:11 AM CT)

The docs now describe the product on current main, written as if it is live. Sources are named so each line can be checked.

**Creator claiming.** Creators can claim in Rewards, for public and private rockets. The gap where the app can't claim for public rockets is a bug, and FLOW owns the fix. The docs don't describe the gap and don't say "coming soon".

**Rewards totals.** Rewards totals count on-chain earnings plus payouts the team made by hand outside the chain. Written into Creator earnings, Referrals, Parameters and the glossary.

**Testnet removed.** The Testnet page (`01-getting-started/05-testnet.md`, `/docs/testnet`) is deleted, so it isn't in the sidebar and has no route. Its only link (What is DISCIPLE) is gone. Every testnet line in the docs is removed or rewritten, with no new caveats. "Get test cash" stays because it is the button's label. The "Is it live?" FAQ is removed. The useful line from the old page (sample data is always labelled) moved to Risks. Contract addresses now lists contract names only; addresses come with the launch.

**Numbers from current main.**
- Trench First BOOST: 7.77% (`Constants.CREATOR_BUY_MAX_BPS_DEFAULT` = 777, ceiling 777).
- Sniper-tax window: 12 days (`Constants.SNIPE_ESCROW_TIMEOUT`). Owner can set 1 to 365 days for new rockets (`Launchpad.setSnipeEscrowTimeout`).
- Fee vault (`CurveFeeVault`, `BondingCurve.feeVault`): before orbit, the creator, treasury and referral shares wait there until claimed. The 33% liquidity share stays with the rocket: locked liquidity at orbit within 12 days, otherwise community rewards, including later trades and a late orbit (`BondingCurve.releaseSnipeEscrow`, `_graduate`). The sniper tax follows the same rule.
- Referral share: `FeeRouter.referralSink` defaults to 0 (`Deploy.s.sol`, `env.testnet`), so the 1% goes to the trader's referrer, or to the rocket creator's referrer when there is one (`FeeRouter._route`). Otherwise it goes to the treasury. It no longer goes to community rewards.
- Community rewards: `FeeRouter.rewardsVault` is the `RewardsVault` contract on current main. The page keeps its name and URL.
- Creator fee destination (locked pool, buy-and-burn): still off on the launch form (`liveCreatorFeeDestination`). Docs say "not available yet".
- Pair coins: the form offers STRATEGY only. Docs say what the form offers.
- Private launch fee: set by the team, in USDG, up to $5 (`AnonLauncher.MAX_LAUNCH_FEE`). No fixed amount is quoted.

**How It Works.** Left alone except for three testnet strings in `web/content/how-it-works.ts`: one referral sentence, the "Is this live?" answer and the footer label. Pairing copy unchanged.

**Still not approved: the Deposit line.** The docs still quote the site as it is. The proposed line above is not approved, and the app was not changed.

## Not changed on purpose

- `FeeRouter.kolCreatorShareBps` is 200 on current main (2% of a referred creator's share goes to their referrer). It was set to 0 on the previous stack, and the docs leave it out, as asked.
- The $10 deposit gate in `ReferralRegistry` is not in the docs, as asked.
