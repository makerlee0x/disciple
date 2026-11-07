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
