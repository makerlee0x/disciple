# WIP: self-bundler speedups 1–3 (Nov 7, 2026, 10:35 AM CT handoff)

NOT READY TO MERGE. Lee requested a draft handoff before usage runs out.

## Unverified changes in this WIP
- `relayReadTransport.ts`: batch independent read-only JSON-RPC requests without changing their method/params/block tags or EVM caller; keep the existing scalar transport as compatibility fallback. No write method is batched. Applied to relay admission and core read clients. Needs tests for unsupported batch and simulation-revert handling.
- `TradeBridge.tsx`: warm buy quote independently of account/balance hints; warm exact configured sell preset amounts; coalesce interval warm passes; refresh every750ms under the existing1500ms TTL; refresh on focus/visibility and selection/custom-amount changes. Keep live-read fallback and all minOut/expiry checks. Network failure means a never-cold guarantee is impossible without changing behavior.
- `protocol-viem.ts`: exact USDG warming (no scaled substitute).
- Existing timing beacons/spans are unchanged. New parallel-structure spans are NOT implemented yet.

## Important unresolved safety constraint for speedup1
Current lockedRelay completes admission BEFORE shared lease acquisition. Exact simulation/current account reads then run UNDER the lease. Simply moving simulation before that lease and reusing it after admission can reuse stale state if a concurrent sender operation acquires and releases the lease during admission, even when our SET NX succeeds immediately. Moving lease acquisition before authentication also changes the prohibited abuse semantics. Need a design preserving the existing fencing/freshness, or retain final exact simulation under the lease (which does not yield the proposed full overlap gain). Do not claim the ideal~100ms model as implemented or measured. No admission/lease order has been changed in this WIP.

## Next
1. Resolve the above without weakening any check; otherwise explicitly report speedup1 blocked rather than silently changing lease/freshness semantics.
2. Add/run mocked batching/quote/admission tests, full existing unit/admission suite, tsc and lint. WIP is not yet fully tested.
3. Confirm branch Preview READY and alias points to it. No Production/settings/env changes.
4. Zero-op probes only if guaranteed to reject before broadcast; no trades. Budget remains39/60 accounted,41/60 conservatively reserved,19free.
5. Re-measure3 warm pairs only after separate spending approval; no live performance measurement claimed here.

## Historical measurement finding (source, not a rerun)
PR174 head0729d80bdee8f425ca9b732a617f8ea8c0801d02, `web/scripts/trade-latency.mts`, function one(): t0 before quote, t3 after await sa.sendCalls(owner), tapToLanded=t3-t0. The492–757ms buys/261–351ms sells are a Node script synthetic-tap→confirmed sendCalls completion, NOT browser pointerdown timing and NOT just HTTP request/response. Bundler request→response and server t.total are separate reported intervals. The324–552/103–125ms figures are server-only inner total, not whole handler admission/stream time. The~120ms optimistic display claim in PR174 is sent-time UI, not settlement, and must not be restored as done/fill.
