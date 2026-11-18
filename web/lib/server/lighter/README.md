# Lighter (Turbo backup venue)

Backup to Nova for Turbo duels (maker, 2026-11-17). Each player's own wallet owns their Lighter account; Disciple holds
a trading key for it and signs market orders on the server, so a duel never shows a wallet popup.

**Cost:** Lighter Plus (0.5 bp a side) + Disciple's partner fee (0.05 bp a side) = **1.1 bp round trip**, locked by
maker. Duel leverage is Lighter's max: 50x BTC/ETH, 25x SOL, 20x HYPE. Market orders wait ~300 ms on Plus.

## Files
- `config.ts`: env settings (network, partner fee, key slot, tier)
- `signer.ts` + `signer/`: Lighter's own signer (lighter-go → WebAssembly). Rebuild with `tools/lighter/build-signer.sh`
- `rest.ts`: Lighter REST calls (markets, account, nonce, sendTx, changeAccountTier)
- `keys.ts`: per-player trading key, AES-GCM encrypted in KV
- `player.ts`: set-up steps and market open/close
- `app/api/lighter/route.ts`: the API; `lib/lighter/client.ts`: browser helper; `lib/lighter/math.ts`: order math

## Set-up for a player
1. **deposit**: they add cash to Lighter once, which creates their Lighter account
2. **key**: their wallet signs "Register Lighter Account" once
3. **tier**: Disciple moves the account to Plus
4. **approve**: their wallet signs "Approve Integrator" once (Disciple's fee, capped, 1 year)

## Env to turn it on
| Var | Value |
|---|---|
| `LIGHTER_ENABLED` | `1` |
| `LIGHTER_NETWORK` | `testnet` (default) or `mainnet` |
| `LIGHTER_API_URL` | optional host override (testnet default `https://api.testnet.lighter.xyz`, the one the testnet app uses) |
| `LIGHTER_KEY_SECRET` | a long random string |
| `LIGHTER_INTEGRATOR_INDEX` | Disciple's own Lighter account index (fees land here) |
| `LIGHTER_PARTNER_FEE_BP` | `0.05` (default) |

## Taps (pre-signed)
A tap doesn't go through Disciple's server. `presign` (player.ts) signs the player's next long, short and close at one
nonce, each with a price cap (`LIGHTER_SLIPPAGE`), Disciple's fee and a 15 s expiry, so only one of them can ever land and
an unused set dies quickly. `LighterTaps` (lib/lighter/client.ts) holds the newest set, refreshes it every 5 s and right
after each tap, and posts the tapped order straight to Lighter's `sendTx`. If the browser can't reach Lighter, the same
signed order goes through `relay`. The trading key stays on the server. The short expiry needs our signer patch
(`SetOrderTxExpiry`, applied by tools/lighter/build-signer.sh).

## Testing
Hidden page `/lighter` (not linked): sign in, then Set up, Long / Short / Close with timings. The env vars must be on the
Preview environment too, for a PR preview. Disciple's testnet fee account is 577.

## Still open
- Lighter tier name for Plus: assumed `plus` (`LIGHTER_TIER` overrides). Confirm on testnet.
- Privy wallet must be a plain EOA for Lighter's L1 signature; a smart-account address won't work.
- Deposit route from Add cash into Lighter isn't built.
- A Turbo duel adapter that sends duel trades here instead of the duel-only book isn't built.
- Not run against Lighter yet (the build sandbox can't reach Lighter's API). First live run is on testnet.
