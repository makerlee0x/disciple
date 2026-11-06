# LoginGate / paymaster cutover — Vercel env checklist (RH testnet 46630)

Apply on prod (and preview if used) **together with** merge of #241 → #246 → this PR. Do not invent secrets.

## Set / update (public + server)

| Var | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_RHT_LOGIN_GATE` | `0xebDD6Ad15a6B838eE15Dc7d5871F09EFB284317D` | Wave #241 global LoginGate (also baked into `lib/chains.ts`) |
| `NEXT_PUBLIC_RHT_PAYMASTER` | `0x1E7B06adb1D0A92b83AF2Dc3D70Cb4694E606822` | Wave #246 DisciplePaymaster v4 |
| `PAYMASTER_ADDRESS` | `0x1E7B06adb1D0A92b83AF2Dc3D70Cb4694E606822` | Server override; same address |
| `NEXT_PUBLIC_SESSION_POLICY` | `0x61bb745881c2db24f6f61E35C7fF1de1dBFaC6b4` | Policy 1.4.2 |
| `NEXT_PUBLIC_SESSION_POLICY_VERSION` | `1.4.2` | Must match `moduleId` |
| `PAYMASTER_MIN_STAKE_WEI` | `2173913043478261` | Deployed stake |
| `PAYMASTER_USD_PER_ETH` | `2300` | Lee locked Nov 6. Alt: `PAYMASTER_RATE=2300000000` (6-dec USDG). Set **one** only (`PAYMASTER_RATE` wins if both). |

## Leave unchanged / already correct

- Attester / signer keys unchanged (`PVE_ATTESTER_PRIVATE_KEY`; paymaster signer falls back to it).
- `/api/bundler` on Alchemy (`ALCHEMY_API_KEY`).
- Relay, drip, sponsorship, keeper **OFF** (#246).
- Do **not** change Privy / other paid settings.

## Legacy coins (option B)

Coin is legacy iff on-chain `curve.loginGate() !=` live LoginGate. UI shows **Legacy**; gated Easy buys are blocked in `protocol-viem` (no attest). No hardcoded coin list.
