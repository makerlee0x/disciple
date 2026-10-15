#!/usr/bin/env bash
# Local dev chain for DISCIPLE: anvil + FLOW's Deploy.s.sol (read-only use of /contracts) + a mock
# STRATEGY quote as defaultQuote. Writes web/.env.local for NEXT_PUBLIC_CHAIN_ID=31337.
#   CONTRACTS_DIR=../contracts ./scripts/dev-anvil.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
C="${CONTRACTS_DIR:-../contracts}"
RPC=http://127.0.0.1:8545
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil default #0 (public test key)
pgrep -f "anvil --port 8545" >/dev/null || (anvil --port 8545 --code-size-limit 100000 >/tmp/anvil.log 2>&1 &) ; sleep 2
# KNOWN GAP (flow/contracts-v0): Deploy.s.sol mines the hook salt with HookMiner.find(deployer, …) but
# `new DiscipleHook{salt:…}` inside a forge script deploys via the CREATE2 factory
# (0x4e59b44847b379578588920cA78FbF26c0B4956C) → HookAddressNotValid revert. Needs FLOW to mine with
# CREATE2_FACTORY. Until then this step fails.
OUT=$(cd "$C" && forge script script/Deploy.s.sol:Deploy --rpc-url $RPC --private-key $PK --broadcast --code-size-limit 100000 2>&1)
addr(){ echo "$OUT" | awk -v k="$1" '$1==k{print $2}' | tail -1; }
LP=$(addr Launchpad); HOOK=$(addr DiscipleHook); PM=$(addr PoolManager); FR=$(addr FeeRouter)
Q=$(cd "$C" && forge create test/integration/IntegrationBase.sol:MockUSDG --rpc-url $RPC --private-key $PK --broadcast 2>&1 | awk '/Deployed to:/{print $3}')
cast send "$LP" "setDefaultQuote(address)" "$Q" --rpc-url $RPC --private-key $PK >/dev/null
cast send "$Q" "mint(address,uint256)" 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 1000000000000000000000000 --rpc-url $RPC --private-key $PK >/dev/null
cat > .env.local <<ENV
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_ANVIL_LAUNCHPAD=$LP
NEXT_PUBLIC_ANVIL_HOOK=$HOOK
NEXT_PUBLIC_ANVIL_POOL_MANAGER=$PM
NEXT_PUBLIC_ANVIL_FEE_ROUTER=$FR
NEXT_PUBLIC_ANVIL_DEFAULT_QUOTE=$Q

ENV
echo "Launchpad=$LP quote(mock STRATEGY)=$Q → wrote web/.env.local"
