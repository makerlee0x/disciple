# Disciple hook fix re-check — `364a916`

Date: 2026-11-05  
Target: `364a916929121a2ae228cf6427cdec8980c5007f`  
Baseline: `10d74372f7642c4e7cdb2ce34d15fff5d52b5804`

## Result

The `10d7437` one-spike creator-cut diversion is fixed. One transient high TVL observation no longer changes `creatorOn` or the cut paid for an open interval.

The hysteresis introduces a related unbounded state-retention path. Once two adjacent spikes turn the cut off, an attacker can keep it off indefinitely by spiking only every other observation. Each honest observation remains paired with a spike, so the pool value stays between the `onTvl` and `offTvl` thresholds and the ledger preserves the prior `false` state. The one-day memory decay does not bound this behavior.

| ID | Severity | Status | Finding |
|---|---:|---|---|
| R-01 | Medium | Open | Alternating spikes keep the creator cut off indefinitely and divert it to LPs |
| `10d7437` R-01 | Medium | Fixed | One isolated spike no longer diverts the creator cut |
| Earlier D-02 cases | Medium | Fixed | Launch-dip bootstrap and prolonged graduation delay remain blocked |
| D-01 | Medium | Fixed | Capital changes close earlier trades first |
| D-03 | Low | Fixed | Cross-chain TVL uses a separately checked decimal shift |

## R-01 — alternating spikes keep the creator cut off indefinitely

**Severity: Medium**

### Impact

Under the brief's threat assumption, an attacker can raise source TVL for one transaction at no cost. Two adjacent spikes switch an otherwise eligible pool's creator cut off. After that, the attacker needs to spike only one of every two observations to keep it off forever; they do not need to control every observation.

While the cut is off, the configured 12% creator share of each distributable fee interval goes to LPs. A malicious LP receives a proportional share of the diverted amount. The same pattern can also be used as pure griefing against the creator.

This exceeds accepted item 2 in the brief, which says two spikes suppress the cut for at most one day. The reviewer reproduction keeps the cut off across six days with honest observations between every spike, then earns and settles fees on an honest-reading block. The attacked creator receives zero while an identical control creator is paid.

Even without continued manipulation, a quiet pool remains off at the first honest observation after the one-day memory expires. Fees earned after that observation can be settled later in the same block without a creator cut. A second consecutive honest observation is required to restore it.

### Cause

The hook passes three thresholds to the ledger:

- `onTvl = max(last two readings, decaying memory)`;
- `offTvl = min(last two readings)`;
- `gradTvl = max(last two readings)`.

The ledger turns the cut on above the high threshold, off below the low threshold, and otherwise retains its previous state:

```solidity
if (v * BPS >= TARGET_BPS * onTvl) on = true;
else if (v * BPS < TARGET_BPS * offTvl) on = false;
```

Let `H` be honest TVL, `S` a high spike, and let the pool qualify at `H` but not at `S`. After `S,S` sets `creatorOn = false`, the alternating sequence `H,S,H,S,...` always produces:

```text
onTvl  = S
offTvl = H
```

The pool meets neither state-change condition, so `creatorOn` remains false. Decay of `recTvl` is irrelevant because the current spike remains in `onTvl`.

### Reproduction

`contracts/test/hook/AuditRecheck364a916.t.sol` contains three independent checks:

1. `test_oneSpikeDoesNotDivertCreatorCut` confirms the `10d7437` finding is fixed against an identical control.
2. `test_twoSpikesStillDivertAfterMemoryExpired` waits beyond one day, then shows the first honest observation still leaves the cut off and fees earned afterward receive no creator cut.
3. `test_alternatingSpikesKeepCutOffIndefinitely` alternates honest and spiked observations over six days, then demonstrates zero creator payment against a positive control payment.

### Recommendation

The current promises cannot all be derived from two spot observations. A single post-timeout reading cannot prove whether it is an honest recovery or the next atomic manipulation.

Choose one of these approaches:

1. Treat the behavior as an explicit symmetric residual. Document that, after two spikes turn the cut off, keeping it off requires a spike in at least one of every two consecutive observations. Remove the one-day upper-bound claim.
2. Use a wider observation window or majority rule so alternating honest/spike observations recover. This bounds the fraction of observations an attacker may control, but recovery remains observation-dependent.
3. Use source-side historical state or a manipulation-resistant oracle if recovery must be bounded by real time while isolated readings cannot flip the cut.

If an on-chain timeout is added, test both directions. Forcing the cut on from one post-timeout low observation would reopen the creator's atomic-dip path.

## Confirmed behavior

- One spike leaves an eligible creator cut on and pays the same amount as the honest control.
- One dip cannot turn an ineligible creator cut on.
- Graduation remains based on `max(last two readings)`, so one dip cannot graduate early and one spike is forgotten after two later readings.
- The launch observation still does not count toward the two-reading requirement.
- The earlier D-01 and D-03 fixes are unchanged.

## Verification

- Upstream scoped suite: **130 passed, 0 failed, 0 skipped** with Foundry 1.9.0 and Solc 0.8.26.
- Reviewer reproductions: the one-spike safe case passes; both post-expiry and alternating-spike fee-diversion cases reproduce.
- Formatting and `git diff --check`: passed.
- `DiscipleHook` deployed runtime: **24,134 bytes**, leaving **442 bytes** under EIP-170's 24,576-byte limit.
- `DiscipleHook` initcode: **24,948 bytes**.

The fork-named tests return early when RPC environment variables are absent. Forge reports them as passing, but they did not provide live-chain validation in this run.

## Mainnet disposition

Do not consider D-02 closed against the threat model as written. Either bound the off-state recovery under alternating spikes or explicitly accept and document the symmetric one-in-two manipulation residual before mainnet deployment.
