# Session keys: on-chain lockdown for one-tap trading

Status: **v1 implemented (this PR), not deployed.** Contract: `src/session/DiscipleSessionPolicy.sol`.
Tests: `test/session/`. TS helper: `sdk/session-keys/`. The earlier prototype and its testnet results are kept below.

## Mechanism chosen
**Alchemy Modular Account v2 (SemiModularAccount, ERC-6900 v0.8) + Alchemy `SingleSignerValidation` for the
session key + our own `DiscipleSessionPolicy` hook module.** Alchemy's `TimeRange` hook is optional and adds a second expiry check.

| Option | Verdict |
|---|---|
| LightAccount v2 as is | **Not possible.** LA v2 has one owner and no modules. A key it accepts has full control. Today's `web/lib/aa/policy.ts` check runs only in the client, so it protects nothing once the key leaks. |
| MAv2 + Alchemy `AllowlistModule` + `TimeRange` + `NativeTokenLimit` (prototype) | Audited and works on RH testnet. But it only checks target and selector, so it cannot pin the `approve` spender or the `recipient`. It also cannot allow **dynamic bonding curves**: each launch makes a new curve address, and pre-graduation trades go to those curves. |
| Custom validation module that replaces SingleSigner | Gives full control, but we would own the signature-checking code. That is the riskiest part to write ourselves. |
| **MAv2 + SingleSigner (Alchemy) + DiscipleSessionPolicy hooks (chosen)** | Signature checks stay in Alchemy's audited module. Our code only runs as **hooks**, and a hook can only reject. It cannot grant extra permissions. It closes the recipient, spender and curve gaps. It is about 300 lines and has no admin, no owner and no upgradability. |

Defense in depth: SingleSigner is installed **non-global** with only `execute`/`executeBatch` selectors. So the session key can never
call `installValidation`, `upgradeToAndCall`, `uninstallValidation`, and so on. The account itself rejects those calls before our hooks run.

### What DiscipleSessionPolicy enforces
Each session is stored per account and per entity id. The validation hook uses entity `E` and the execution hook uses entity `E | 2^31`.

| Rule | Where | Detail |
|---|---|---|
| Only `execute` / `executeBatch` | both | anything else reverts (`OnlyExecuteCalls`) |
| Expiry (default 24h, SDK max 7d) | validation | returns `validUntil`/`validAfter` in the userOp validationData. The EntryPoint enforces it. The runtime path reverts. |
| Revoked / uninstalled | both | `SessionInactive` |
| Targets | both | `router`, `launchpad`, `anonLauncher`, `trampWallManager` come from the install config (taken from deployments JSON). The account itself and the policy contract are never allowed targets. |
| Selectors (bitmask `P_*`) | both | Router `buyExactIn`/`sellExactIn`; TWM `placeTramp`/`placeWall`/`cancel`; Launchpad `launch`/`launchCoin`; AnonLauncher `launchAnon`; curve `buy`/`sell` (3- and 4-arg); ERC-20 `approve`. **No** `transfer`, `transferFrom`, `permit`, or `*WithPermit` |
| Bonding curves | execution | target must satisfy `launchpad.curveOf(curve.token()) == curve`. This is an external call, which ERC-7562 forbids in validation, so it runs in the execution hook. |
| Recipient pinning | execution | `recipient == account` for router buy/sell and 4-arg curve buy/sell. `buyRecipient == account` for `launchAnon`. |
| Approve spender pinning | execution | spender must be one of the 4 DISCIPLE targets or a registered curve |
| Spend cap | execution | the total `approve` amount on `quote0`/`quote1` (e.g. USDG, STRATEGY) is capped at `cap0`/`cap1` per session. This overcounts on purpose: approve exactly the trade size. Rocket-token approves (sells and walls) are uncapped, but they are spender-pinned and their proceeds go to the account. |
| Slippage (minOut) | execution | for router `buyExactIn`/`sellExactIn` and curve `buy`/`sell`: `minOut != 0` (`ZeroMinOut`) and `minOut >= quote × (1 − maxSlippageBps)` (`MinOutTooLow`). The quote is read on-chain in the execution hook: `DiscipleRouter.quoteExactIn` after graduation (simulate-and-revert, includes the 1% hook fee), `curve.quoteBuy`/`quoteSell` before. `maxSlippageBps` is set by the owner per session (default 500 = 5%, max 5000). If the quote fails, the trade reverts (`QuoteFailed`). |
| ETH | both | `value` must be 0 on the account call and on every inner call |
| ERC-1271 | sig hook | reverts. Session keys never sign messages. |

