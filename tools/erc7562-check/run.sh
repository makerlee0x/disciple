#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
cd "$HERE"
command -v anvil >/dev/null || { echo 'anvil missing: add ~/.foundry/bin to PATH' >&2; exit 1; }
FORK_RPC=${FORK_RPC:-https://rpc.testnet.chain.robinhood.com}
PORT=${ANVIL_PORT:-18545}
export ANVIL_RPC="http://127.0.0.1:$PORT"
# Refuse an occupied port; never use an existing node, and never send to FORK_RPC.
node --input-type=module - "$PORT" <<'JS'
import net from 'node:net';
const s=net.createServer(); s.once('error',()=>{console.error('Anvil port occupied; choose ANVIL_PORT');process.exit(1)});s.listen(Number(process.argv[2]),'127.0.0.1',()=>s.close());
JS
ARGS=(--fork-url "$FORK_RPC" --chain-id 46630 --port "$PORT" --host 127.0.0.1 --silent)
[[ -z "${FORK_BLOCK:-}" ]] || ARGS+=(--fork-block-number "$FORK_BLOCK")
anvil "${ARGS[@]}" > anvil.log 2>&1 &
ANVIL_PID=$!
trap 'kill "$ANVIL_PID" 2>/dev/null || true; wait "$ANVIL_PID" 2>/dev/null || true' EXIT INT TERM
node --input-type=module - <<'JS'
const start=Date.now();
for(;;){
 try {const r=await fetch(process.env.ANVIL_RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'web3_clientVersion',params:[]})});const j=await r.json();if(String(j.result).startsWith('anvil/'))break;}catch{}
 if(Date.now()-start>45000)throw Error('Anvil startup timeout (see anvil.log; redact private RPC URLs before sharing)');
 await new Promise(r=>setTimeout(r,200));
}
JS
{ date '+%Y-%m-%d %H:%M:%S %Z'; anvil --version; forge --version; node --version; git -C bundler rev-parse HEAD; } > versions.txt
node_modules/.bin/tsx site-preflight.mts | tee site-preflight.log
node_modules/.bin/tsx --conditions=react-server check.mts | tee run.log
