#!/usr/bin/env bash
# Keeper end-to-end test on local forks of Ethereum and Robinhood Chain. Nothing touches mainnet: it starts two
# anvil forks, deploys the v0 push route both ways with the lean DVN set and self-execution, creates test pools,
# runs the keeper, and plays the DVNs (the only step real DVNs do on mainnet).
#   FORK_ETH=<Ethereum RPC> FORK_RH=<Robinhood RPC> bash test/fork/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
KEEPER=$PWD
CONTRACTS=$KEEPER/../contracts
WORK=${WORK:-$(mktemp -d)}
E=http://127.0.0.1:${ETH_PORT:-8645}
R=http://127.0.0.1:${RH_PORT:-8646}
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # anvil dev key 0 (deployer, forks only)
OTHER=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a # anvil dev key 2 (another keeper)
ETH_DVNS=0x380275805876Ff19055EA900CDb2B46a94ecF20D,0x589dEDbD617e0CBcB916A9223F4d1300c294236b
RH_DVNS=0x1258A278519c7f4bd997a9c3BFd4Aa802a028D89,0xd01ae6905d48315f7bE10C7330aeCF8360Ef5b12
V2=0x8f1B19622a888c53C8eE4F7D7B4Dc8F574ff9068 # Ethereum v2 pair (source for the Robinhood pools)
RH_PM=0x8366a39CC670B4001A1121B8F6A443A643e40951
RH_WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
ETH_WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
RH_V4=0xa6975f4720a95aa9cdfa9b010a065b0e941534c93f9fa708104c08f0ac029ca0 # Robinhood v4 pool (source for the Ethereum pool)

anvil --fork-url "$FORK_ETH" --port "${E##*:}" --silent & A1=$!
anvil --fork-url "$FORK_RH" --port "${R##*:}" --silent & A2=$!
trap 'kill $A1 $A2 2>/dev/null' EXIT
until cast chain-id --rpc-url $E >/dev/null 2>&1 && cast chain-id --rpc-url $R >/dev/null 2>&1; do sleep 1; done

addr() { grep -E "$1" | head -1 | grep -oE '0x[0-9a-fA-F]{40}' | tail -1; }
cd "$CONTRACTS"
ETH_SENDER=$(AUDITED=1 DVN_SET=lean forge script script/hook/DeployV0Push.s.sol:DeployV0Push --sig "sender()" --rpc-url $E --private-key $PK --broadcast | addr "DisciplePushSender \(Ethereum\)")
OUT=$(PUSH_SENDER=$ETH_SENDER DVN_SET=lean forge script script/hook/DeployV0Push.s.sol:DeployV0Push --sig "robinhood()" --rpc-url $R --private-key $PK --broadcast --slow)
RH_RECEIVER=$(echo "$OUT" | addr "DisciplePushReceiver \(Robinhood\)"); RH_HOOK=$(echo "$OUT" | addr "DiscipleHook hook \(Robinhood\)"); RH_LIB=$(echo "$OUT" | addr "receive library")
RH_SENDER=$(DVN_SET=lean forge script script/hook/DeployV0Push.s.sol:DeployV0Push --sig "rhSender()" --rpc-url $R --private-key $PK --broadcast --slow | addr "DisciplePushSender \(Robinhood\)")
OUT=$(AUDITED=1 PUSH_SENDER=$RH_SENDER DVN_SET=lean forge script script/hook/DeployV0Push.s.sol:DeployV0Push --sig "ethereum()" --rpc-url $E --private-key $PK --broadcast --slow)
ETH_RECEIVER=$(echo "$OUT" | addr "DisciplePushReceiver \(Ethereum\)"); ETH_LIB=$(echo "$OUT" | addr "receive library")
ETH_HOOK=$(echo "$OUT" | addr "DiscipleHook hook \(Ethereum")
RH_FROM=$(cast block-number --rpc-url $R); ETH_FROM=$(cast block-number --rpc-url $E)
pool() { forge script script/keeper/KeeperForkPool.s.sol --private-key $PK --broadcast --slow "$@" | grep -A1 POOL_ID | tail -1 | tr -d ' '; }
# WETH-quoted pools with a funded jar, so the hook can value (and pay) the keeper's refunds
P1=$(HOOK=$RH_HOOK SRC=$V2 WETH=$RH_WETH pool --rpc-url $R)
P2=$(HOOK=$RH_HOOK SRC=$V2 WETH=$RH_WETH pool --rpc-url $R)
P3=$(HOOK=$ETH_HOOK SRC=$RH_PM SRC_KIND=3 SRC_V4_ID=$RH_V4 SRC_EID=30416 WETH=$ETH_WETH pool --rpc-url $E)
cd "$KEEPER"

