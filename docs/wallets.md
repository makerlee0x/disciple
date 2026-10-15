# Wallets / signers

| Mode | Flag | Status |
|---|---|---|
| **Local browser key** (default) | `NEXT_PUBLIC_AA_SIGNER` unset | Testnet. The key is generated with viem `generatePrivateKey` and stored in localStorage (`disciple.local.ownerKey.v1`). It owns a LightAccount v2. Every action is one self-paid userOp sent through the Alchemy bundler. `/api/drip` tops up gas on first use. The wallet menu has Export, Import and Reset. **Not for real funds.** |
| Alchemy Account Kit (email/Google) | `NEXT_PUBLIC_AA_SIGNER=alchemy` | Code is in `lib/aa/session.ts`. It needs a Smart Wallets signer config on the Alchemy app (currently blocked for this account: "Creating new signer configs is not enabled"). |
| External wallet as owner / plain EOA | `NEXT_PUBLIC_DEV_WALLETS=1` | Dev fallback only. |
| **Privy (mainnet, TODO)** | — | Plan: `@privy-io/react-auth` embedded wallet as the LightAccount owner. Wrap its EIP-1193 provider as an `OwnerSigner` (`signMessage({message:{raw}})`) and call `startSession("privy", owner)` the same way as the local mode. Add the paymaster through `NEXT_PUBLIC_AA_SPONSOR=1`. |
