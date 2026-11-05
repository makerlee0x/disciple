# F-02: exact operation authentication before spending relayer funds

Every sync send MUST pass the actual EntryPoint `handleOps` eth_call, including
its exact signature, nonce, gas, paymaster and call data, using the selected
relayer as caller and beneficiary. Pending state is requested. This checks the
current account signature/modules, nonce and prefund. Reverts/RPC errors reject
before sender-only limit charging, relayer signing or broadcast. The standard
send path keeps its simulation and gains the same account-template check.

Account code must be the supported Solady ERC-1967 template (MAv2 SMA with its
20-byte immutable owner suffix, or legacy LightAccount v2). Its CURRENT storage
implementation must match the immutable implementation returned by its supported
factory. Reporting an implementation address from arbitrary code is not enough.
Undeployed accounts require a supported factory plus successful exact handleOps.
Unknown/custom/upgraded implementations fail closed rather than being trusted.

`disciple_warm(sender)` warms transport, nonce and fee/config data, not identity.
Neither a balance prime nor a previously successful operation can bypass a new
operation's simulation. Existing sender/strike records are telemetry only.
`FAST_RELAY_SIM` cannot opt out. No env/deployment/key changes are required.

## Latency and owner decision

There are no fixed sleeps or extra client round trips. Runtime + current
implementation slot reads run concurrently with exact handleOps simulation and
existing L1 gas estimation. Warm prefetches ONLY the factories' immutable
implementation anchors (not current owner, nonce, balance or operation validity).
Warm sends therefore have one parallel read/simulation round; cold anchors can
add a second round. No successful-op cache bypass is used: even the identical
signed op can become invalid after a nonce use, owner/module change or balance
drain. An op-hash cache that excludes the signature would also be insufficient.

Read-only public RH-testnet probes from this box, Nov 5 2026 (CT), five samples:
- Empty `handleOps` eth_call: 211, 143, 166, 172, 133 ms (median 166 ms).
- Cold two-stage account/config read chain: 334, 222, 217, 272, 225 ms (median 225 ms).
These are TRANSPORT BASELINES, NOT valid-trade or production latency measurements.
A real signed operation adds EVM validation/execution time. Warm parallelism
avoids serializing those reads; existing L1 estimation already occupied a round.
Estimate: additional tap latency ~0–200 ms warm, ~100–350 ms cold, provider/load
and operation dependent and potentially higher for complex ops. No zero-added-
latency guarantee is claimed. **OWNER DECISION: accept this security-first default
and benchmark real taps before rollout, or commission a fully authenticated,
state-bound optimization; do not restore balance/sender-level trust.**

## Boundaries and residual risks

A simulation is not an atomic inclusion guarantee: nonce consumption, owner/module
changes, account upgrades or funding changes AFTER simulation can still cause a
mined bundle to fail. Concurrent submissions of the same nonce are a state race,
not an excuse to trust cached simulation. No absolute “never any relayer loss”
claim is made. Mainnet rollout still needs shared replay/concurrency controls,
ERC-4337 validation-rule enforcement where applicable, and an owner-defined
loss circuit breaker/budget (audit recommendation; no arbitrary budget invented).
Tests reject forged ops at the validation state before signing/broadcast; they do
not prove immunity to adversarial state changes between simulation and inclusion.

F-01 overlap: only `fastRelay.ts` / `selfBundler.ts` may need reconciliation with
the other job's web AA work. No edits to DisciplePaymaster.sol, gasPolicy.ts,
paymasterCore.ts, paymasterDeposit.ts, AA client/session code, env or keys.
