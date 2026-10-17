# DISCIPLE product UX

## 1. Rocket language (the "obfuscation" layer)

The default UI uses game language for non-crypto users. **It is a naming layer, not concealment.** What you're buying is always one click away, and it's restated before any money moves.

| Shown up front | Behind "Advanced" / disclosure | Never hidden |
|---|---|---|
| "Launch a Rocket", rocket cards, **call sign** | Quote token picker (STRATEGY default, USDG / WETH / MSTR / custom ERC-20) | "What am I launching?" names the ERC-20 and the STRATEGY pair + address |
| Fuel / fire ammo (buy), brake / drop bomb (sell) | Creator tax (0–7%, immutable) | Final trade confirmation (when wired) must name the token, the pair and the $ amount |
| $ prices, $ "altitude" (mcap) | Contract addresses | Fees (1% hook fee) |

Backend types stay honest. `lib/protocol.ts` deals in `token`, `quoteToken` and `ticker`, and `quoteToken = address(0)` means "use the factory `defaultQuote`" (STRATEGY today, owner-settable).

> **Decision note:** the brief asked that the STRATEGY pairing be hidden "so it isn't obvious what you're buying." I kept the rocket wording and the $-only display, but I did **not** remove disclosure. Steering users into an undisclosed asset (here, the owner's own coin) is a consumer-protection and legal risk. Talk to counsel before reducing disclosure any further.

## 2. Verification (manual yes/no)

Verification is a **manual yes/no flag set by hand by the team**. There are no automatic tiers and no metric thresholds (volume, mcap, holders, age and liquidity do not verify a rocket). This matches fomo's own description ([spotting scams](https://fomo.family/blog/learn/spotting-scams-and-low-quality-tokens)): verification is team due diligence, not metrics alone.

A rocket is verified when **either**:

1. its coin address is in `VERIFIED_COINS` in `web/lib/verified.ts` (a hand-maintained, lowercase address set, empty by default), or
2. its metadata carries `verified: true` (`Rocket.verified` / `CoinMetadata.verified`), which a future admin API can set.

`isVerified(coinAddress, flag?)` in `web/lib/verified.ts` is the single check. **To verify a rocket:** add its lowercase coin address to `VERIFIED_COINS` and ship, or set `verified: true` via the admin route once it exists. To un-verify, remove it.

UI: verified rockets show one "Verified" badge (the `d-verified` icon). Unverified rockets show nothing. The launchpad has an All / Verified-only filter that defaults to **All**, matching fomo, where "verified" is one filter among several.

## 3. Crew / PvE framing

- You're buying with **BOOST**. Every BOOST fuels the **shared** rocket, so altitude = mcap and everyone aboard rises together.
- Tier crossings (18-tier ladder) unlock crew-wide rewards. The **Next unlock** bar shows progress to the next tier's reward.
- Light PvP: anyone can **DUMP** (sell) and drop a bomb. Its impact % picks the bomb tier (grenade → atom).
- The Crew panel shows players aboard, the top boosters, your contribution and ammo cost per mode in $. **All of it is mock until the indexer lands.**
- HUD: SPACE = BOOST · SHIFT = DUMP.

## 4. Rocket branding (decals)

- Base sprite: `web/public/assets/rocket.png`, the locked chrome sprite that ships in web/public. The `rocket-wet` render lives only in `/workspace/anypair/renders` and wasn't copied in.
- `lib/decal.ts` builds a composite **once** into an offscreen canvas at 4× resolution. It draws a mid-body roundel plus two fin roundels, uses a cover-fit icon (so non-square icons work) with a circle clip and gold rim, and squashes X to suggest cylinder wrap. The decal is painted `source-atop` (hull pixels only), the base is multiplied back for shading, and screen-blended chrome highlights go on top. In flight, the rotation comes from the engine's transform.
- Loading: same-origin, blob and data URLs load directly. Remote URLs go through `/api/img` first (most token CDNs send no CORS header, and a failed CORS load logs a console error), then fall back to a direct `crossOrigin=anonymous` load. If loading fails or times out, the rocket gets the DISCIPLE halo emblem, and the launch is never blocked.
- Clicking a card starts the fetch during ignition, and the decal fades in over 300 ms on the pad. In flight, `window.__rocketDecal` fades in over 300 ms.
- It's used on home rocket cards, the pad rocket, the flight sprite, the `/create` studio (large rotatable preview, light/dark backdrop, "see it in flight" mini preview, zoom/offset, contrast warning) and the **Share** PNG card (`canvas.toBlob`).

## 5. Holdings / PnL HUD (`/coin/[address]`)

The compact gold/white glass panel under the market cap reads **FUEL IN TANK**. It collapses on mobile. It shows holdings (tokens and $ value), avg entry ($ and entry MC), % gain/loss, uPnL (green/red), realized PnL for this rocket, a session total (realized on other rockets) and **HOLD BONUS ×N**. A faint dashed "YOUR ENTRY" altitude line is drawn on the flight canvas when the entry is in view.

Math (`web/lib/pnl.ts`) uses **average cost basis**:
- buy: `tokens = usd·(1−1%)/price`, `costBasis += usd + gas`
- sell: `tokens = usd/price` (capped at size), `proceeds = tokens·price·(1−1%) − gas`, `realized += proceeds − costBasis·frac`, `costBasis −= costBasis·frac`
- mark: `value = size·price·(1−1%)` (net of exit fee), `uPnL = value − costBasis`

The data source today is the **paper ledger** (engine `disciple:paperfill` events, persisted per coin in localStorage). Later it will be `ProtocolClient.getPosition(user, coin) → { size, costBasisUsd, realizedUsd }` from the vault/indexer.

## 6. Hold bonus: **PROPOSAL for Maker to tune** (off-chain points only)

```
multiplier = 1 + min(1.5, 0.5·log10(1 + uPnL$/10)) × holdTimeFactor × sellScale
holdTimeFactor = clamp(hoursHeldContinuously / 24, 0, 1)
sellScale      = Π(1 − fractionSold) over partial sells; a full exit resets it
```

- Every knob lives in `HOLD_BONUS` in `web/lib/config.ts` (k, pnlScaleUsd, maxBoost, rampHours, minPositionUsd = $25, snapshotsPerDay = 6).
- The multiplier applies only to daily **rHALO** points. It never touches on-chain value.
- Anti-gaming:
  - **wash-trade detection** (self/linked-wallet round trips, buy→sell inside N blocks, funding-graph clustering) zeroes points for the day
  - a **minimum position size** stops dust farming
  - **snapshots at random times** each day instead of continuous measurement, so there's no timing the snapshot
  - uPnL is capped via the log term
  - hold time resets on full exit
