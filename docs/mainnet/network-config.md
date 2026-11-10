# Mainnet guard inventory and configuration

Base: main `206b76d65d0826e6f2fa51f31205e3698e4138ac`. Mainnet chain **4663** is the existing repository target, not a newly chosen chain. Allowlist: 4663 mainnet, 46630 testnet, 31337 local. Unknown chains never fall back to testnet. No operational env/key files or addresses were changed.

## Guard list

| Location | Deliberate path |
|---|---|
| `contracts/script/Deploy.s.sol` old `block.chainid == 46630 || 31337` require | Shared `NetworkConfig._checkCoreConfig` before startBroadcast: explicit `DISCIPLE_NETWORK=mainnet`, matching `DISCIPLE_CHAIN_ID=4663`, required nonzero/code-bearing config, no mock-token fallbacks. Testnet/local behavior preserved; mismatched mode/chain rejected. |
| `DeploySessionPolicy.s.sol` (previously no chain guard) | Same allowlist/confirmation; mainnet requires a deployed, code-bearing REFERRAL_REGISTRY; PAYMASTER stays optional (zero = no paymaster approvals), same as testnet. |
| `anon/DeployAnonLauncherV2.s.sol` testnet ANON_V1 default | Same guard; mainnet requires explicit code-bearing ANON_V1, never the testnet fallback. Copies only that approved source's actual config. |
| `redeploy/redeploy.sh` fixed testnet URL + env/secrets/postprocess | Explicit mainnet branch before testnet sourcing; matching configured/actual RPC chain, ambient owner config, dry-run default. Never runs testnet postprocessor/fixtures for mainnet. Mainnet artifacts require separate review/export. We did not run this key-consuming wrapper. |
| `session.ts` faucet refill/drip and pre-Privy LightAccount migration checks; mint/test-cash endpoints; testnet smoke/demo/fixtures/postprocess | Testnet-only tools, not mainnet AA/deploy paths. Mainnet deliberately does not mint test assets, receive faucet top-ups or migrate old testnet accounts. Use user-funded ETH and the guarded core/session/anon deploy entrypoints. Do not run those legacy fixtures on mainnet. |

## Required owner input (placeholders — not operational configuration)

Core mainnet preflight requires these existing variable names, with no defaults filled here:

```
DISCIPLE_NETWORK=mainnet
DISCIPLE_CHAIN_ID=4663
TREASURY=<OWNER DECISION: verified custody address>
POOL_MANAGER=<OWNER DECISION: verified deployed contract>
V4_QUOTER=<OWNER DECISION: verified deployed contract>
USDG=<OWNER DECISION: verified deployed token>
DEFAULT_QUOTE=<OWNER DECISION: verified deployed token>
PVE_ATTESTER=<OWNER DECISION: public attester address, never its key>
EXPECT_USDG_DECIMALS=<verified token decimals>
MIN_LIQUIDITY=<OWNER DECISION>
PROBE_USDG=<OWNER DECISION, raw token units>
ANON_LAUNCH_FEE=<OWNER DECISION, raw token units; explicit zero permitted>
ERC5564_ANNOUNCER=<OWNER DECISION; explicit zero disables announcements>
```

Non-USDG default quote also requires DEFAULT_QUOTE_POOL_FEE, DEFAULT_QUOTE_POOL_TICK_SPACING and a nonzero deployed DEFAULT_QUOTE_POOL_HOOKS. Review/merge F-04 and use a compatible source pool with actual full-window history; a nonzero address/code check is not an oracle audit. Do not invent a pool/address. Core preflight does not implement SEC-04 handover: follow [the ownership checklist](SEC-04-ownership-handover.md).

`web/lib/networkConfig.ts` is a test-only helper (`aaNetworkReady`) used by `test:mainnet-guards`. It is not imported by `web/app` or other runtime code, and this PR does not change web runtime AA addresses, the pricer keeper, or login/trade behavior. Verify factory implementation, EntryPoint, modules and all code/ABI against the actual target deployment before opening the app. A syntactically valid config is not proof of deployment safety.


## Offline proof and production sizes

`MainnetGuards.t.sol`: testnet/local pass; absent mainnet confirmation or addresses, mode/chain mismatch, unknown chain and mock-asset request fail; **dummy** complete config passes the same guard used by Deploy, without broadcast. Web `test:mainnet-guards`: equivalent `aaNetworkReady` readiness/config checks against the test-only helper. Dummy fixtures are not deployment instructions. No wrapper, live deployment or transaction was run.

Production solc 0.8.26, optimizer 200, via-IR, Cancun on the base main SHA: Launchpad **24,399 / 24,576 B (177 B margin)**; BondingCurve **24,199 / 24,576 B (377 B margin)**. Guard/docs changes do not touch their source. Re-check final merged artifacts after F-01/removal and global LoginGate changes; these small margins are not final approval.
