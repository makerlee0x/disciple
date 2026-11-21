# Weekly board prizes (proposal, 2026-11-21)

Status: **proposal, off by default.** Nothing pays until the server sets `WEEKLY_PRIZES=1`. No contract changes.

## What's live with this PR

- **Week** view on the Overall board (`/leaderboard`, opens there; `?tab=weekly` links straight to it). Same points table as
  the season (`lib/season/points`), counted Monday 00:00 UTC to Monday 00:00 UTC (`lib/season/weekly`).
  - Rockets: the season rule (per $ banked, capped a UTC day) over this week's closes.
  - Duel: any online duel (quick match, ranked or unranked): win +30, draw +10, loss 0. Friend codes, bots and guests don't
    count. At most 3 scoring duels per pair of pilots a week, so two wallets can't farm each other.
  - Royale / Climb: whatever season points the run paid, the week it paid.
- Last week's top 3 stay on the board all week. Ten minutes after a week ends its top 10 are sealed in KV
  (`week:final:<week>`), so the podium and any prize read the same standings.
- A cron (`/api/cron/weekly-prizes`, hourly, `?dry=1` previews) that pays the sealed top 10 in collection crates once per
  wallet per week. It does nothing while `WEEKLY_PRIZES` is unset.

## Proposed prizes (all off-chain)

| Place | Prize (wired) | Optional extra (not wired) |
|---|---|---|
| #1 | Legendary crate | Gold "Week #1" badge on the profile for the next week |
| #2–3 | Epic crate | Silver/bronze badge |
| #4–10 | Rare crate | none |

Why crates: they already exist (`lib/server/collection grantCrate`, once per source and wallet), cost nothing on-chain, and
pull winners back into the shop/market loop. Swap the tiers in `WEEK_PRIZES` (`lib/season/weekly.ts`).

## Options that need maker's call

1. **Cash prizes from the treasury** (e.g. $250 / $100 / $50 in the Turbo cash balance). Biggest pull for crypto Twitter,
   but it's real money: sybil risk (one person, many wallets) and likely sweepstakes rules in some regions. Would need a
   KYC-lite floor (signed-in, account age, min volume) before it's safe.
2. **Creator-fee share**: a slice of the week's buyback-and-burn redirected to the top pilots. Needs a contract change, so
   not proposed without explicit approval.
3. **XP**: easy (`lib/server/xp award`), but XP already flows from play, so a weekly XP drop adds little.

## Abuse notes

- Duel points are capped per pair, and only online duels against another wallet count.
- Rockets points use the season's guardrails (a creator's trades on their own rocket don't count, and the daily cap).
- If crates become sellable for real money on the market, revisit option 1's sybil notes before turning prizes on.
