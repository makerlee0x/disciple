# Session policy 1.4.3 with the v6 referral registry

Do not broadcast this. Do not change any Alchemy policy. Wait for lee's yes before deploying anything.

The live session policy 1.4.3 on Robinhood testnet (`0xD2cF85dd7cDC3c3e53EA0472BF6Bf006de45E4d2`) was constructed with the v5 referral registry (`0xFE529086B25C4e0724b88780E5ba9B4AcE785AAf`) and paymaster v5 (`0x5c3f7400ed41acd7409d213cab2909e3b1e31136`). Both of those constructor arguments are immutable, so this contract cannot be pointed at the v6 registry (`0x2c933d015815169900074e202c855276bbc0cc3a`).

The gasless relayer path does not use this session policy. This runbook is only for the case where we still need a 1.4.3 policy that talks to the v6 registry (for example a leftover 4337 session). If we do not need that path, leave the live 1.4.3 alone.

If lee later says yes, the existing script is `contracts/script/DeploySessionPolicyV143.s.sol`. It reads `REFERRAL_REGISTRY` and `PAYMASTER` from the environment and deploys a new policy. A testnet run would set:

- `REFERRAL_REGISTRY=0x2c933d015815169900074e202c855276bbc0cc3a`
- `PAYMASTER=0x5c3f7400ed41acd7409d213cab2909e3b1e31136` (the live v5 paymaster; do not use retired v4 `0x1e7b06adb1d0a92b83af2dc3d70cb4694e606822`)

Then, only after a second yes, record the new address and point any leftover session code at it. Do not edit Production env or create a new Vercel Preview origin as part of this.

Historical deploy files (dry-run, broadcast-v5, older sections of `rh-testnet-46630.json`) correctly still name the v5 registry and retired v4 paymaster. Those are records, not live fallbacks. Live app fallbacks are in `web/lib/chains.ts` and `web/lib/anon.ts`.
