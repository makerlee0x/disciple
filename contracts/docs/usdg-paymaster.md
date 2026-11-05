# Historical USDG paymaster — disabled

Owner decision (2026-11-05): no gas sponsorship on testnet or mainnet. F-01 is resolved by removing the production paymaster path, not by changing the legacy contract.

- `/api/paymaster` and `/api/drip` return HTTP 410. Quote/signing/allowance clients, quote signer, deposit cache and funding keeper are removed.
- Accounts submit self-paid operations only; all chain configurations set `paymaster` to zero regardless of old environment values.
- `DeployPaymaster.run()` always reverts before any environment read, broadcast, deployment, deposit or stake. Future session-policy deployments use a zero paymaster.
- `DisciplePaymaster.sol` is unchanged from main. It MUST NOT be redeployed or funded. `PaymasterDebt.t.sol` intentionally retains the historical unpaid-debt exploit as evidence, not as a hardened production contract.
- The public protocol fast/standard self-relayers are removed. `/api/bundler` only proxies standard self-paid operations to the external Alchemy bundler, and never falls back to protocol signing.

See [the AA funding/operations trace](../../web/docs/audit-f01-f02-self-paid-gas.md) for native-prefund bootstrapping, provider availability, latency, and existing on-chain exposure. Disabling source paths does not withdraw a previously deployed paymaster's deposit or invalidate already signed quotes; that needs a separate owner-approved operational action.