Storage is keyed `mapping(entityId => mapping(account => Session))`, so validation-phase reads are account-associated (ERC-7562).

### Revocation
* **End session (preferred):** the owner calls `uninstallValidation(SingleSigner‖E, abi.encode(E), [abi.encode(E), abi.encode(E|2^31), (abi.encode(E) for TimeRange)])`.
  This removes the key and clears storage. SDK: `buildUninstallSession`.
* **Kill switch (cheap):** the owner calls `execute(policy, 0, revoke(E))`. SDK: `buildRevokeSession`.
* Expiry is automatic. Install a new session for a new key/budget (random `entityId`); stale sessions can be uninstalled lazily.

### Slippage check limits
* The quote is taken **in the same tx, right before the trade**. It stops a session key from sending zero or absurd `minOut`. It does **not** stop a sandwich: a front-run in an *earlier* tx has already moved the price when the quote is read. That leg is bounded by DiscipleRouter's `maxImpactBps` (PR #44, default 50%), by the client's own `minOut` (computed off-chain before signing, so it reflects the pre-attack price), and by the session cap.
* In a batch, every trade is quoted against the **pre-batch** state. A later trade in the same batch on the same pool can fail falsely if an earlier one moved the price. Send one trade per pool per batch.
* Clients: compute `minOut` with `minOutFor(quote, slippage)` (SDK) using `slippage ≤ maxSlippageBps`.

### Residual risks (stolen session key, within one session)
* It can spend up to the cap on poor trades. `minOut = 0` is now blocked, but self-sandwiching within the router impact cap is still possible (see above). Mitigation: a small cap and a short TTL.
* It can launch coins (if `P_LAUNCH`/`P_ANON_LAUNCH` was granted) and pick `stealthOwner`, which redirects creator fees. That is why launches are **off by default** in `TRADE_PERMS`.
* It can place tramps or walls at bad ticks and cancel them. Positions stay owned by the account.
* Allowances left over after the session stay granted only to DISCIPLE contracts, and those only pull funds from `msg.sender` for its own trade.

## Migration from LightAccount v2
Users' embedded accounts (GAME PR #17) are LightAccount v2. Two paths:
1. **In-place upgrade (keeps the address, funds and positions; recommended):** the owner sends one userOp:
   `upgradeToAndCall(SemiModularAccountStorageOnly impl, initialize(owner))`. aa-sdk ships this flow (`getMAV2UpgradeToData` in `@account-kit/smart-contracts`).
   Verify the RH-testnet impl address and storage-slot compatibility before running it on real users. Do a dry run with `eth_call` first.
2. New accounts: create MAv2 `SemiModularAccountBytecode` directly (factory `0x00000000000017c61b5bEe81050EC8eFc9c6fecd`, as in the demo).

After migration the owner signer (Alchemy email/Google signer or the derived EOA key) stays the **fallback signer** (entity 0, global).
The existing `web/lib/aa/core.ts` LightAccount userOp signer needs an MAv2 variant. MAv2 signatures carry a validation-selection prefix (fallback signer vs. entity id). Do not hand-roll them:
use aa-sdk `createModularAccountV2Client({ signerEntity })` rather than writing this by hand.

## Integration (SITE / GAME)
```ts
import { buildCreateSession, buildUninstallSession, routerBuyCalls, encodeSessionBatch, readSession } from "@disciple/session-keys";
// 1. Browser makes a session key (keep the key in memory/IndexedDB; never send or log it)
const sk = privateKeyToAccount(generatePrivateKey());
// 2. Owner installs it: one owner-signed userOp with callData = s.data (self-call)
const s = buildCreateSession({
  modules: { policy: d.sessionPolicy, singleSigner: getDefaultSingleSignerValidationModuleAddress(chain), timeRange: getDefaultTimeRangeModuleAddress(chain) },
  targets: { router: d.router, launchpad: d.launchpad, anonLauncher: d.anonLauncher, trampWallManager: d.trampWallManager },
  sessionSigner: sk.address, caps: [{ token: d.usdg, cap: parseUnits("100", 6) }], ttlSec: 24 * 3600,
});
// 3. One-tap trade: session-signed userOp (MAv2 client with signerEntity { entityId: s.entityId, isGlobalValidation: false })
const callData = encodeSessionBatch(routerBuyCalls({ account, router: d.router, quote: d.usdg, token, quoteIn, minOut, deadline }));
// 4. UI: readSession(pc, d.sessionPolicy, account, s.entityId) → remaining budget / expiry; "End session" → buildUninstallSession
```
Steps: (a) deploy `DiscipleSessionPolicy` (`script/DeploySessionPolicy.s.sol`) and add `sessionPolicy` to deployments JSON; (b) GAME switches
account creation to MAv2 / adds the upgrade flow; (c) SITE replaces the client-only `policy.ts` gate with the on-chain session
(keep the client check as a UX pre-flight); (d) simulate every session userOp before sending, so reverts cost no gas.

