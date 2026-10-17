---
title: Launch a rocket
slug: /docs/launch
section: Launching
---
# Launch a rocket

Anyone can launch. No permission needed.

## The form

Press **Launch a Rocket** and fill in:

| Field | Required | Notes |
|---|---|---|
| **Rocket name** | Yes | Set for good at launch. |
| **Call sign** | Yes | Your $TICKER. 1–10 letters or numbers. Set for good at launch. |
| **Rocket icon** | Yes | Your image. It's painted onto the rocket as a decal. You can change it later. |
| **Pair with** | Yes | The base. STRATEGY by default. See [Pairing](/docs/launch/pairing). |
| X / social link | No | Can be changed later. |
| Website | No | Can be changed later. |
| **Advanced** | No | Creator tax (0–7%) and pseudonymous creator (beta). |

Before you launch, **What am I launching?** names the coin you're creating, its base and their addresses. Nothing is hidden behind the game language.

## What happens when you launch

One transaction:

1. A new ERC-20 is created: **7,000,000,000** supply, 18 decimals, no further mint. Its address is a standard address (no vanity).
2. A bonding curve is created for it, starting at a **$7K** market cap.
3. The anti-snipe clock starts: the first 7 seconds carry an extra fee on buys. See [Anti-snipe](/docs/trading/anti-snipe).

You pay the gas.

## Call signs

A call sign is your rocket's ticker: 1–10 letters (A–Z) or numbers (0–9). The form uppercases it for you. It can't be changed after launch.

Call signs aren't unique. Two rockets can share one. Check the rocket's address before you trade. [CONFIRM: lee + GAME — duplicate call signs are allowed today (no check in the form, server or contract). Keep that, or make call signs unique?]

## Launch modes

A mode picker is coming with the next testnet redeploy: **PvE**, **PvP** and **Trench Warfare**. See [Launch modes](/docs/launch/modes).
