#!/usr/bin/env bash
# Keeper same-chain sampler test on a plain local anvil (no fork, no RPC key): deploys a whole same-chain
# Disciple setup with mocks, moves the leader 5%, and checks the keeper samples the pool, gets tipped from the
# jar while the centre is 1%+ behind, and stops once it has caught up.
#   bash test/local/same-chain.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
KEEPER=$PWD
CONTRACTS=$KEEPER/../contracts
WORK=${WORK:-$(mktemp -d)}
PORT=${PORT:-8655}
U=http://127.0.0.1:$PORT
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # anvil dev key 0 (deployer, local only)

anvil --port $PORT --silent & A=$!
trap 'kill $A 2>/dev/null' EXIT
until cast chain-id --rpc-url $U >/dev/null 2>&1; do sleep 0.5; done

cd "$CONTRACTS"
OUT=$(forge script script/keeper/KeeperSameChainLocal.s.sol --rpc-url $U --private-key $PK --broadcast --slow)
HOOK=$(echo "$OUT" | grep -oE "HOOK 0x[0-9a-fA-F]{40}" | awk '{print $2}')
PAIR=$(echo "$OUT" | grep -oE "PAIR 0x[0-9a-fA-F]{40}" | awk '{print $2}')
POOL=$(echo "$OUT" | grep -A1 POOL_ID | tail -1 | tr -d ' ')
cd "$KEEPER"
echo "hook $HOOK pool $POOL"

cat > $WORK/config.json <<JSON
{
  "account": "$KEEPER/test/fixtures/keeper-test",
  "stateFile": "$WORK/state.json",
  "chains": { "local": { "rpc": "$U", "chainId": 31337, "eid": 0, "endpoint": "0x0000000000000000000000000000000000000001", "logChunk": 1000, "maxFeeGwei": "10" } },
  "sameChain": [ { "name": "local-same", "chain": "local", "hook": "$HOOK", "fromBlock": 1 } ]
}
JSON
export KEEPER_PASSWORD=test-password
LOG=$WORK/keeper.log
once() { node src/main.ts --config $WORK/config.json --once 2>&1 | { grep -v balance || true; } | tee -a $LOG $WORK/all.log; }
expect() { grep -qE "$1" $LOG || { echo "FAIL: expected '$1' in the keeper log"; exit 1; }; echo "ok: $2"; }
none() { if grep -qE "$1" $LOG; then echo "FAIL: did not expect '$1'"; exit 1; fi; echo "ok: $2"; }

echo "== 1. finds the pool; nothing to do while the centre sits on the leader"
cast rpc evm_mine --rpc-url $U >/dev/null
: > $LOG; once
expect "local-same: sampling pool $POOL" "found the pool from its Created event"
none "sampled" "no sample while caught up"

echo "== 2. the leader moves +5%: tipped samples until caught up"
cast send $PAIR "set(uint112,uint112)" 1000000000000000000000000 2100000000000000000000000 --private-key $PK --rpc-url $U >/dev/null
: > $LOG
# anvil only mines on a tx, and the hook takes one reading per block: mine one between rounds, as a live chain would
for i in $(seq 1 10); do cast rpc evm_mine --rpc-url $U >/dev/null; once; done
expect "sampled 0x[0-9a-f]{8} tx 0x[0-9a-f]+, tip [0-9.]+ (USD|COIN)" "tip paid from the jar"
N=$(grep -cE "sampled .* tip " $LOG || true)
echo "   $N tipped samples to catch up 5%"
[ "$N" -ge 3 ] && [ "$N" -le 8 ] || { echo "FAIL: expected 3-8 tipped samples (1% step), got $N"; exit 1; }
none "no tip" "never sent a sample that paid nothing"
: > $LOG; for i in 1 2; do cast rpc evm_mine --rpc-url $U >/dev/null; once; done
none "sampled" "stops once caught up"
node src/main.ts --config $WORK/config.json --status 2>&1 | grep -v balance
echo "ALL PASSED (work dir $WORK)"
