# Preview incident, 2026-11-07 (CT)

No trades or transactions were sent by this investigation. Do not interpret the bootstrap as a buy.

## Evidence

Account `0xf4C6B87aDBf4D762dfD104415B537b2cf5551109` is deployed. At block 149997953 (07:18:27 AM CT), wallet USDG was 2.398010 and v5 credit 1.970683, reserved zero. Its SessionPolicy 1.4.3 session was active, spent counters zero, expiring Nov 8 at 06:58:37 AM CT. LoginGate `verifiedUntil` was zero.

At 07:08:42 AM CT, transaction `0x9d63363d73e18122f5356eae458992ac7a0cf618a942d018a96488b64ea4c16d` deployed/setup the account and moved exactly 2 USDG into its v5 credit. `BootstrapAdmitted`, `Deposited`, `UserOperationCharged` and a successful EntryPoint `UserOperationEvent` prove this. Setup charged 0.029317 USDG from that credit; userOp hash `0xa28b636bf88398cbb941caec62b04e11334593d48258c04e0b2bbf61c3e798dc`. No trade token transfer or further account UserOp was found in the inspected range. The old 27-op counter therefore understates usage by at least one.

Old Preview runtime output through 07:07:26 AM CT still had paymaster reason `config`, message `hardened prepaid USDG paymaster unavailable`. Intermediate Preview output passed configuration, then showed reason `balance` / `not enough USDG: need 0.4018, have 0` before the bootstrap. This is CREDIT balance, not wallet balance. Intermediate deployment logged the successful bootstrap send at 07:08:41.686 AM CT. The latest deployment had no runtime output in the requested window. The exact reported 403/400/429 response bodies are not retained in these logs; do not invent them.

## Branch integration correction

The self relay correctly requires on-chain LoginGate authentication for every session op and warm call. Previously automatic one-tap setup installed the session/credit but never called the existing normal Privy-backed LoginGate path for non-PVE coins. The account consequently cannot pass the relay's unchanged authentication guard. Missing LoginGate is confirmed; attribution of each historic HTTP failure remains unconfirmed without its response body.

Background setup now reuses `ensurePveLoginOnchain` AFTER the existing bootstrap. This obtains a normal Privy bearer token, asks the existing server to verify the login/account and sign the existing attestation, then submits an OWNER-PAID setup op. It is not an admin attest, does not use the server EOA, does not modify the bootstrap batch and does not admit owner calls into the self relay. Owner/global/deferred calls remain on the existing paid external bundler route. No auth read, await or simulation skip is added to the warm trading path. The normal setup will spend an additional op and existing prepaid credit on the NEXT genuine browser sign-in; this investigation does not trigger it.

All server authentication, target/selector restrictions, simulation and rates remain unchanged. A public-only rejection log now exposes future admission errors; raw operations, signatures, tokens and RPC URLs are never logged. Flow timing uses console.error, not console.info, because the browser collector observes error-level output only. It does not throw.

## Next browser attempt (separate authorization to trade)

Close stale tabs to stop their warm/retry traffic. Use a fresh context and the new immutable Preview deployment URL with sanctioned deployment access, not the confidential share token in a report. Sign in normally to the SAME existing Privy account; confirm the smart account address before proceeding. Wait for normal LoginGate setup inclusion and `[disciple] relay LoginGate ready`, and a successful `disciple_warm` response. Confirm on-chain expiry is later than chain time. Do not deposit another 2 USDG, change keys, bypass the gate, or add settings/funds.

Verify scripts carry the NEW deployment ID. Existing open tabs can retain the old document/chunk loader after an alias changes; the observed old chunk alone does not prove which backend served its API calls. The alias HTML was independently observed serving `dpl_7Z5AEhyJ9XFM29psiUeYfzBdeXmv` before this fix. The precise cache origin of the driver's old document is not established.

Capture console.error `[disciple] flow timing` JSON plus network method, status and JSON/NDJSON response bodies. Successful terminal timing fields are `pressId,side,ok,tapToPaint,tapToReceipt,tapToFill,server,userOpHash,txHash`; failures may add `reason`. `server` preserves simulate/signTx/send/mined/total/mode. Paint/fill are double-rAF opportunities, not physical display timestamps. No live before/after latency claim is possible in this no-trades task.


