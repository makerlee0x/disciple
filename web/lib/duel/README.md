# Trading Duel (`/turbo/duel`, hidden with Turbo)

1v1, same live BTC price, 1 or 3 minutes, most profit at the buzzer wins. Tiers: Rookie $20, Pro $50, Shark $150 duel
fuel, 500×, trade sizes per tier (ALL = everything left). Press the other side to flip; within 25¢ per $20 of fuel at the
buzzer = one 30 s overtime. No cash pot: rewards are rating, XP and trophies only (maker, Nov 14 2026).

| Path | What |
|---|---|
| `lib/duel/rules.ts` | pure rules: fills, flip, H-BOMB (80%), settle, overtime, Elo, match window, invite codes |
| `lib/duel/types.ts` | room + event shapes |
| `lib/duel/client.ts` | browser API calls + `followRoom` (SSE, polling fallback) |
| `lib/server/duel/store.ts` | KV: ranked queue, friend codes, rooms (locked JSON), event log, ratings |
| `lib/server/duel/price.ts` | the server's BTC price; **every fill uses it**, never a client price |
| `app/api/duel/*` | `queue` (poll/leave), `invite`, `join`, `me`, `room/[id]` (GET state, POST ops), `room/[id]/stream` (SSE) |
| `components/turbo/duel/DuelScreen.tsx` | host for the screen engine: server calls, live price, events |
| `public/turbo/duel/engine.js` | the screens (lobby, search, invite, ready check, race, chat, result), ported from the signed-off prototype |
| `scripts/test-duel.mts` | `pnpm test:duel` |

Flow: quick match polls `POST /api/duel/queue` every 1.5 s; the window widens 15 rating points a second (cap 400); after
20 s the lobby offers a bot match (labelled, unrated, runs in the browser). Friend: `POST /api/duel/invite` → code +
`/turbo/duel?c=CODE` link (30 min). Both tap READY (auto-ready after 10 s) → 3-2-1 → live. The buzzer and H-BOMBs are
checked on every request and on the stream's 1 s tick, so closing the tab still settles. Ranked moves rating once per room;
friendly duels don't. Rematch = both tap it → a new room with the same seats.

Not yet (needs Nova, see the hand-off doc): real orders. Duel fuel is a duel-only book at live prices until Nova's SDK
can place, flip and settle positions server-side. Fee is 0.5 bp/side, a placeholder until Nova confirms.

Local two-browser testing: `DUEL_DEV_AUTH=1 next dev`, then set `localStorage["duel.devPid"]` to a 0x address in each
browser (ignored in production builds). `DUEL_PRICE_URL` points the server price at a local stub.
