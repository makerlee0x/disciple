<!-- /security copy. Source: disciple-brand/copy/r1/security.md (BRAND draft r1). Copy pending lee approval.
     Rewards stay "TBD by lee". Every [CONFIRM: …] renders as a visible "To be confirmed" tag until lee fills it in. -->
# Security at DISCIPLE

Found a bug? Tell us first, and we'll pay for it. This page explains what's in scope, how to report, and how we treat researchers who act in good faith.

## Scope

**In scope**
- DISCIPLE smart contracts deployed by the team on Robinhood Chain (testnet now, mainnet later): the launchpad, bonding curves, the Uniswap v4 hook, the liquidity lock, the router, the gas paymaster and the session-key and login contracts. [CONFIRM: final list; we list contract names, not addresses]
- The DISCIPLE web app and its API routes on [CONFIRM: domain].
- Anything that lets someone take funds, mint or move tokens they don't own, unlock graduated liquidity, bypass mode caps or the sniper tax, take over another pilot's account, embedded wallet or session, or take creator fees that aren't theirs.

**Out of scope**
- Third-party systems: Uniswap, Robinhood Chain, Privy, Google, Alchemy and other providers. Report those to their owners.
- Rockets launched by other users, and their content.
- Social engineering, phishing, physical attacks, spam, or denial-of-service and load testing.
- Missing best-practice headers, clickjacking on pages with no sensitive actions, self-XSS, and reports from automated scanners with no working exploit.
- Bugs that only affect testnet test funds, unless they would also work on mainnet. [CONFIRM: does lee want to pay for testnet-only findings during the beta?]

## How to report
- Email **[CONFIRM: security@ address]** or use **[CONFIRM: form link]**. Encrypt it if you can: [CONFIRM: PGP key].
- Include what's affected, step-by-step reproduction, a proof of concept, the impact, and your wallet address for payment.
- **Don't** post it publicly, open a GitHub issue, or tell anyone else until we've fixed it and agreed a disclosure date.
- We'll confirm we got it within 48 hours [CONFIRM: response time], give a first assessment within 5 days [CONFIRM: assessment time], and keep you updated until it's fixed.

## Rewards
**Rewards: TBD by lee.** The amounts below will be set before the program opens.

| Severity | Example | Reward |
|---|---|---|
| Critical | Direct loss of user funds, unlocking graduated liquidity | TBD by lee |
| High | Freezing funds, bypassing caps or taxes for profit, account takeover | TBD by lee |
| Medium | Griefing that costs users money, or leaking private data | TBD by lee |
| Low | Minor issues with real, limited impact | TBD by lee |

Rewards are paid in [CONFIRM: USDG or another token] to the first person who reports a valid issue. We decide severity based on real impact. Duplicates, known issues and out-of-scope reports aren't eligible. You must be legally able to receive the payment.

## Safe harbor
If you act in good faith and follow this page, we won't pursue or support legal action against you for your research. Good faith means you:
- only test against your own accounts and wallets, or test funds;
- stop as soon as you confirm the issue, and don't access, change or keep other people's data or funds;
- don't degrade the service for others;
- give us reasonable time to fix it before sharing anything.
If you're unsure whether something is allowed, ask us first at [CONFIRM: contact]. This safe harbor doesn't cover third-party systems.

## Thank you
With your permission, we'll credit you here once the fix is live.
