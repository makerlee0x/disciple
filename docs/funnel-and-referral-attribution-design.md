# Funnel analytics and referral attribution: design note (FLOW)

Short note for lee, Nov 11, 2026. This build follows PM's plan (`funnel-and-referral-attribution-plan.md`) and invents nothing new. Branch `flow/funnel-analytics`. Nothing is merged, deployed, or sent on-chain.

## What we copy

1. **Conversion funnel, the way Mixpanel, Amplitude, and PostHog do it.** You count unique people moving through ordered steps, plus how many come back the next day (Day-1 return). Step names: `land`, `signin`, `fund`, `first_trade`, `first_launch`, `return_d1`.
2. **SITE's Oct 26 free counter, which lee approved.** Lee's words: "Yes, build funnel analytics as a draft with the free counter." We keep first-time counters in the Upstash store the site already uses. This is SITE's draft commit `4ec65107`, ported onto today's main and not rewritten. PostHog's free tier stays a later option with the same step names, only if lee wants a third party involved.
3. **First-touch affiliate tracking, the way Rewardful and Impact do it.** The first referral link is kept for 30 days, a later link does not replace it, and the referral locks after a qualifying deposit.
4. **DISCIPLE's existing referral path.** That means the `/r/<name|wallet>` cookie (`disciple_ref`), `?ref=` on coin share links, the `disciple.refv2` entry in local storage, `ReferralRegistry` (`tryAttribute`, then a lock once $10 USDG goes through `UsdgDepositNotifier`), FeeRouter's 1% referral share, and FLOW's referral ledger already on main. None of that changes here.

## How the funnel works (unchanged from SITE's draft)

- The browser sends each step at most once, deduped in local storage, and the request body is only `{ step }`. Errors are ignored and nothing is awaited, so the funnel cannot slow a trade or a launch. It is off in the static preview.
- Where each step comes from:
  - `land`: the first page view.
  - `return_d1`: a visit on the UTC calendar day after the land day.
  - `signin`: the wallet is ready to trade.
  - `fund`: the first time the USDG balance read on a trade screen is above $0. The test-cash event carries no amount, so it does not count on its own, and testnet gas drips never count.
  - `first_trade`: the first fill receipt.
  - `first_launch`: a successful launch on the create page.
- `POST /api/funnel` runs INCR on `fun:<net>:<step>:d:<UTC day>` and `fun:<net>:<step>:all` in the existing Upstash store. `net` is the chain id, or `preview` on Preview deployments, so testnet, preview, and mainnet never mix. No wallet address, email, or IP is stored. The IP is only hashed into a 60-second rate-limit key.
- `GET /api/admin/funnel` is for the team only. It uses the same gate as `/api/admin/verifications` (a Privy session plus `ADMIN_EMAILS`) and fails closed.
- Known limit, kept on purpose: counts are per browser, not per account, so one person on two devices counts twice. The hashed account join stays out unless lee asks for it.

## Out of scope

There is no public referral tally or earnings screen. Login, trade, gasless, and router code is untouched, and there is no PostHog or other new vendor. No env vars change. No deposit hook, attribute flag, or attestor gets turned on, and no `setAttestor` is sent.
