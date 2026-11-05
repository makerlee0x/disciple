# Disciple hook fix re-check — `2cf8cfc`

Reviewed revision: `2cf8cfc8706e305a60239fdbcb350ec390c08a3b` on `claude/project-thread-lei7eb`, compared with `e40bff0` and the original `6b13f72` review. Scope follows `AUDIT_BRIEF5.md`: the standalone contracts under `contracts/src/hook`, their routes/libraries/tests and behavior guide. The older launchpad application and bridge routes are excluded.

## Disposition

| Finding | Result |
| --- | --- |
| D-01: capital changes sharing in earlier trades | Confirmed fixed. The implementation is unchanged in substance from the prior successful re-check. |
| D-02: source-TVL manipulation enabling creator fees | **Still open — Medium.** The exact `e40bff0` idle and creation-block reproductions are fixed, but an idle warm-up can join two atomic low readings, and the countermeasure also permits a transient high reading to delay graduation for a long time. |
| D-03: remote price and TVL decimal conversion | Confirmed fixed. Separate bounded `decShift` and `tvlShift` remain enforced. |

## R-01 — Two atomic low readings around an idle warm-up still enable creator fees

**Severity:** Medium.

**Locations:** `contracts/src/hook/DiscipleHook.sol:312-315`, `:508-523`, `:672-692`, `:757-762`.

The warm-up prevents creator eligibility for one day, but it does not require any source observation during that day. Pool creation installs its source TVL as both `srcTvl` and `gateTvl`. After the warm-up, `_gate` treats the stored creation reading as the previous reading. Therefore two low observations can be separated by a full day during which the source is restored and fully liquid:

1. Temporarily reduce source liquidity and create the Disciple pool. This records the first low TVL.
2. Restore source liquidity immediately and leave the new Disciple pool untouched throughout the warm-up.
3. After one day, temporarily reduce source liquidity only for the first Disciple touch. The stored creation value and this new value are two consecutive observed lows.
4. Restore source liquidity in the same transaction sequence. The low gate has already been judged outside the warm-up, so `creatorOn` becomes true and graduation latches.
5. Trades and a capital settlement later in that block reuse the low gate and produce a positive creator claim while the source is restored.

`test_launchDipIdleDayThenSecondDipStillPaysCreator` reproduces this sequence. Passing means vulnerable behavior was confirmed. The test uses the repository's local PoolManager for Disciple custody/swaps and its v2 source mock for reserve changes. It models proportional source-liquidity removal/restoration; it does not execute a live Uniswap LP burn/mint or establish net profit after funding and gas costs.

**Impact:** the creator can receive 12% of distributable fees while the restored source TVL is far above the eligibility threshold. LP graduation also latches early and permanently changes later fee accounting. The attack requires control of enough source liquidity, two timed source manipulations separated by a day, and no intervening Disciple touch that records the restored TVL. A quiet newly created pool supplies the last condition. No principal drain was demonstrated.

## R-02 — One transient high reading can cause prolonged graduation denial

**Severity:** Medium.

**Locations:** `contracts/src/hook/DiscipleHook.sol:672-687`.

The gate rises to any higher reading immediately. Its decline is capped to one hour of decay per later reading, regardless of the wall time between readings. A proportional source-liquidity addition can therefore be sampled once and removed, leaving a high gate that takes many subsequent Disciple touches to clear.

`test_oneHighReadingDelaysGraduationAfterSourceRestored` creates two otherwise identical pools whose values make them eligible against the real source TVL. A temporary 10x source-liquidity reading is sampled through a permissionless swap on one pool, then the source is restored. The control pool samples the restored source and graduates immediately. The attacked pool remains ungraduated after 30 daily restored-TVL readings because only one hour of decay is credited per reading.

At a 40% daily linear rate capped to one hour, each effective declining reading removes about 1.67% of the remaining gate. The first restored reading is also absorbed by the previous-high rule. In this example the gate remains roughly 24.5 million after a month, while the pool would be eligible once it falls to roughly 10 million. With one touch per day, recovery takes months.

**Impact:** a permissionless actor can delay LP payout graduation and creator fees without stopping swaps or withdrawals. Fees remain in the pool and compound, so this is an accounting/liveness disruption rather than a demonstrated custody loss. The reproduction changes mock reserves directly; a live attack would need a real proportional liquidity addition/removal, potentially with borrowed capital, and its cost was not measured.

## Recommended design changes

Do not allow the launch observation to count as the first post-warm-up low. The first observation after warm-up should initialize a fresh candidate and should not enable graduation or creator fees. This directly closes R-01, though two later targeted spot observations can still be manipulated.

Avoid using one state variable for both fee-safety and irreversible graduation. An immediate higher reading is conservative for preventing an improper creator cut, but it is unsafe as a long-lived graduation gate. Separate the creator-fee safety threshold from the graduation oracle, and require stronger evidence before latching graduation.

Bound or expire the effect of a single high observation. A symmetric rate limit, confirmation state, maximum age, or robust rolling statistic can limit R-02, but each has tradeoffs. In particular, a rule that only advances when the Disciple pool is touched makes recovery depend on activity rather than real elapsed time.

Spot samples cannot prove that liquidity persisted between samples. If sustained source exposure is a security requirement, use authenticated historical liquidity observations, source hooks/events that record liquidity changes, or an independently secured oracle. For v4, require distinct completed depth-pass identifiers/timestamps rather than treating repeated reads of one cached pass as independent evidence. Document any residual sampled-observation manipulation accepted by the design.

Add both reviewer reproductions as safe-outcome regressions. Also cover a low launch followed by an idle warm-up, a first post-warm-up observation, high-sample expiry, low-activity recovery, cross-chain initialization, and cached/partial v4 depth passes.

## Validation

- Repository-pinned Forge 1.9.0 and SHA-verified solc 0.8.26 were used with the repository optimizer, via-IR and Cancun settings.
- The unmodified scoped suite completed **125 passes, zero failures, zero skips**, matching the brief. Several fork-named tests return early without their RPC variables, so these pass labels are not live-chain validation.
- Both added reviewer reproductions passed, meaning both unsafe outcomes were reproduced.
- The compiled `DiscipleHook` runtime is **23,864 bytes**, leaving **712 bytes** below EIP-170. Initcode is 24,678 bytes.
- No live transactions were broadcast and no in-scope application source was modified. The only review additions are this report and `contracts/test/hook/GateThirdRecheck.t.sol`.

This is a focused fix re-check, not a new exhaustive audit of every hook module. Absence of another finding is not proof that the remaining code is defect-free.
