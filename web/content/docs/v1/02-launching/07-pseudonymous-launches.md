---
title: Pseudonymous launches
slug: /docs/launch/pseudonymous
section: Launching
---
# Pseudonymous launches (beta)

You can launch without your account showing as the creator. Find it under **Advanced → Pseudonymous creator (beta)**.

## How it works

- A launcher contract (AnonLauncher) launches the rocket for you and is the on-chain creator.
- The real creator role is assigned to a one-time **stealth address** that only you can control.
- Your creator buy goes to a fresh address.
- A small launch fee in USDG goes to the treasury: $0.25 on testnet, capped at $5. [CONFIRM: FLOW — mainnet fee.]
- You claim fees and update metadata by signature. The stealth owner doesn't need gas.

The fee split, creator tax and caps are the same as a normal launch.

## What it doesn't hide

Pseudonymous is not anonymous.

- The wallet that pays the launch fee and the creator buy is linked to the rocket in the same transaction.
- The bundler, the gas sponsor and DISCIPLE's backend can see metadata.
- Timing and reusing payout addresses can link rockets to each other.
