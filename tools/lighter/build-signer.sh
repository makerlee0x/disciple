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
# Disciple patch: SetOrderTxExpiry(ms) sets the ExpiredAt of the next SignCreateOrder calls (0 = lighter-go's 10 min default),
# so pre-signed tap orders die within seconds instead of 10 minutes.
cp -r "$SRC" "$TMP/src" && chmod -R u+w "$TMP/src"
python3 - "$TMP/src/wasm/main.go" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace("func main() {\n", "var orderTxExpiry int64\n\nfunc main() {\n\tjs.Global().Set(\"SetOrderTxExpiry\", js.FuncOf(func(this js.Value, args []js.Value) interface{} {\n\t\torderTxExpiry = 0\n\t\tif len(args) > 0 && args[0].Type() == js.TypeNumber {\n\t\t\torderTxExpiry = int64(args[0].Float())\n\t\t}\n\t\treturn js.ValueOf(map[string]interface{}{})\n\t}))\n", 1)
a = "ops.TxAttributes = integratorTxAttributes(integratorAccountIndex, integratorTakerFee, integratorMakerFee, skipNonce, selfTradeBehaviorMode, selfTradeEqualityMode, txtypes.NilOrderVersion)\n"
i = s.index(a)  # the first one is SignCreateOrder
s = s[:i] + a + "\t\t\tif orderTxExpiry > 0 {\n\t\t\t\tops.ExpiredAt = orderTxExpiry\n\t\t\t}\n" + s[i+len(a):]
assert s.count("orderTxExpiry") == 5, s.count("orderTxExpiry")
open(p, "w").write(s)
PY
(cd "$TMP/src" && GOOS=js GOARCH=wasm GOFLAGS=-mod=mod go build -trimpath -ldflags="-s -w" -o "$TMP/lighter-signer.wasm" ./wasm/)
gzip -9 -c "$TMP/lighter-signer.wasm" > "$OUT/lighter-signer.wasm.gz"
EXEC="$(go env GOROOT)/lib/wasm/wasm_exec.js"; [ -f "$EXEC" ] || EXEC="$(go env GOROOT)/misc/wasm/wasm_exec.js"
cp "$EXEC" "$OUT/wasm_exec.js"
echo "lighter-go ${VER} + SetOrderTxExpiry, $(go version | awk '{print $3}')" > "$OUT/VERSION"
echo "built into $OUT"
