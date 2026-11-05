# Disciple hook fix re-check

Reviewed revision: `e40bff0fbd1c4ea618f41004ca5cf3994a0e0ff5` on `claude/project-thread-lei7eb`, compared with `34a9676` and the original `6b13f72` review. This report concerns the standalone Disciple hook product, not the older launchpad application.

## Disposition

| Finding | Result |
| --- | --- |
| D-01: capital changes sharing in earlier trades | The original same-block reproduction is fixed. Deposit, withdrawal and restake settle open same-chain trades first. Remote withdrawal now reduces open flows in proportion to remaining capital. |
| D-02: source TVL manipulation enabling creator fees | Still open, Medium. The slow-falling gate limits short, closely spaced dips but does not establish that lower liquidity persisted. Two atomic-dip cases remain reproducible. |
| D-03: remote price and TVL decimal conversion | The original unit mismatch is fixed: separate `decShift` and `tvlShift`, with launch-time bounds and zero shifts enforced for same-chain pools. |

## D-02 remains open: idle-time decay and bootstrap allow a transient TVL reading to enable fees

Relevant code: `contracts/src/disciple/Disciple.sol:307-309`, `:502-516`, `:669-675`, `:740-745`.

`_gate` subtracts decay for the entire interval since `gateAt`, then takes the maximum of that decayed value and the current reading. It does not know whether the source was smaller during that interval. After 216,000 seconds (2.5 days) without an update, any one reading can replace the old gate completely. The source can remain fully funded during the wait and be reduced only during the transaction that touches Disciple.

Pool creation also initializes `gateTvl` directly from current source TVL. Creating during a proportional source-liquidity withdrawal installs a low gate without waiting for decay. Proportional withdrawal preserves the source price. Subsequent same-block capital settlements reuse that gate, even after liquidity has been restored, and can latch graduation and pay creator fees.

### Reproductions

`contracts/test/disciple/GateRecheck.t.sol` uses the existing test harness and actual local v4 PoolManager for Disciple custody/swaps; the v2 source reserves use the repository's mock pair. These tests assert vulnerable behavior; passing means the problem was reproduced. Reserve mutation models an attacker withdrawing and restoring liquidity they control. They do not implement a full live v2 LP burn/mint attack or establish net profit after gas and trading costs.

1. `test_idleThenAtomicDipStillPays`: create a roughly 4,000-quote-value pool beside a 4,000,000-quote-value source; leave the source unchanged through three idle days; dip the source to 4,000, touch Disciple, and restore it immediately. `creatorOn` becomes true. Execute trades and a capital settlement in the same block, with source liquidity restored. Creator claims are positive.
2. `test_creationDuringAtomicDipBootstrapsLowGate`: create the pool during the low source reading, restore liquidity, trade and settle in the creation block. Graduation latches and the creator receives a positive claim before a new block refreshes TVL.

The impact is a creator fee paid while the actual restored source is much larger than the 12% threshold permits, plus premature irreversible LP graduation. This is not evidence of draining all principal. Controlling enough source liquidity and arranging the relevant calls are prerequisites. The five-block repeated-dip regression does not exercise either case.

### Remediation

Do not count time before the first observed low value as evidence that a decrease persisted. Introduce explicit initialization and pending-decrease states; prevent a first sample, or the first sample after a stale interval, from immediately granting creator eligibility or latching graduation. Ensure same-block capital settlements cannot reuse eligibility obtained solely from a transient reading.

These changes close the demonstrated shortcuts but do not make spot sampling manipulation-proof: attackers can target every sampling transaction, and v4 depth passes combine observations taken at different times. If persistence is a security requirement, use an independently secured historical TVL measurement or source integration that records relevant liquidity changes. If the intended design instead accepts bounded manipulation, document and quantify that risk, including idle, bootstrap and v4 cached/partial-pass behavior. A decay-rate limit alone is not proof of sustained exposure across a block boundary.

Required regressions include both attached reproductions, near-threshold pools, repeated dips over long periods, honest intervening readings, first completed v4 depth passes, and cross-chain initialization/stale delivery. A fix should make the unsafe assertions fail and replace them with explicit safe-outcome assertions.

## Validation and limits

Using the repository-pinned Forge 1.9.0, solc 0.8.26, optimizer/via-IR/Cancun configuration and isolated execution:

- The unmodified scoped suite at `e40bff0` completed **121 passes, zero failures, zero skips**. The brief's stated 87-test count is stale. Several named fork tests return early when their RPC variables are absent, so those pass labels are not live-chain validation.
- Both added D-02 reproductions passed, meaning both vulnerable outcomes were reproduced. A combined run including the inherited test copies completed 149 passes.
- `forge build --sizes --skip test` reports a **23,755-byte** Disciple runtime, leaving **821 bytes** below EIP-170. This supersedes the 23,419-byte figure for the earlier revision.

This is a fix-focused re-check, not a new exhaustive audit of every module. No mainnet transactions were broadcast. No application-source changes were made during this review; the only additions are this report and the reviewer reproduction.
