#!/usr/bin/env bash
# Live v0.2 pool tracker. Read-only: forks Robinhood "now" each round, compares our quotes with the real
# Uniswap route, logs centre gap, inventory, P&L vs holding the seed, and the tip jar. Never sends a tx.
#
#   cd contracts
#   FORK_RPC_RH=https://... bash script/hook/track-live.sh          # every 10 min, forever (Ctrl-C to stop)
#   EVERY=300 ONCE=1 FORK_RPC_RH=... bash script/hook/track-live.sh # one row, or another interval (seconds)
#
# Rows append to $OUT (default ../tracker/v02-live.csv). Summary: python3 script/hook/track-summary.py
set -u
: "${FORK_RPC_RH:?set FORK_RPC_RH to your Robinhood RPC}"
EVERY="${EVERY:-600}"
OUT="${OUT:-../tracker/v02-live.csv}"
mkdir -p "$(dirname "$OUT")"
HDR="time_utc,unix,block,src_price_x1e6,centre_gap_bp,sample_due,coin_raw,usdg_raw,coin_share_bp,pool_usd,hold_usd,pnl_usd,pnl_bp,jar_usd,buy1_bp,sell1_bp,buy5_bp,sell5_bp,buy20_bp,sell20_bp"
[ -s "$OUT" ] || echo "$HDR" > "$OUT"
export FORK_RPC_RH
while true; do
  LINE=$(FOUNDRY_PROFILE=solar forge test --match-path test/hook/LiveTracker.t.sol --match-test test_fork_track -vv 2>&1 \
    | grep -o 'TRACKROW,.*' | head -1)
  if [ -n "$LINE" ]; then
    ROW="${LINE#TRACKROW,}"
    TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    echo "$TS,$ROW" >> "$OUT"
    echo "$TS,$ROW" | awk -F, '{printf "%s  gap %sbp  pool $%s vs hold $%s (%sbp)  jar $%s  $1 buy/sell %s/%sbp  $20 %s/%sbp\n",$1,$5,$10,$11,$13,$14,$15,$16,$19,$20}'
  else
    echo "$(date -u +%H:%M:%SZ) run failed (RPC?), retrying next round"
  fi
  [ "${ONCE:-0}" = "1" ] && break
  sleep "$EVERY"
done
