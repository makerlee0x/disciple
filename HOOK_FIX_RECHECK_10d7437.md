# Disciple hook fix re-check — `10d7437`

Date: 2026-11-05  
Target: `10d74372f7642c4e7cdb2ce34d15fff5d52b5804`  
Baseline: `2cf8cfc8706e305a60239fdbcb350ec390c08a3b`

## Result

The two D-02 failures reported at `2cf8cfc` are fixed:

- a low launch observation and one low observation after an idle warm-up no longer enable the creator cut or graduation;
- one transient high observation delays graduation for only the next two readings, rather than for weeks.

One economic issue remains in the new rule. A single high TVL observation suppresses the creator cut while an already-open fee interval is paid. This contradicts the brief's stated threat model that one spike does nothing to the creator cut.

| ID | Severity | Status | Finding |
|---|---:|---|---|
| R-01 | Medium | Open | One transient high TVL observation diverts the creator cut to LPs |
| Prior R-01 | Medium | Fixed | Launch dip plus first post-warm-up dip no longer count as two observations |
| Prior R-02 | Medium | Fixed | One high observation no longer creates a long activity-dependent graduation delay |
| D-01 | Medium | Fixed | Capital changes close earlier trades first |
| D-03 | Low | Fixed | Cross-chain TVL has an independently checked decimal shift |

## R-01 — one transient high observation diverts the creator cut to LPs

**Severity: Medium**

### Impact

Under the brief's assumption, anyone can inflate source TVL for the first touch of one block at no cost. If a graduated Disciple pool has fees waiting to settle, this one observation makes `creatorOn` false before those fees are distributed. The creator receives none of the configured 12% cut; the full distributable amount goes to LPs. A malicious LP receives part of the diverted cut and can repeat the action on settlement blocks it controls.

The spike remains one of the last two observations, so it also suppresses the cut at the following observation. Two consecutive spikes are needed only to enter the one-day memory. They are not needed to affect the cut immediately.

This is narrower than a principal-loss or insolvency issue, but it is a permissionless and directly profitable fee-diversion path under the review's threat assumption. A single isolated spike is enough, which is outside accepted item 2 in the brief: "One spike does nothing to the cut."

### Cause

`_observe` correctly adds a value to long-lived memory only after an adjacent pair confirms it. `_judge`, however, uses the higher of the last two raw observations for both graduation and the creator cut:

```solidity
g = p.srcTvl > p.prevTvl ? p.srcTvl : p.prevTvl;
c = _rec(p);
if (g > c) c = g;
```

`DiscipleLedger.settle` immediately evaluates `creatorOn` against `c`, then distributes the interval using that result. The graduation rule needs `g` so one low observation cannot graduate early. Reusing `g` for the creator cut gives one high observation immediate economic effect.

### Reproduction

`test_oneSpikeDivertsTheCreatorCutToLps` creates two identical, graduated pools and gives both identical trades. The attacked pool settles while source TVL is transiently inflated; the source is restored before the control pool settles. The attacked creator receives zero, while the control creator receives a positive cut.

Reviewer test: `contracts/test/hook/AuditRecheck10d7437.t.sol`

### Recommendation

Choose and document one of the two possible asymmetric rules:

1. If one high observation must not affect the creator cut, judge the cut from confirmed memory only and require two adjacent high readings to turn it off. An honest recovery after the accepted two-dip residual will then also require two readings.
2. If one honest high observation must turn the cut off immediately, accept that an indistinguishable one-transaction spike can suppress the cut for the current and next reading. Update the threat model and tests to state that economic effect explicitly.

Spot observations cannot distinguish a real recovery from an atomic upward manipulation. Satisfying both promises requires a separate trusted or historical source, such as a manipulation-resistant oracle or source-side time-weighted state.

## Confirmed fixes

### Launch-dip bootstrap

The launch / first-price TVL initializes `srcTvl` but does not increment `seen`. The first later observation increments `seen` to one and returns before updating confirmed memory. The second later observation is therefore required before `_judge` can act. The previous launch-dip reproduction now leaves both `creatorOn` and `graduated` false.

### High-reading graduation delay

Graduation uses only `max(srcTvl, prevTvl)`. One spike is discarded after two later honest observations and is not copied into the creator's one-day memory for graduation. The previous 30-reading denial no longer reproduces.

### Creator memory

The confirmed creator threshold is the maximum envelope of adjacent-pair minima, with linear real-time decay over one day. This removes the prior activity-dependent decay and prevents idle time from being spent in one update. The accepted quiet-pool two-dip residual remains as described in the brief.

## Cross-chain v4 observation note

The hook treats each accepted push as a reading, as the brief specifies. A tracked v4 sender can reuse the last completed depth pass while a new pass is in progress, so two accepted pushes can confirm the same cached TVL result. This does not exceed the brief's accepted outcomes, but "two readings" should be understood as two accepted messages rather than two independently completed depth passes.

## Verification

- Upstream scoped suite: **129 passed, 0 failed, 0 skipped** with Foundry 1.9.0 and Solc 0.8.26.
- Independent reviewer tests:
  - prior launch-dip bypass is blocked;
  - prior high-reading graduation delay is bounded to two readings;
  - one-spike creator-cut diversion reproduces against an honest control.
- Formatting and `git diff --check`: passed.
- `DiscipleHook` deployed runtime: **24,101 bytes**, leaving **475 bytes** under EIP-170's 24,576-byte limit.
- `DiscipleHook` initcode: **24,915 bytes**.

The fork-named tests return early when their RPC environment variables are absent. They were reported as passing by Forge but did not provide live-chain validation in this run.

## Mainnet disposition

Do not treat D-02 as fully closed against the threat model as written. Resolve R-01 in code or explicitly accept and document that one high observation can forfeit the creator cut on fees settled at that observation. The two earlier `2cf8cfc` failures are closed.