cat > $WORK/config.json <<JSON
{
  "account": "$KEEPER/test/fixtures/keeper-test",
  "stateFile": "$WORK/state.json",
  "chains": {
    "ethereum": { "rpc": "$E", "logChunk": 1000, "maxFeeGwei": "100" },
    "robinhood": { "rpc": "$R", "logChunk": 1000, "maxFeeGwei": "10" }
  },
  "routes": [
    { "name": "eth-to-rh", "home": "ethereum", "dest": "robinhood", "sender": "$ETH_SENDER", "receiver": "$RH_RECEIVER", "hookFromBlock": $((RH_FROM - 5)), "senderFromBlock": $ETH_FROM },
    { "name": "rh-to-eth", "home": "robinhood", "dest": "ethereum", "sender": "$RH_SENDER", "receiver": "$ETH_RECEIVER", "hookFromBlock": $((ETH_FROM - 5)), "senderFromBlock": $RH_FROM }
  ]
}
JSON
export KEEPER_PASSWORD=test-password
LOG=$WORK/keeper.log
once() { node src/main.ts --config $WORK/config.json --once 2>&1 | { grep -v balance || true; } | tee -a $LOG $WORK/all.log; }
dvns() {
  node test/fork/fake-dvns.ts $WORK/state.json $R $RH_LIB $RH_DVNS 5 eth-to-rh
  node test/fork/fake-dvns.ts $WORK/state.json $E $ETH_LIB $ETH_DVNS 20 rh-to-eth
}
expect() { grep -qE "$1" $LOG || { echo "FAIL: expected '$1' in the keeper log"; exit 1; }; echo "ok: $2"; }
reserve1() { # scale the v2 pair's reserve1 by $1/100
  local w; w=$(cast storage $V2 8 --rpc-url $E)
  cast rpc anvil_setStorageAt $V2 0x8 "$(python3 -c "w=int('$w',16);m=(1<<112)-1;r0=w&m;r1=(w>>112)&m*$1//100;print('0x'+hex(((w>>224)<<224)|(r1<<112)|r0)[2:].rjust(64,'0'))")" --rpc-url $E >/dev/null
  cast rpc evm_mine --rpc-url $E >/dev/null
}

echo "== 1. opening prices (3 pools, both directions)"
once; dvns; once
expect "eth-to-rh: delivered nonce 1 .*accepted" "Ethereum -> Robinhood opening price delivered"
expect "rh-to-eth: delivered nonce 1 .*accepted" "Robinhood -> Ethereum opening price delivered"

echo "== 2. nothing to do when nothing moved"
: > $LOG; once
if grep -q "pushed" $LOG; then echo "FAIL: pushed without a reason"; exit 1; fi; echo "ok: no push without a move"

echo "== 3. another keeper's push is undelivered; the source moves 3%"
REQ="[(1,$V2,0x0000000000000000000000000000000000000000000000000000000000000000,[$P1])]"
TO=0x000000000000000000000000${RH_RECEIVER:2}
FEE=$(cast call $ETH_SENDER "quote(uint32,bytes32,(uint8,address,bytes32,bytes32[])[],uint128)(uint256)" 30416 $TO "$REQ" 300000 --rpc-url $E | awk '{print $1}')
cast send $ETH_SENDER "push(uint32,bytes32,(uint8,address,bytes32,bytes32[])[],uint128)" 30416 $TO "$REQ" 300000 --value $FEE --private-key $OTHER --rpc-url $E >/dev/null
reserve1 103
: > $LOG; once; dvns; once
expect "saw packet nonce 2 from" "saw the other keeper's packet"
expect "pushed nonce 3 \(0x[0-9a-f]+ move, 0x[0-9a-f]+ move\)" "one message for both pools on the moved source"
expect "delivered nonce 2 .*takeover" "delivered the other keeper's packet first (nonce order)"
expect "delivered nonce 3 .*accepted, credit 0\.0000[0-9]+ WETH; 0x[0-9a-f]+ accepted, credit 0\.0000[0-9]+ WETH" "both pools credited the move from their jars"

echo "== 4. an hour later, untraded pools get no (unpaid) heartbeat"
for u in $E $R; do cast rpc evm_increaseTime 3600 --rpc-url $u >/dev/null; cast rpc evm_mine --rpc-url $u >/dev/null; done
: > $LOG; once
if grep -q "pushed" $LOG; then echo "FAIL: unpaid heartbeat sent"; exit 1; fi; echo "ok: no unpaid heartbeat"
echo "== 5. collect the jar credits"
: > $LOG; node src/main.ts --config $WORK/config.json --collect 2>&1 | { grep -v balance || true; } | tee -a $LOG $WORK/all.log
expect "eth-to-rh: collected 0\.0000[0-9]+ WETH" "took the credits on Robinhood"
echo "ALL PASSED (work dir $WORK)"
