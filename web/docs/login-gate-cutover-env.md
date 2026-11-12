# LoginGate / paymaster cutover — Vercel env checklist (RH testnet 46630)

Apply on prod (and preview if used) **together with** merge of #241 → #246 → this PR. Do not invent secrets.

## Set / update (public + server)

| Var | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_RHT_LOGIN_GATE` | `0xebDD6Ad15a6B838eE15Dc7d5871F09EFB284317D` | Wave #241 global LoginGate (also baked into `lib/chains.ts`) |
| `NEXT_PUBLIC_RHT_PAYMASTER` | `0x5C3f7400ED41aCd7409D213caB2909e3b1E31136` | DisciplePaymasterV5 (v4 `0x1E7B…6822` retired Nov 9) |
| `PAYMASTER_ADDRESS` | `0x5C3f7400ED41aCd7409D213caB2909e3b1E31136` | Server override; same address |
| `NEXT_PUBLIC_SESSION_POLICY` | `0xD2cF85dd7cDC3c3e53EA0472BF6Bf006de45E4d2` | Policy 1.4.3, bound to v5 (1.4.2 `0x61bb…c6b4` retired Nov 9) |
| `NEXT_PUBLIC_SESSION_POLICY_VERSION` | `1.4.3` | Must match `moduleId` |
| `PAYMASTER_MIN_STAKE_WEI` | `2173913043478261` | Deployed stake |
| `PAYMASTER_USD_PER_ETH` | `2300` | Lee locked Nov 6. Alt: `PAYMASTER_RATE=2300000000` (6-dec USDG). Set **one** only (`PAYMASTER_RATE` wins if both). |

## Leave unchanged / already correct

- Attester / signer keys unchanged (`PVE_ATTESTER_PRIVATE_KEY`; paymaster signer falls back to it).
- `/api/bundler` on Alchemy (`ALCHEMY_API_KEY`).
- Relay, drip, sponsorship, keeper **OFF** (#246).
- Do **not** change Privy / other paid settings.

## Legacy coins (option B)

Coin is legacy iff on-chain `curve.loginGate() !=` live LoginGate. UI shows **Legacy**; gated Easy buys are blocked in `protocol-viem` (no attest). No hardcoded coin list.
