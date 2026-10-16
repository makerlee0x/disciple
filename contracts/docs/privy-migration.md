# Privy migration (replace Alchemy Account Kit signer)

Status: **plan / doc only.** No `/web` code changed here (owned by DISCIPLE SITE/GAME).

## Verdict
- **Robinhood Chain testnet (46630):** supported as a custom chain. Privy docs ("Configuring EVM networks") say embedded wallets work with *any* EVM chain via viem `defineChain` in `defaultChain`/`supportedChains`. 46630 has no Privy-hosted RPC, so we pass our own RPC (`addRpcUrlOverrideToChain` or the RPC in `defineChain`). It is not in Privy's default chain list, so it must be configured explicitly.
- **Recommended path:** Privy = **auth + EOA key custody only**. That Privy EOA is the **owner/signer of an Alchemy Modular Account v2 (SemiModularAccount)** sent through ERC-4337. `DiscipleSessionPolicy` + SingleSigner session keys stay the same (see `session-keys.md`). Gas is paid by the user from the smart account (no paymaster).
- **Bundler:** Alchemy bundler on RH testnet, used **without** a gas policy (self-pay). It already works: today's LightAccount flow and the MAv2 session-key prototype both ran on 46630 through it, via `/api/bundler`. Pimlico/other bundlers: we have not confirmed RH testnet support, so treat them as a fallback only.
- **Not recommended now:** Privy native smart wallets (Kernel/Safe/Light/Biconomy/Thirdweb via Privy dashboard). They use Privy's own paymaster/bundler config per chain, our chain is custom, and our policy is an ERC-6900 MAv2 hook. Kernel/Safe would mean porting DiscipleSessionPolicy to ERC-7579/Safe modules and getting it re-reviewed.
- **Privy session signers / policies** (server-side signers with Privy-enforced policies): these are off-chain, and Privy's backend enforces them. They add a trust assumption and a server key. On-chain `DiscipleSessionPolicy` is strictly stronger. At most, use them later as an extra layer.
- **EIP-7702 (Privy EOA delegated to MAv2):** Privy can sign 7702 authorizations (`useSign7702Authorization`), and Alchemy Wallet APIs default to 7702 → MAv2. It is viable only if RH testnet accepts type-4 txs and Alchemy Wallet APIs list chain 46630. **Verify on chain before adopting** (send one type-4 tx). Benefit: address = EOA, no counterfactual account. Cost: one more moving part, and the session-key module install on a 7702 account still has to be tested. Phase 2 option.

## Architecture
```
Privy (email/Google/wallet login) ── embedded EOA (owner)
        │ toViemAccount(wallet)
        ▼
Alchemy MAv2 SemiModularAccount (counterfactual, user-funded via drip faucet
0xb692E9B49786001bb4a8F4Dc3090f1c7d2cc956E)
   ├─ owner validation (fallback signer = Privy EOA): install/revoke sessions, withdrawals
   └─ SingleSigner session key (non-global, execute/executeBatch) + DiscipleSessionPolicy hooks
        ▼ one-tap trades signed locally by the session key, no Privy popup
ERC-4337 EntryPoint v0.7 → Alchemy bundler (self-pay, no policyId)
```

## Packages
- `@privy-io/react-auth` (PrivyProvider, usePrivy, useWallets, toViemAccount)
- `@privy-io/chains` (optional, `addRpcUrlOverrideToChain`)
- `@privy-io/node` (server only, if we verify Privy access tokens in API routes, e.g. chat identity)
- Keep `viem`. For MAv2 use `@account-kit/smart-contracts` (`createModularAccountV2`) + `@aa-sdk/core`, or `@alchemy/wallet-apis` with `requestAccount({creationHint:{accountType:"sma-b"}})`. `sdk/session-keys` already builds the install calldata.
- Remove `@account-kit/signer` (Turnkey).

## Env vars
| Var | Where |
|---|---|
| `NEXT_PUBLIC_PRIVY_APP_ID=cmvbbneom00580fi99lq70mh4` | client (public) |
| `PRIVY_APP_SECRET` | **server only** (Vercel env, never `NEXT_PUBLIC_`) |
| `NEXT_PUBLIC_RHT_RPC_URL`, `NEXT_PUBLIC_AA_BUNDLER_URL` (`/api/bundler`) | unchanged |
| `NEXT_PUBLIC_AA_SPONSOR` | keep `0` / unset (self-pay) |

