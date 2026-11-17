#!/usr/bin/env bash
# Rebuilds Lighter's transaction signer (lighter-go, WebAssembly) into web/lib/server/lighter/signer/.
# The server loads it in Node to sign Disciple players' Lighter orders (web/lib/server/lighter/signer.ts).
# Needs Go 1.24+. wasm_exec.js must come from the same Go version that built the .wasm.
set -euo pipefail
VER="${LIGHTER_GO_VERSION:-v1.0.12}"
OUT="$(cd "$(dirname "$0")/../../web/lib/server/lighter/signer" && pwd)"
TMP="$(mktemp -d)"
cd "$TMP"
go mod init lighterbuild >/dev/null
GOFLAGS=-mod=mod go get "github.com/elliottech/lighter-go@${VER}"
SRC="$(go env GOMODCACHE)/github.com/elliottech/lighter-go@${VER}"
(cd "$SRC" && GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "$TMP/lighter-signer.wasm" ./wasm/)
gzip -9 -c "$TMP/lighter-signer.wasm" > "$OUT/lighter-signer.wasm.gz"
EXEC="$(go env GOROOT)/lib/wasm/wasm_exec.js"; [ -f "$EXEC" ] || EXEC="$(go env GOROOT)/misc/wasm/wasm_exec.js"
cp "$EXEC" "$OUT/wasm_exec.js"
echo "lighter-go ${VER}, $(go version | awk '{print $3}')" > "$OUT/VERSION"
echo "built into $OUT"
