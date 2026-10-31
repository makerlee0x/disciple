# CLAUDE.md

Orientation for AI agents working in this repo. Product context lives in [README.md](README.md) and [docs/](docs/); this file covers how to work here.

## What this is

DISCIPLE: a launchpad where every coin is a rocket and altitude = price, front end at disciple.vip, targeting Robinhood Chain (testnet chain id 46630 today, mainnet 4663). Pump-style CPAMM bonding curve that graduates into Uniswap v4.

## Layout and ownership

| Path | What | Owner |
|---|---|---|
| `web/` | Next.js 14 App Router + TypeScript + Tailwind. Routes in `app/`, UI in `components/`, logic in `lib/`, flight engine in `public/flight/engine.js` | DISCIPLE GAME |
| `contracts/` | Foundry, Solidity 0.8.26, OpenZeppelin v5. Source of truth: `contracts/docs/protocol-constitution.md`; front-end contract surface: `contracts/docs/frontend-api.md` | DISCIPLE FLOW |
| `indexer/` | viem + SQLite + `node:http` indexer and REST API (`@disciple/indexer`, npm lockfile, not in the pnpm workspace) | DISCIPLE FLOW |
| `sdk/session-keys/` | Session-key SDK (pnpm workspace package) | DISCIPLE FLOW |

Default to `web/`. Don't change `contracts/`, `indexer/` or `sdk/` unless the task is explicitly about them, and never put UI code in `contracts/`. Deployed addresses: `contracts/deployments/rh-testnet-46630.json`.

## Commands

```bash
pnpm install                      # repo root
pnpm dev                          # web on http://localhost:3000
pnpm build
pnpm lint
pnpm --filter web run test:<name> # focused tests, see below
```

- **Web tests** are per-feature scripts in `web/scripts/test-*.{mjs,mts}`, one `test:<name>` entry each in `web/package.json`. There is no single "run everything" command: run the ones that cover what you touched, and add a new `test:<name>` script for new behaviour. `.mts` tests run under `tsx --test`; server-component code needs `--conditions=react-server`, and DOM tests use `TSX_TSCONFIG_PATH=scripts/tsconfig.dom-test.json`. Copy the pattern from a neighbouring script.
- Some tests (`*-e2e*`, `test:usdg-fill`, `test:mav2`) hit live testnet and need keys; don't run them unless asked.
- **Contracts:** `cd contracts && forge build && forge test` (Foundry at `~/.foundry/bin`).
- **Indexer:** `cd indexer && npm test` (vitest) and `npm run typecheck`.
- **Env:** copy `web/.env.example` to `web/.env.local`. Never commit secrets, and never expose server-only keys (`RELAYER_PRIVATE_KEY`, `PRIVY_APP_SECRET`, `ALCHEMY_API_KEY`, …) through a `NEXT_PUBLIC_` variable.

## Product rules that affect code and copy

- **Rocket language** in the default UI: a launch is a *rocket*, the ticker is its *call sign*, buy is **BOOST**, sell is **DUMP**, prices are $ only. This is a naming layer, not concealment: "What am I launching?" must always name the real token and pair, and fees stay visible. See [docs/product-ux.md](docs/product-ux.md) §1.
- The product name is DISCIPLE. Don't use apostle/disciple religious imagery; the theme is angel/heaven, gold and white on dark, with a chrome rocket.
- **Verified** is a manual yes/no: `isVerified()` in `web/lib/verified.ts` is the only check. Never derive it from metrics.
- Unfinished UI hides behind flags in `web/lib/features.ts` (off by default, `NEXT_PUBLIC_FEATURE_*` build-time overrides). New features that aren't ready ship behind a flag the same way, with a comment saying what on/off does and who decided.
- Server code fails closed: if a required key or admin list is missing, the route returns an error (usually 503) instead of degrading silently.
- Don't show sample/mock numbers as if they were real player data.

## Git and PRs

- Branch off `main`. Prefixes in use: `site/…` (web), `game/…` (flight game), `flow/…` (contracts/indexer), `fix/…`, `feat/…`, `docs/…`.
- Commit subjects start with an area tag: `SITE: …`, `SITE create: …`, `SITE security: …`, `GAME: …`. Keep them short and plain-English.
- PR bodies use `## Summary` plus a `## Test plan` checklist naming the exact `test:<name>` scripts run and their pass counts.
- Most work lands as draft PRs first. Don't merge, push to `main` or mark a PR ready without the owner's go-ahead.
- `cursor/…-e17b` branches come from a Cursor background agent and usually mirror a `site/`/`game/` branch rebased onto current `main`. When both exist, check which one is newer before building on either.

## What's in progress

This changes daily, so check live state rather than trusting a snapshot:

```bash
gh pr list --state open                       # open PRs (most are drafts)
git log --oneline -15 origin/main             # what just landed
git for-each-ref --sort=-committerdate --format='%(committerdate:short) %(refname:short)' refs/remotes/origin | head -20
```

Some drafts are stale because their work already reached `main` through a `cursor/` twin. Compare with `git log origin/main..origin/<branch>` before reviving one. `feat/rockets-v0` (PR 43) is marked DO NOT MERGE.