## Config snippet
```tsx
import { PrivyProvider } from "@privy-io/react-auth";
import { defineChain } from "viem";

export const rhTestnet = defineChain({
  id: 46630, name: "Robinhood Chain Testnet", network: "robinhood-testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_RHT_RPC_URL || "https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
});

<PrivyProvider appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!} config={{
  loginMethods: ["email", "google", "wallet"],
  embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" }, showWalletUIs: false },
  defaultChain: rhTestnet, supportedChains: [rhTestnet],
}}>{children}</PrivyProvider>
```
Owner signer for the AA code:
```ts
const { wallets } = useWallets();
const w = wallets.find(w => w.walletClientType === "privy");
const owner = await toViemAccount({ wallet: w! }); // viem LocalAccount → MAv2 owner
```
(`showWalletUIs:false` hides the confirm modal for owner-signed ops. Keep it on for install/withdraw if we want explicit consent.)

## Session key flow (unchanged on chain)
1. Login → Privy EOA → MAv2 counterfactual address (salt 0). User funds it from the faucet.
2. "Enable one-tap" → owner (Privy) signs **one** userOp: `installValidation(SingleSigner, sessionKey)` + DiscipleSessionPolicy hooks (built by `sdk/session-keys`). The user pays gas.
3. Trades: session key in IndexedDB/localStorage signs userOps. The bundler gets self-pay ops. The policy enforces targets/selectors/caps/expiry.
4. Revoke/expire → owner signs uninstall. Withdrawals are owner-only.

## Changes needed in `web/` (for SITE/GAME owners)
- `lib/aa/core.ts`: `LightSmartAccount` (LA v2 factory `0x…400CdFef…`) → MAv2 account. Keep `alchemyBundler`, `userOpHash`, EntryPoint v0.7. Drop `DEFAULT_GAS_POLICY_ID` usage (self-pay).
- `lib/aa/session.ts`: `OwnerSigner` comes from `toViemAccount(privyWallet)` (its `signMessage({message:{raw}})` matches the current type). Remove `ALCHEMY_KEY` signer usage. Keep `BUNDLER_URL`.
- `lib/aa/policy.ts`: client checks become UX pre-checks only. Enforcement moves on chain.
- `components/WalletButton.tsx`: replace the Account Kit email/Google flow with `usePrivy().login()`. Existing-wallet path: Privy `wallet` login method.
- `lib/chat/client.ts`, `lib/server/chat/identity.ts`: identity = smart-account address. Server can verify Privy access token with `@privy-io/node` using `PRIVY_APP_SECRET`.
- `scripts/test-aa-fork.mts`: switch to MAv2 + local owner.
- Wrap the app in `PrivyProvider` (client component).

## Testnet user migration
- Owner key changes (Turnkey → Privy), and so does the account type (LA v2 → MAv2). So **every user gets a new address**. Testnet only: no key export. Users re-login, re-drip from the faucet, and old LA balances stay behind. Optional: a "sweep old account" button while Account Kit is still loaded for one release (old owner signs `executeBatch` transfers to the new MAv2).
- Profiles/chat keyed by address: offer a link flow (old-owner signature + new-owner signature) or reset (testnet).
- For mainnet, Alchemy documents a signer export/import into Privy (Alchemy→Privy migration guide). Not needed for testnet.

## Privy dashboard settings (Maker)
1. **Allowed origins** (App settings → Domains): `https://disciple-pearl.vercel.app`, `http://localhost:3000` (plus any custom domain). For Vercel previews, add the preview domain or use Privy's allowed-origins wildcard if offered.
2. Login methods: Email, Google (and External wallets if we keep "bring your wallet"). Google OAuth needs Privy's client or our own credentials.
3. Embedded wallets: Ethereum **enabled**, create on login for users without wallets.
4. **Smart wallets: leave OFF** (we run our own MAv2 + bundler).
5. Optional: Gas sponsorship OFF, MFA policy, and session signers off for now.
6. Set Vercel env `NEXT_PUBLIC_PRIVY_APP_ID` and `PRIVY_APP_SECRET` (server only).

## Credential check
`GET https://auth.privy.io/api/v1/apps/<appId>` with basic auth (appId:secret) returned **200** on 2026-10-16. The secret is never committed.
