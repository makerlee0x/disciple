#!/usr/bin/env bash
# Combined RH testnet redeploy (core + snipe split + creatorBuyMaxBps + mcapNow fix + add-ons).
# Dry run (default):  ./script/redeploy/redeploy.sh
# Broadcast:          BROADCAST=1 ./script/redeploy/redeploy.sh
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
EXTRA=()
MODE=dry-run
if [[ "${BROADCAST:-0}" == "1" ]]; then EXTRA+=(--broadcast --slow); MODE=broadcast; fi
forge script script/Deploy.s.sol --tc Deploy --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" "${EXTRA[@]}" \
  | tee /tmp/redeploy-$MODE.log | grep -E "^  [A-Za-z]+ 0x|Estimated|SIMULATION|ONCHAIN|Error"
node script/redeploy/postprocess.mjs "$MODE"