## Follow-up: unresolved browser attempt, Nov 7, 7:33 AM CT

Read-only chain inspection proves the normal LoginGate setup DID land at 7:32:08 AM CT in transaction `0x9e3a2d068d412443f201e2d0b8a010f9dc1621f7935ebdb3562f5cd33b137067`, UserOp `0x5ff26577df1d16708a63da2ddb4d6773649d135a959791f6154e52bcf18830cf`, with a successful LoginAttested and UserOperationEvent. Login expiry is Nov 7, 7:32:06 PM CT. v5 charged 0.015958 USDG; credit is 1.954725, wallet remains 2.398010 and GTFRESH balance is zero. Session counters remain zero. The account has two confirmed UserOps since funding (bootstrap and auth), not a confirmed buy. Its EVM nonce is 1 and both known AA parallel keys have sequence 1; there is no single global AA nonce. An unknown buy key cannot be inferred from those values.

Seven observed warm rejections between 7:30:16 and 7:32:06 AM CT were unauthenticated LoginGate, BEFORE auth inclusion. The external paid auth send logged acceptance at 7:32:07.843 AM CT. No buy/stream timing record was available in the queried application logs. This does not prove the timed-out buy POST never arrived: these are not complete HTTP access records. Do not retry or clear reservations/leases merely because no event is found. Reconcile the original hash/nonce, pending relay nonce and signed validity window first.

The previous timing collector intentionally waited for a definite terminal outcome and therefore did NOT print while a fetch remained hung/unknown. It now emits one passive 15-second watchdog checkpoint with `ok:null, terminal:false, reason:"unresolved", elapsedMs`, known public IDs and null missing measurements. It does not roll back, release, retry, settle or label pending as failed/filled. It retains the span so a later real terminal result still emits its ordinary final line. Browser timer throttling can delay the checkpoint. Public IDs are copied from the already-existing op event, not from raw signatures. A warm-success log exposes only public relayer address and the existing sender lease TTL (`-2` absent; positive seconds remaining; null read unavailable), never the key/tag. TTL is read in parallel on background warm ONLY; the submit/simulation path is unchanged.


## Follow-up: first real self-relay buy, Nov 7 7:46:54 AM CT

Successful buy tx `0x615a572bfbe2c6eb7eb86f6f3f951fdd954a713a20fd9d7c3a8212017bf9f343`, UserOp `0x87f59bf918623adf6b3a97a6054102165f68f26a04293eb1a6de2dab0bf4a75c`, block150008408. The actual Preview EOA spent 0.000008971880 ETH and received 0.000012479041800000 ETH from EntryPoint, net +0.000003507161800000 ETH. Native balance delta and v5 EntryPoint deposit debit match exactly. Credit charged 0.031915 USDG; trade spent 0.200000 USDG; receipt/account holds 51.269321197702762464 GTFRESH. This single profitable op does NOT establish worst-case loss or sell behavior.

The reported later sell has no account event or extra relayer transaction; relayer latest/pending nonce1. Metrics show no completed bundler/paymaster/RPC request between7:47:00 and7:47:40 AM CT. The exact copy comes from protocol tradeNetworkError, either a pre-send read transport failure or an incomplete SDK build; its existing detailed trace was warn-level and not captured. The precise read/build label remains unconfirmed, so do not alter read budgets, SDK, approvals, fees or policy based on a guessed cause.

The deployed coin shared bundle3823-19a7c884c08c0b1f.js contains console.error('[disciple] flow timing',JSON.stringify(...)), with no enable flag; its actual pure module2470 was executed offline and emitted correctly. Standard BOOST/DUMP source routes through the instrumented global bridge. This rules out build stripping but does not prove what the browser collector observed or which running context it captured. Compatibility hardening now uses one-string error messages and a read-only bridge-installation probe. Missing capture itself is not claimed fixed until the driver observes the probe. Separately, server terminal stages were only streamed, not persisted as application logs; terminal timing/rejection logs now record public data after the result without extra awaits or RPCs. Pre-send diagnostics now expose redacted read/build labels at error level; failed loggers cannot affect retry classification. No trading behavior, automatic retry count, read budget or lockdown change.
