#!/usr/bin/env bash
# Single DISCIPLE redeploy on RH testnet 46630 (steep curve #1, 16-band floor, referralSink, 7s sniper escrow,
# 6-dec mock USDG, AnonLauncher v2). See contracts/docs/redeploy-runbook.md.
#   Simulation only (default):      ./script/redeploy/redeploy.sh
#   Local fork dry run (anvil):     FORK=1 ./script/redeploy/redeploy.sh   (RPC_URL=http://127.0.0.1:8545, anvil key 0)
#   Broadcast (lee's GO only):      BROADCAST=1 ./script/redeploy/redeploy.sh
# Secrets: SECRETS_FILE (default /workspace/anypair/.secrets/testnet-deployer.env) must define PRIVATE_KEY. It is
# sourced, never printed. FORK=1 never reads it (uses anvil's default account 0 unless PRIVATE_KEY is already set).
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a
. script/redeploy/env.testnet
set +a
MODE=dry-run
EXTRA=()
if [[ "${FORK:-0}" == "1" ]]; then
  export RPC_URL="${FORK_RPC_URL:-http://127.0.0.1:8545}"
  export PRIVATE_KEY="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}" # anvil #0 (public)
  EXTRA+=(--broadcast --slow); MODE=fork
else
  set -a; . "${SECRETS_FILE:-/workspace/anypair/.secrets/testnet-deployer.env}"; set +a
  if [[ "${BROADCAST:-0}" == "1" ]]; then EXTRA+=(--broadcast --slow); MODE=broadcast; fi
fi
[[ "$MODE" == "broadcast" && "$RPC_URL" != "https://rpc.testnet.chain.robinhood.com" ]] && { echo "refusing: broadcast only to RH testnet"; exit 1; }
forge script script/Deploy.s.sol --tc Deploy --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" "${EXTRA[@]}" \
  | tee /tmp/redeploy-$MODE.log | grep -E "^  [A-Za-z ]+ (0x|[0-9])|Estimated|SIMULATION|ONCHAIN|Error|Total Paid"
node script/redeploy/postprocess.mjs "$MODE"
