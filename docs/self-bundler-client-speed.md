# Receipt-first completion + post-render client beacon (testnet Preview only)

## Provenance (rule 4)

Reuse #140 pointer/click measurement and parallel read-only warming patterns, #141 returned sync receipts, the existing #140 waitUntil/stream behavior, and the #174 receipt-driven final fill. Do NOT port old trust/simulation skips or acceptance-as-final-fill. Keep #150 shared cursor/lease safeguards; prior #181 review supplied no further safe transplant. New adaptations: post-render sendBeacon log route, synchronous/idempotent receipt ledger with post-render memory-only cache CAS, deposit prefetch alongside admission, detailed subspans.

No reusable telemetry/log route existed in web/app/api on inspection. New POST /api/aa/flow-timing reuses requireSelfBundlerMode (local/Preview chain46630 only, rejects Production). Client reuses clientSelfBundlerMode's Production block. No new environment variable.

## Client measurements

Capture true pointerdown on buy/sell buttons (desktop and phone), on capture phase with event.timeStamp on the performance clock. Later click/bridge does not reset it; keyboard paths retain their existing click/bridge clock. All deltas are same-browser monotonic times, not browser/server wall-clock subtraction.

Flow rows include request start, fetch response headers (TTFB proxy, explicitly labelled), first pending/confirmed frame consumed, synchronous applyOwn start/end, and React terminal-row commit plus double-rAF paint opportunity. Double-rAF is not GPU presentation proof. Quote/balance/allowance counters are press-scoped foreground cache decisions, not background global activity. Retries retain the same pressId and accumulate cache decisions; first timing marks are retained. Missing stages are null.

A React terminal-row commit effect arms the done paint measurement; only after its double-rAF and actual resolved outcome does a zero-delay callback issue ONE fire-and-forget navigator.sendBeacon. Never awaited by a trade; false/throw never retried, no fetch fallback. Background-tab console timeout must not cause a beacon before a terminal render; unresolved watchdog does not beacon. Alerts/early aborts without a bound trade press do not generate a trade beacon.

Log prefix: `[disciple] client flow timing `, one JSON string; source=client-untrusted. Route allowlists identifiers/side/boolean, finite bounded numeric timings/counters; strips hashes, calldata, arbitrary strings, server objects and unknown keys. Body streaming capped4096bytes, cross-origin rejected, process-local cap120/min. No chain/KV/signer call. Client data is never authorization or proof of a fill.

## Receipt-first completion (fix 1)

Before: applyOwn awaited account/balance hints and cache synchronization before fill/done; a cold hint could RPC. After: capture only memory baselines before send; apply confirmed receipt Transfer deltas synchronously to OwnLedger; decode returned fill with config-known USDG decimals and captured trading account. No balance/account RPC can be awaited between returned logs and fill/done. Record applyOwn timings. Keep current-state account effect dependency.

OwnLedger deduplicates by owner/token/transaction, including unknown-base debits left to reconciliation. Replaying an older receipt after another fill cannot double-book it. Unknown credit remains the existing lower-bound behavior. Delayed memory-only cache CAS runs after the committed terminal row paints; it checks the observed cache value and current ledger fillTx/value, so old work cannot overwrite a newer fill. Cold cache repair stays in the EXISTING pinned >=1-second reconciliation; no new post-fill public balance read is introduced. No accepted frame is a final fill. Existing failure/unknown reservations and rollback remain.

## Deposit overlap (fix 2)

After the existing mode/Production gate, read-only configured-PM deposit prefetch begins alongside admission. Only an exact configured paymaster can trigger it. No lease, nonce, signature, send or rate charge is moved early. Prefetch rejection is observed to avoid unhandled promises and remains failure if the relay reaches the paymaster guard.

Under the unchanged sender lease, after unchanged fee/gas caps, await completion then call the original paymasterDepositCached getter AGAIN before checkPaymaster. The prefetched numeric value is NEVER authority: a local prefund debit or queued wait crossing TTL is honored by this second getter. TTL stays10000ms; no deposit/authorization cache expansion. Full exact simulation, mutable admission, caps, nonce allocation/recovery, leases, quarantine and byte-identical send semantics stay.

Server request fields added: paymasterDepositPrefetch, paymasterDeposit, baseFee, nonceWarm, nonceAllocate, nonceRecover, l1Check, l1ResidualWait. L1 total and its post-simulation residual wait are distinct; overlapping spans are not additive wall time.

## Expected gain, not a live result

Existing 8:21 AM CT sell: handler->confirmed588ms, inner454ms, residual119ms. If a stale deposit RPC dominated that residual, overlap should remove roughly90–120ms, around470–500ms sell handoff under comparable conditions. Cache-hit deposit may save ~0. Local deterministic test with real TTL getter + mocked100ms admission/100ms RPC proves200->100ms scheduling, not live chain speed.

Fix1 removes whatever conditional balance/account/cache network wait previously occurred; warm hits save near zero. The prior UI envelope~962–1394ms cannot all be claimed as saved. New client beacons are needed on the next separately authorized operation to assign it. No trades for this change.
