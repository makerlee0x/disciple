# Hosted BSO Phase 2 (testnet-only draft)

Default OFF. No contract, fee or Account Kit/AA SDK migration (both remain 4.88.5).
The existing legacy prepaid mode is unchanged when BSO is off. No recovery path is added.

Local-only opt-ins: `GAS_SPONSORSHIP_MODE=bso`, `NEXT_PUBLIC_GAS_SPONSORSHIP_MODE=bso`,
`ALCHEMY_BSO_POLICY_ID` set to the approved testnet policy. No Vercel env changes are part of this branch.
Production and chain IDs other than 46630 fail closed. Keep the Alchemy API key server-side.

The client uses separate fee/gas middleware and signs three zeros (max fee, tip, PVG),
without any paymaster fields or v5 reads/quotes/deposits. Gas is estimated afresh and
bounded before signing. The server adds `x-alchemy-policy-id` on the existing bundler
transport; it never takes a caller policy or exposes paymaster RPCs. Both cash reserve
adapters return zero for gas while preserving normal trade reservations.

Proxy admission decodes and re-encodes the full MAv2 envelope, all batched calls,
exact paired execution approvals and trades. It pins explicit recipients, verifies
curves/tokens against Launchpad, rejects native value/transfers/unknown calls, and
recognizes only exact SDK session install/uninstall encodings (fixed modules, hooks,
trade permissions, targets, quotes and bounded expiry). Existing policy sender
allowlist and caps remain Alchemy's responsibility; no webhook or policy edit.
All calls still pass invitation and rate limits. No owner trade fallback after a
BSO session failure. A successful RPC hash mismatch is ambiguous, never retried.

Intentional narrow scope: every sponsored trade must include its exact paired
approval, even if a previous allowance exists. Only buy/sell are sponsored; no
launches, tramps, walls, referral/login attest prefixes, credit or withdrawals.
SessionPolicy 1.4.3's existing onchain same-account credit permission is unchanged;
this proxy does not sponsor it. No claim that proxy denial proves onchain rejection.

## Local harness

`web/scripts/gasless-phase2.mts` refuses to run without `PHASE2_TESTNET_RUN=1` and
refuses Vercel/Production. It uses fresh disposable owner/session keys and directly
invokes this branch's actual `/api/bundler` handler at a fake localhost URL (no web
server or deployment). It does not replace admission, invitation, or rate limits.
Use `vitest run tests/bso-live.test.ts` from `/web`, with the approved donor env sourced
in that same shell command. The runner stubs only the `server-only` build marker;
React 18 cannot run with the global `react-server` condition. No admission or
provider code is mocked. Never log the donor key or upstream RPC URL.

The harness validates chain/router/token decimals/module ID and donor balances,
then gates on a zero-ETH deployment/session install **before** moving USDG. Funding
is at most 5 transfers of 1 test USDG each; no native ETH is sent to smart accounts.
The donor pays only its fixture funding transaction gas. At most 60 userOp sends
are permitted. No auto mint/faucet, custom relay, blind resend or fee retry.
A failed positive gate stops the matrix. Disposable fixture keys (never donor or Alchemy keys) persist mode 600 outside the
repo so an in-scope debug rerun can reuse funded test accounts. A cumulative ledger
preserves the 60-submit and 5-USDG limits across reruns; completed cases are not
repeated. Never rerun an ambiguous accepted operation as if it were a definite rejection.

Evidence is written outside the repo to `/workspace/gasless-phase2-evidence.json`:
request/response times, public op hashes, receipt/block times, onchain packed gas/PM
fields, pinned balances, trade deltas, user gas debit and donor funding hashes.
No signature/key is saved. Provider billing ledger and traces are not exposed.
Budget exhaustion is not provable on unlimited-free testnet. Inclusion timing uses
coarse block timestamps plus uncached receipt detection, not a claim of sub-ms
chain precision. A harness run is not a UI prompt-count test or production readiness.
