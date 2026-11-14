# End-to-end suite

Playwright drives the **production build** (`next start`) on two sizes: `desktop` (1440×900 Chrome) and `phone`
(Pixel 7, touch). Nothing leaves the machine: a stand-in chain answers the RPC, every other outside request is blocked.

```bash
pnpm e2e:build      # once per code change: builds into .next-e2e with the e2e env (never touches .next)
pnpm e2e            # every flow + screenshot check; starts the stand-in chain and the server itself
pnpm e2e --project=desktop e2e/cash.spec.ts   # one file, one size
pnpm e2e:update     # re-take the screenshot baselines after a design change is signed off
pnpm exec playwright show-report e2e/.report  # the last run: steps, traces, screenshot diffs
```

CI: `.github/workflows/e2e.yml` runs it on every PR into `main`. A failed run uploads the report as `e2e-report`.
"Run workflow" with *update_screens* re-takes the baselines on the CI machine (artifact `e2e-screens`).

## What's covered

| File | Flow |
|---|---|
| `lobby.spec.ts` | first visit, Pick a mode (focus, click-to-play, ← → Enter, phone tap), Duel card behind the Turbo flag, ? help |
| `signin.spec.ts` | Sign in, welcome toast, signed-in lobby, account menu, sign out; returning pilot |
| `cash.spec.ts` | Cash balance, Add cash quote, card checkout unavailable, Send crypto, Cash out checks + refused send |
| `freeplay.spec.ts` | hub, practice run with BOOST + DUMP to a result, Trade settings, **Daily flight scored by the real server** (2 min) |
| `flight.spec.ts` | a real coin's flight: trade bar cash from the chain, not-enough-cash guard, preset keys only select, paper mode signed out, flight menu → lobby |
| `launch.spec.ts` | launch builder preview, name check, Advanced (tax stepper), refused launch in plain words, sign-in from Launch |
| `claims.spec.ts` | Rewards popup (nothing ready, Claim off, tabs), referral link copy, host dashboard |
| `settings.spec.ts` | Settings popup: max price move, bombs, vibration, Turbo leave stick; 2-step page; sign out; /settings link |
| `turbo.spec.ts` | early-access gate, a stand-in run (BOOST → cash out → result), Trading duel lobby (skips until PR #364 is on main) |
| `docs.spec.ts` | every docs page opens with its title, no `[CONFIRM]` left, a crawl for broken same-site links, no sideways scroll |
| `screens.spec.ts` | `@screens` screenshot checks of the signed-off screens |

Every test also fails on an uncaught page error (a crash or a React hydration mismatch), see `support/fixtures.ts`.

## How the fakes work

- **Sign-in**: the e2e build sets `NEXT_PUBLIC_AA_SIGNER=local`, so "Sign in" makes a key in this browser instead of
  opening Privy. Everything after the Privy window is the real code. `pilot.signIn({ cash })` puts a fresh key in
  localStorage before the page loads.
- **Chain**: `support/mock-chain.mjs` is a JSON-RPC server (chain 46630). `balanceOf` answers whatever cash a test set
  (`POST /__e2e/balance`); other reads answer zero; writes are refused, so a trade, cash out or launch always ends at the
  chain's "no" and the test checks the player sees plain words.
- **Server**: real API routes with the local KV file (`KV_ALLOW_LOCAL=1`, wiped at the start of `pnpm e2e`). Each test
  gets its own client IP header (`TRUSTED_PROXY=1`), so per-IP limits never collide.
- **Turbo prices**: `support/venue.ts` stands in for Hyperliquid's price feed (HTTP + WebSocket).

## Next

- A forked-chain lane (anvil + the deployed contracts) for a real BOOST/DUMP fill, a real launch and a real claim. The
  stand-in chain stops at "the chain refused", which covers the UI but not the contracts.
- Duel: once #364 is merged, extend `turbo.spec.ts` with a bot match end to end.
