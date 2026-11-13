<!-- /security copy. Source: disciple-brand/copy/r1/security.md, filled in by lee 2026-11-13: reports to hello@disciple.vip,
     no rewards section for now. Any [CONFIRM: …] marker renders as a visible "To be confirmed" tag. -->
# Security at DISCIPLE

Found a bug? Tell us first. This page explains what's in scope, how to report, and how we treat researchers who act in good faith.

## Scope

**In scope**
- DISCIPLE smart contracts deployed by the team on Robinhood Chain: the launchpad, bonding curves, the Uniswap v4 hook, the liquidity lock, the router, the gas paymaster and the session-key and login contracts.
- The DISCIPLE web app and its API routes on disciple.vip.
- Anything that lets someone take funds, mint or move tokens they don't own, unlock graduated liquidity, bypass mode caps or the sniper tax, take over another pilot's account, embedded wallet or session, abuse how DISCIPLE handles an external wallet connection (signature checks, replayed or spoofed sign-in messages, session hijacking), or take creator fees that aren't theirs.

**Out of scope**
- Third-party systems: Uniswap, Robinhood Chain, Privy, Google, X, Alchemy and other providers. (Bugs in how DISCIPLE handles an email, Google, X or external wallet login are in scope; bugs inside the wallet apps themselves are not.) Report those to their owners.
- Rockets launched by other users, and their content.
- Social engineering, phishing, physical attacks, spam, or denial-of-service and load testing.
- Missing best-practice headers, clickjacking on pages with no sensitive actions, self-XSS, and reports from automated scanners with no working exploit.

## How to report
- Email **[hello@disciple.vip](mailto:hello@disciple.vip)**.
- Include what's affected, step-by-step reproduction, a proof of concept, and the impact.
- **Don't** post it publicly, open a GitHub issue, or tell anyone else until we've fixed it and agreed a disclosure date.
- We'll confirm we got it within 48 hours, give a first assessment within 5 days, and keep you updated until it's fixed.

## Safe harbor
If you act in good faith and follow this page, we won't pursue or support legal action against you for your research. Good faith means you:
- only test against your own accounts and wallets, or test funds;
- stop as soon as you confirm the issue, and don't access, change or keep other people's data or funds;
- don't degrade the service for others;
- give us reasonable time to fix it before sharing anything.
If you're unsure whether something is allowed, ask us first at [hello@disciple.vip](mailto:hello@disciple.vip). This safe harbor doesn't cover third-party systems.

## Thank you
With your permission, we'll credit you here once the fix is live.
