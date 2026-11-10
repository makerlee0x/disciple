# Disciple v0.2 deploy runbook (Robinhood, same-chain STRATEGY/USDG)

(File name kept from v0.1. v0.2 = flat-centre curve, read-only `quoteView`, swap gas cuts.)

Pool: STRATEGY/USDG, **1% fee**, seed **$200, 50/50** (about $100 USDG + $100 of STRATEGY). The wallet that
creates the pool (`disciple` keystore) becomes its creator. Every step after the dry runs is a real mainnet
transaction. Run them one at a time, from `contracts/`, with `FORK_RPC_RH` set to your Robinhood mainnet RPC.

## 0. Before you start
- v0.1 audit done and fixed (b40b914; nothing above Medium). The v0.2 changes since then (flat curve, quoteView,
  gas/storage packing) have their own brief: `docs/audit-brief-v0.2-diff.md`. Decide whether to re-audit first.
- Old pool emptied (done 2026-11-08; lot 3 dust stays).
- `git pull origin claude/project-thread-c2uvpb` (latest commit).
- All tests: `FOUNDRY_PROFILE=solar forge test --isolate` (1088 pass at 3134db0).
- LAUNCH GATE must pass at the planned seed and fee (added 2026-11-08 after the v0.1 curve went uncompetitive
  after one $2 trade; v0.1 itself FAILS it): `LAUNCH_GATE=1 FOUNDRY_PROFILE=solar forge test --isolate --match-path test/hook/LaunchGate.t.sol --match-test test_gate -vv`
- FORK LAUNCH GATE must pass against the real Uniswap route (STRATEGY/MSTR x MSTR/USDG, executed on a fork):
  `FORK_RPC_RH=<your RH RPC> FOUNDRY_PROFILE=solar forge test --match-test test_fork_launchGate -vv`

## 1. Check balances
Your deployer address:
```
cast wallet address --account disciple
```
It needs a little ETH (~0.001), at least 100 USDG, and enough STRATEGY for $100:
```
cast call 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 "balanceOf(address)(uint256)" <your address> --rpc-url $FORK_RPC_RH
```
```
cast call 0x168661C52E5922288dFb2b3f323b6Cf90eb21e18 "balanceOf(address)(uint256)" <your address> --rpc-url $FORK_RPC_RH
```
(USDG has 6 decimals: 100000000 = 100 USDG. STRATEGY has 18.)

## 2. Dry run hook + pool together on a fork (sends nothing)
Offer 60,000 STRATEGY and 100 USDG; the hook keeps a 50/50 split at the live price and refunds the excess.
```
COIN_IN=60000000000000000000000 QUOTE_IN=100000000 FEE=10000 forge script script/hook/DeploySameChainRH.s.sol --sig "both()" --fork-url $FORK_RPC_RH --sender <your address> 2>&1 | grep -E "DiscipleHook|reference|pool id|reserve|TVL|Error|error"
```
Check: "USDG reserve" should be about 100000000 (100 USDG). If it is lower, STRATEGY was the short side:
raise COIN_IN and rerun until USDG is about 100.

## 3. Deploy the hook
```
forge script script/hook/DeploySameChainRH.s.sol --sig "hook()" --rpc-url $FORK_RPC_RH --account disciple --broadcast --slow 2>&1 | grep -E "DiscipleHook|reference|Error|error"
```
Save the hook address. The library address it deployed:
```
grep -o 'DiscipleBooks:0x[0-9a-fA-F]\{40\}' broadcast/DeploySameChainRH.s.sol/4663/hook-latest.json | head -1
```

## 4. Verify (Sourcify)
```
forge verify-contract <LIB address> src/hook/DiscipleBooks.sol:DiscipleBooks --chain 4663 --verifier sourcify
```
```
forge verify-contract <HOOK address> src/hook/DiscipleHook.sol:DiscipleHook --chain 4663 --verifier sourcify --libraries src/hook/DiscipleBooks.sol:DiscipleBooks:<LIB address> --guess-constructor-args --rpc-url $FORK_RPC_RH
```
If Sourcify refuses the library, use the Blockscout web form for it (as on 2026-11-05).

## 5. Create the pool (same COIN_IN as the dry run)
```
HOOK=<HOOK address> COIN_IN=60000000000000000000000 QUOTE_IN=100000000 FEE=10000 forge script script/hook/DeploySameChainRH.s.sol --sig "pool()" --rpc-url $FORK_RPC_RH --account disciple --broadcast --slow 2>&1 | grep -A1 -E "pool id|reserve|TVL|Error|error"
```
Save the pool id.

## 5b. Canary on the live pool (read-only) — must pass before adding money or telling anyone
```
CANARY_HOOK=<HOOK address> CANARY_POOL=<POOL ID> FOUNDRY_PROFILE=solar forge test --match-test test_fork_canaryLivePool -vv
```
(It forks from `FORK_RPC_RH`.) It compares our quotes with the real Uniswap route at $1/$5/$20 both ways.

## 6. First checks with the test page
From the folder holding `pool-test-v01.html`:
```
python3 -m http.server 8000
```
Open `http://localhost:8000/pool-test-v01.html?hook=<HOOK>&pool=<POOL ID>` and connect.
1. Quote a 1 USDG buy and a 400 STRATEGY sell: each should be within about 1% (the fee) of Uniswap's price.
2. Buy 1 USDG, then sell what you got: both should match the quotes.
3. "Is a tip due?" should say false on a quiet pool. The jar starts empty and fills from 12% of fees, so the
   first tips only come after some trading.

## 7. After
- Merge #265, close #243 and #239.
- Uniswap allowlist request (custom-accounting hooks are allowlisted by hand) with the new hook address.
  Draft text: `docs/uniswap-allowlist-request.md`. Routers can price us with `quoteView(id, zeroForOne, amountSpecified)`.
- Keeper: if you run it, use the keeper from this branch (v0.2 storage offsets changed).
- Keeper: optional; same-chain pools also update on every trade and on free `sample()` calls.
