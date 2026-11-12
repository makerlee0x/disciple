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

**Rewards totals.** Rewards totals count on-chain earnings plus payouts the team made by hand outside the chain. Written into Creator earnings and the glossary. (The third pass took it out of Parameters and deleted the Referrals page.)

**Testnet removed.** The Testnet page (`01-getting-started/05-testnet.md`, `/docs/testnet`) is deleted, so it isn't in the sidebar and has no route. Its only link (What is DISCIPLE) is gone. Every testnet line in the docs is removed or rewritten, with no new caveats. "Get test cash" stays because it is the button's label. The "Is it live?" FAQ is removed. The useful line from the old page (sample data is always labelled) moved to Risks. Contract addresses now lists contract names only; addresses come with the launch.

**Numbers from current main.**
- Trench First BOOST: 7.77% (`Constants.CREATOR_BUY_MAX_BPS_DEFAULT` = 777, ceiling 777).
- Sniper-tax window: 12 days (`Constants.SNIPE_ESCROW_TIMEOUT`). Owner can set 1 to 365 days for new rockets (`Launchpad.setSnipeEscrowTimeout`).
- Fee vault (`CurveFeeVault`, `BondingCurve.feeVault`): before orbit, every share except the liquidity share waits there until claimed. The 33% liquidity share stays with the rocket: locked liquidity at orbit within 12 days, otherwise community rewards, including later trades and a late orbit (`BondingCurve.releaseSnipeEscrow`, `_graduate`). The sniper tax follows the same rule.
- Community rewards: `FeeRouter.rewardsVault` is the `RewardsVault` contract on current main. The page keeps its name and URL.
- Creator fee destination (locked pool, buy-and-burn): still off on the launch form (`liveCreatorFeeDestination`). Docs say "not available yet".
- Pair coins: the form offers STRATEGY only. Docs say what the form offers.
- Private launch fee: set by the team, in USDG, up to $5 (`AnonLauncher.MAX_LAUNCH_FEE`). No fixed amount is quoted.

**How It Works.** Left alone except for three testnet strings in `web/content/how-it-works.ts`: one referral sentence, the "Is this live?" answer and the footer label. Pairing copy unchanged. (The third pass goes further; see below.)

**Still not approved: the Deposit line.** The docs still quote the site as it is. The proposed line above is not approved, and the app was not changed.

## Third pass: no referrals, ready for mainnet (Nov 12 2026, 12:30 AM CT)

Lee: "just dont have any referal notes in the docs at all. that way we can tweak it as we like." Also: claiming in the app "isnt coming soon, it will be fixed and ready", and the copy should be ready "for mainnet and what the app will be."

**Referrals taken out.** The Referrals page (`05-fees/03-referrals.md`, `/docs/fees/referrals`) is deleted, so it isn't in the sidebar and has no route. Every link to it is gone (Sign in and your account, Community rewards, the FAQ). Also removed: the Referrals table in Parameters, the "How do referrals work?" FAQ, the Referral glossary entry, the invite link in the Rewards glossary entry and on the account page, the ReferralRegistry row in Contracts and audits, and its name in the Contract addresses list. No "coming later" line was added.

**The 1% share.** It stays as a number in the fee split (33 / 33 / 33 / 1), labelled "Other" in tables and the fee illustration, and "a separate share" in sentences. Nothing says who gets it or how it's paid. Admin controls says the team can change "where the 1% share goes". Fee vault and fee router lines now say "every share except the liquidity share" instead of naming a referral share.

**How It Works** (`web/content/how-it-works.ts`, now BRAND's copy):
- Referrals card removed, with its $10 deposit, "for life", 2% and "coming soon" lines. The fee cards are now two, so the grid is two columns (`page.module.css`, `.fcards`).
- Creator line: "Builds up on every trade. The creator claims it in Rewards." (was "Claiming from the app is coming soon.")
- Fee split, example and FAQ: "1% referrer" is now "1% other". The legend line says "The last 1% of the fee, not of the trade."
- Anti-snipe card: "to the rewards vault after 30 days" is now "to the community rewards vault if the rocket hasn't reached orbit 12 days after launch", to match current main.
- Footer uses the same sentence as SITE's #323: "DISCIPLE runs on Robinhood Chain. It is not audited. Nothing here is financial advice."

**Kept on purpose.**
- Audit honesty ("Not yet ... internal security reviews only"), including "A professional audit is required before mainnet" in the docs and How It Works FAQ, and the "Before mainnet" multisig plan in Admin controls. These are audit and admin facts, not testnet labels. Lee to say if they should be reworded.
- Creator fee destination (locked pool, buy-and-burn): "not available yet".
- Creator Rewards totals that include payouts made by hand.
- "Get test cash" (button label), and STRATEGY as the only pair coin the form offers today.

**Still not approved: the Deposit line.** Unchanged in the app and the docs.

**Outside the docs, not touched:** the Privacy policy's referral-link cookie paragraph (`web/content/legal/privacy.md`) is legal copy, and `web/content/security.md` is being handled in SITE's #323.