---

# Prototype (2026-10-15): Alchemy modules only

Status: prototype, working on RH testnet 46630. Demo: `contracts/script/session-keys/demo.mjs`.

## What a session key may do
A session key is an extra validation installed on the user's MAv2 smart account (SemiModularAccount, owner = user EOA):

| Control | Module (RH testnet address) | Config in demo |
|---|---|---|
| Signer | SingleSignerValidation `0x00000000000099DE0BF6fA90dEB851E2A2df7d83` | entity 8, **non-global**, only `execute` / `executeBatch` |
| Allowed targets + selectors | AllowlistModule `0x00000000003e826473a313e600b5b9b791f5a59a` (validation hook) | STRATEGY `approve`; DiscipleRouter `buyExactIn` / `sellExactIn` |
| ERC-20 spend limit | AllowlistModule (**execution** hook, entity 8 + 2^31) | 50 STRATEGY total |
| Expiry | TimeRange `0x00000000000082B8e2012be914dFA4f62A0573eA` | `validUntil = now + 1h` |
| Native ETH limit (optional) | NativeTokenLimit `0x00000000000001e541f0D090868FBe24b59Fbe06` | not used: the router spends ERC-20 quote |

TrampWallManager and Launchpad can be added as targets the same way. The demo uses Launchpad as the "not allowed" target.

Gotcha: an ERC-20 spend limit set on the Allowlist **validation** hook is not enforced. The limit lives in the execution hook, so it needs its own entity id. This matches aa-sdk `PermissionBuilder`. Our first attempt approved over the limit, and the fix is now in the demo.

## Testnet demo result (2026-10-15)
Account `0xBfBEA03391cC033977Ec1072d734E93D3Ae020F9` (owner = CREATOR key, salt 46630).

| Step | Tx / result |
|---|---|
| Owner installs session key + hooks | `0x2e1fd7b19df0286ece15e7ce5e13a506b41a6e423b4885a5b2c25c704c604cf8` (514k gas) |
| Session key: approve 10 STRATEGY + `buyExactIn` TRMP | `0xd92ad909f20faa0e64fdccef1239df5123604b7c7841272c69e8811ac2749ee1` (324k gas) |
| Call a target that is not allowed (Launchpad) | rejected |
| STRATEGY `transfer` (selector not allowed) | rejected |
| approve 45 when 40 of the limit remains | rejected |
| Random EOA using the session entity | rejected |
| Session key calling `installValidation` | rejected |

The negative checks run as `eth_call` simulations and cost no gas.

**Path used:** runtime validation (`executeWithRuntimeValidation`, where the session-key EOA pays its own gas). The ERC-4337 userOp path (`demo-bundler.mjs`) is blocked for two reasons:
1. Alchemy gas sponsorship is not enabled for the app.
2. The current `ALCHEMY_API_KEY` returns `Must be authenticated!` on every method (the key appears to have been rotated or revoked).

The same modules and hooks apply on both paths.

## Recommendation
1. **Ship v1 with session keys as an opt-in "quick trade" mode** on MAv2 SemiModularAccount. Use a 1h to 24h expiry, a per-session quote budget (ERC-20 limit on the execution hook) and an allowlist of DiscipleRouter `buyExactIn`/`sellExactIn` plus the quote token's `approve`. Never make the key global. Never allowlist `installValidation`, `upgradeToAndCall`, or `transfer` of the quote token.
2. **The production path is userOps through the bundler with a paymaster.** The session key lives in the browser (non-extractable WebCrypto or localStorage, scoped to the tab). Gasless only works if Alchemy sponsorship is enabled (see mainnet-plan.md). Until then, the runtime path needs ETH on the session key, which is bad UX.
3. **Pin the approve spender.** The Allowlist checks target and selector, not arguments. A session key could `approve(attacker, ≤limit)`. The limit caps the damage, but for mainnet consider a tiny custom validation hook that also pins the `approve` spender to DiscipleRouter, or add a `permit`-style router entry.
4. **Recipient pinning:** `buyExactIn` takes `recipient`. A stolen key could buy to another address, still bounded by the budget. The same custom hook (or a router variant that forces `recipient = msg.sender`) closes this. **Recommended before mainnet.**
5. Revocation: the owner calls `uninstallValidation(entity)`. Expose this in the UI as "end session".
