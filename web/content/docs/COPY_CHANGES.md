# Docs check and polish: copy notes (Nov 12 2026)

Not rendered. The docs reader only reads `web/content/docs/v1/`.

## Proposal, not approved: the Deposit line

The Wallet page says: "Send USDG to your account address:" (`web/components/profile/CashPanel.tsx`, `CASH_COPY.depositHow`). That line was never decided. The docs quote it as it is today and do not change the site.

Proposed plainer line, for lee to decide:

> Send USDG to this address. Use Robinhood Chain only.

Nothing in the app was changed.

## Where a doc describes code that is not on testnet yet

These are on main but not on the live test network. The docs describe what players can do today.

- Trench First BOOST: main says 7.77%. Testnet Launchpad reads 7% (`creatorBuyMaxBps()` = 700, ceiling 700). Docs say 7%.
- Creator fee choices (locked pool, buy-and-burn): shown on the launch form, marked "available once the new contracts are live". Docs say they are not available yet.
- Fee vault for the liquidity share of curve fees, and the 12-day sniper-tax timeout: not live. Testnet `snipeEscrowTimeout()` = 30 days. Docs keep 30 days and don't mention the vault.
- More pair coins (two-step price routes): built, but the testnet launch form offers STRATEGY only. Docs say so.
- Private launches with the relayer refund: not deployed. Docs describe the Anon and Pseudo switch as it works today.
