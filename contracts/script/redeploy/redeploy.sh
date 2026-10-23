#!/usr/bin/env bash
# Combined RH testnet redeploy (core + snipe split + creatorBuyMaxBps + mcapNow fix + add-ons).
# Dry run (default):  ./script/redeploy/redeploy.sh
# Broadcast:          BROADCAST=1 ./script/redeploy/redeploy.sh
# 6-dec mock USDG:    USDG6=1 [BROADCAST=1] ./script/redeploy/redeploy.sh
#   Ignores env.testnet's USDG / DEFAULT_QUOTE / pool / ANON_LAUNCH_FEE and has Deploy.s.sol deploy a fresh
#   6-decimal mock USDG (DevToken, MOCK_USDG_MINT default $1T minted to the deployer) + a mock STRATEGY with a
#   seeded STRATEGY/USDG pricer pool at $0.00245; ANON_LAUNCH_FEE defaults to $0.25 (250000 raw).
# Secrets: SECRETS_FILE (default /workspace/anypair/.secrets/testnet-deployer.env) must define PRIVATE_KEY.
# On-chain post-steps run inside Deploy.s.sol: STRATEGY/USDG pricer pool, UniversalRouter allowlist,
# RewardsVault wiring (FeeRouter.setRewardsVault + vault.setFeeRouter), hook.setPricer, AnonLauncher + MarketLens.
# Off-chain post-steps (postprocess.mjs): deployments json + web bundle (addresses + ABIs, JSON + TS).
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a
. script/redeploy/env.testnet
. "${SECRETS_FILE:-/workspace/anypair/.secrets/testnet-deployer.env}"
set +a
if [[ "${USDG6:-0}" == "1" ]]; then
  unset USDG DEFAULT_QUOTE DEFAULT_QUOTE_POOL_FEE DEFAULT_QUOTE_POOL_TICK_SPACING DEFAULT_QUOTE_POOL_HOOKS ANON_LAUNCH_FEE
  export MOCK_USDG_DECIMALS=6
  echo "USDG6=1: deploying a 6-decimal mock USDG + mock STRATEGY (env.testnet USDG/DEFAULT_QUOTE ignored)"
fi
EXTRA=()
MODE=dry-run
if [[ "${BROADCAST:-0}" == "1" ]]; then EXTRA+=(--broadcast --slow); MODE=broadcast; fi
forge script script/Deploy.s.sol --tc Deploy --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" "${EXTRA[@]}" \
  | tee /tmp/redeploy-$MODE.log | grep -E "^  [A-Za-z]+ 0x|Estimated|SIMULATION|ONCHAIN|Error"
node script/redeploy/postprocess.mjs "$MODE"
