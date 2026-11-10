# Name/ticker lock (mainnet only) — runbook

lee 2026-11-10 (design note v2 + answers). After a rocket ASCENDS and its slot is claimed, no new launch may use the
same **name AND ticker**. Two coins may share a name or a ticker, not both. The image is not part of the lock and stays
editable (`Launchpad.updateMetadata` unchanged).

## Contracts
- `src/NameRegistry.sol` — all lock state and logic. No owner: the deployer sets `launchpad` once
  (`setLaunchpad`, Migration pattern), then nothing is admin-settable.
- `Launchpad` constructor arg 5 `nameRegistry_` (internal immutable). `Deploy.s.sol` deploys a NameRegistry only when
  `NetworkConfig._checkCoreConfig()` returns mainnet; testnet/local pass `address(0)` → launch skips the check.
  The logic is outside Launchpad because Launchpad was 24,399 B (177 B under EIP-170); with the inline check it is
  24,567 B (**9 B headroom**).
- Key: `keccak256(abi.encode(lowerTrimASCII(name), lowerTrimASCII(ticker)))` from `Token.name()/symbol()` (= the
  immutable LaunchParams.name/ticker). ASCII A–Z lowercased; leading/trailing ASCII whitespace trimmed; inner
  whitespace and non-ASCII bytes compared exactly (no Unicode folding, homoglyphs are different names).

## Flow (all permissionless)
1. Launch: `Launchpad._launch` → `NameRegistry.checkLaunch(token)` (view) → reverts `NameLocked()` if `nameHolder[key]`
   is set. Web maps `NameLocked` in `lib/protocol-viem.ts`.
2. Ascend → `claimName(token)`: requires `BondingCurve.graduated`; takes the free slot (`NameClaimed`), returns true if
   the coin holds it (idempotent), **false (no revert) if another coin holds it**. Copies that launched before the
   original claimed can still ascend and trade; their claim is just a no-op.
3. Drop-back: `markBelow(token)` reads the existing `BondingCurve.marketCapUsd()` (live v4 price post-grad). Below
   $33,333 (Outer Space, tier < 4) → records the first time seen (`NameReleaseMarked(key, token, since)`); at/above →
   resets (`since = 0`). `releaseName(token)` after 24 h (`Constants.NAME_RELEASE_DELAY`) of a continuous mark and a
   final check still below → `NameReleased`, slot free; if back above at release, the mark resets and it returns false.
   Anyone may re-claim a freed slot (first ascended coin to call wins).

## Ops (no new service)
- There is no existing keeper that listens for `GraduatedToV4` and sends txs (`/api/cron/poke-pricer` only scans
  `Launched`; `lib/server/grad.ts` / achievements only read). Until one is added, after each `GraduatedToV4` on mainnet
  call `NameRegistry.claimName(token)` from the relayer/ops wallet (simulate first; ~85k gas). A frontend "Claim name"
  button or a branch in poke-pricer are natural follow-ups — lee's call.
- Release is driven by whoever wants the name (or the holder's community, who can reset a mark by calling `markBelow`
  while the mcap is at/above).
- Coins that existed before this ships: none on mainnet (fresh deploy). Testnet has no registry (lock off). A registry
  only knows coins of its own Launchpad; holders start empty, so the relayer can back-claim any already-ascended coin.

## Gas (measured, forge, cold slots)
Trade paths unchanged (BondingCurve, DiscipleHook, DiscipleRouter, FeeRouter untouched; buy/sell measured identical).
Launch +40 gas with the lock off; ~+16.3k with it on (no collision). claimName ~85k, markBelow ~106k with the real v4 mcap
read, releaseName ~63k (+~28k real mcap read) — paid by the caller.

## Known limits
- Spot mcap: `marketCapUsd` is the live pool price, so a same-tx dump can satisfy `markBelow`/`releaseName`. The
  attacker must do it twice 24 h apart and anyone can reset the mark in between; there is no new oracle by design.
- Observations are discrete: a coin that pumps back above inside the 24 h without anyone calling `markBelow` still
  releases if it is below at the final check.
