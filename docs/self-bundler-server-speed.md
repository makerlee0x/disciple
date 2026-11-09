# Self-bundler server scheduling — testnet Preview only

## History checked first

- #141 / f07ac2c6: keep-alive sync send, NDJSON receipt push and unchanged signed-byte ambiguity rules. Those are retained, not replaced.
- #150: integrated shared nonce/lease safety; no return to a per-process nonce shortcut.
- #174 / 0729d80b: early accepted frame already exists. Its optimistic final-fill behavior is NOT ported: pending stays pending until a real receipt.
- #181: checked the follow-up; no additional authenticated early-cleanup primitive to transplant.
- #140 / bb220f21: parallel cold nonce/base-fee warm and request-context waitUntil via existing `defer.ts`. Reuse these patterns with the current shared cursor. No dependency/env change.
- #245: immutable factory anchors can cache, but current account runtime/implementation slot and exact signed handleOps simulation remain mandatory on EVERY operation. Nothing here caches or skips them.

## Changes

Fresh LoginGate/chain/block, fresh revocable session, and target registry/selector reads start concurrently. Target deadlines still use the fresh chain timestamp. A queued sender re-runs the entire admission check after acquiring its lease, exactly as before. All IP/sender/global caps and store-failure rejection remain.

A bounded 256-entry/30-second cache contains ONLY pure policy moduleId, its immutable paymaster address, and positive write-once Launchpad.curveOf registrations. Proof: SessionPolicyV143.moduleId is pure, paymaster immutable; Launchpad.curveOf is assigned only when it creates a fresh token and curve (no setter/remapping). Zero, invalid or failed reads never cache. Curve metadata (including graduation) remains fresh. Cache identity includes chain/policy/launchpad/token. Do NOT extend this cache to LoginGate, active sessions, spend caps, balances, account slots, nonces or simulation. In particular, caching LoginGate until expiry would miss revoke() before expiry and would weaken the lockdown; no LoginGate cache is introduced.

The full streaming work promise is registered using the existing #140 waitUntil hook BEFORE work starts. Only then may the known final confirmed frame be enqueued and the stream closed before compare-and-delete lease release and settlement. The lease remains held until the original owner-tagged deletion completes. A rapid next press queues and re-authenticates. An ambiguous send never reaches the confirmed callback and retains its existing quarantine. Post-receipt cleanup errors cannot turn a known receipt into rollback; a failed deletion leaves the lease/TTL fail-closed. Without a working waitUntil hook, the original awaited cleanup-before-confirmation order is retained. No fire-and-forget serverless deletion.

Keep-alive was already on fastRelay; add the same option to the separate static admission RPC client. Reuse the historical parallel cold nonce/base-fee warm pattern, preserving the shared nonce allocator and all pre-sign checks.

## Timing contract

`[disciple] relay timing` retains `server:{simulate,signTx,send,mined,total,mode}` and adds `request:{startedAtUnixMs,...}` with parse, authLogin, sessionRead, targetSelector, admissionWall, rateLimitStore, leaseAcquire/leaseQueueWait, relayCoreWall, simulate, signTx, syncSend/mined, leaseRelease, reconciliation, responseFlushEnqueue and marks receiptReady/firstFrameEnqueued/confirmedFrameEnqueued/responseClosed/postWorkComplete plus protectedPostWork.

Start is entry into the Next POST handler (not an inferred request-ID timestamp or Vercel edge arrival). Parallel spans overlap; do not sum them. `unattributed` subtracts the union of measured span intervals from handler elapsed. `confirmedFrameEnqueued - receiptReady` shows server post-receipt delay before handoff. `postWorkComplete - confirmedFrameEnqueued` shows cleanup after handoff. `responseFlushEnqueue` is CPU serialization/enqueue time, not a kernel/TCP flush. Enqueue/close marks are SERVER TTFB proxies, NOT browser receipt/presentation measurements; true delivery/TTFB must come from browser/network evidence. The final log runs after cleanup, not on the pre-receipt trading path.

## No-operation local proof

The admission benchmark executes the real optimized admitRelay with mocked 80 ms read RTTs and compares the parent668ec0e6 await graph: LoginGate80 + session80 + target160 =320 ms before;160 ms cold after;80 ms warm after. Fresh LoginGate/session/curve metadata calls occur every iteration. These are deterministic scheduling measurements, not real RPC or EVM latency.

The real stream wrapper is tested with mocked465 ms core/60 ms release: confirmed frame525 ms before,465 ms protected after; cleanup completes525 ms in BOTH cases. Without waitUntil, confirmation remains525 ms. Regressions cover fresh revocation/expiry, target changes, exact simulation on every op, limits/store failures, queued re-authentication, ambiguous quarantine, confirmed-before-release and no rollback on cleanup error.

This morning's LIVE before remains simulate110/sign4/sync211/mined0/inner465 ms and approximately900 ms arrival-to-receipt-log (arrival inferred from request ID). No after-change live operation was sent. Hypothesis: remove roughly200–350 ms warm from admission/cleanup, yielding roughly550–700 ms server handoff if other conditions match. Not a guarantee or a claim to match Oct26. Full mandatory simulation110 + sync211 alone exceeds historical103–125 ms sell server total; never remove these checks to chase that number.
