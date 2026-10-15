# DISCIPLE

**Every coin is a rocket. Altitude = price.**

DISCIPLE is a launchpad that pairs any coin with any ERC-20 using a CPAMM bonding curve ($7K → $33K, graduates at 72% sold into locked Uniswap v4). v0 targets **Robinhood Chain** (chain id **4663**). The front end is a rocket flight game on [disciple.vip](https://disciple.vip) — angel/heaven theme (gold & white on dark, chrome rocket). The product name is DISCIPLE; do not use apostle/disciple imagery.

## Monorepo structure

```
/
├── README.md
├── package.json          # pnpm workspace root
├── pnpm-workspace.yaml
├── contracts/            # owned by DISCIPLE FLOW (stub README only)
└── web/                  # Next.js 14 App Router (TypeScript + Tailwind)
    ├── app/              # routes
    ├── components/       # Sidebar, FlightCanvas, …
    ├── lib/              # config, protocol stubs, flight helpers
    └── public/           # assets/, replay.json, flight/engine.js
```

| Path | Owner |
|------|--------|
| `/web` | DISCIPLE GAME (this workstream) |
| `/contracts` | DISCIPLE FLOW (smart contracts / indexer) |

**License:** TBD (not included in this scaffold).

## How to run

```bash
# from repo root
pnpm install
pnpm --filter web dev     # http://localhost:3000
pnpm --filter web build
pnpm --filter web lint
```

Or from `web/`:

```bash
pnpm install
pnpm dev
```

### Pages

| Route | Description |
|-------|-------------|
| `/` | Launchpad home — rocket on the pad, coin cards, blast-off |
| `/coin/[address]` | Flight game (live RH RPC or `?replay=1`) |
| `/create` | Launch-coin form (UI only until contracts wire) |
| `/profile` `/leaderboard` `/rocket` `/achievements` `/wallet` `/settings` | Themed placeholders + settings toggles |

Flight controls (coin page): SPACE buy, SHIFT sell, 1–6 modes, A/D lanes, O orbs, B bombs, F replay speed, ✕ exit.

## Protocol (summary)

- Curve: single CPAMM, start mcap **$7K**, graduation **$33K** (Pearly Gates), **72%** sold on curve
- Trade fee **1%** → 33% creator / 33% LP lock / 33% treasury / 1% referral
- Optional creator tax ≤ **7%**, immutable at launch
- Deposit: one **USDG** approval; no per-trade signing; user pays gas
- See constitution docs in the ANYPAIR research tree for the full LOCKED table

## TODOs for DISCIPLE FLOW

- Implement `web/lib/protocol.ts` (`launchCoin`, `buy`, `sell`, `getCurveState`, `impactPct`)
- Deploy curve + token + Uniswap v4 graduation + FeeRouter
- Privy auth + USDG vault (deposit / withdraw)
- Replace paper trades in the flight engine with real vault-executed swaps
- Indexer for mcap / impact / leaderboard

## Assets

Rocket sprite + tier backgrounds under `web/public/assets/`. Replay under `web/public/replay.json`. Flight engine: `web/public/flight/engine.js` (ported from the flight prototype).
