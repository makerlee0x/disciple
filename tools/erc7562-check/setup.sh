#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
CONTRACTS=$(cd -- "${1:-$PWD}" && pwd)
for tool in git node npm forge anvil; do
  command -v "$tool" >/dev/null || { echo "Missing $tool (install Foundry and Node 20+ first)" >&2; exit 1; }
done
[[ -f "$CONTRACTS/foundry.toml" && -f "$CONTRACTS/src/paymaster/DisciplePaymasterV5.sol" ]] || { echo 'Pass the PR clone contracts/ directory to setup.sh' >&2; exit 1; }
HEAD=$(git -C "$CONTRACTS" rev-parse HEAD)
echo "Checking DISCIPLE head $HEAD (results in this folder were recorded at 7b1fab32)"
fetch_exact() {
  local path=$1 repo=$2 rev=$3
  if [[ -d "$path/.git" ]]; then
    [[ "$(git -C "$path" rev-parse HEAD)" == "$rev" ]] || { echo "Wrong library revision: $path" >&2; exit 1; }
    return
  fi
  if [[ -e "$path/.git" ]]; then
    [[ "$(git -C "$path" rev-parse HEAD)" == "$rev" ]] || { echo "Wrong submodule revision: $path" >&2; exit 1; }
    return
  fi
  [[ ! -e "$path" ]] || [[ -z "$(ls -A "$path")" ]] || { echo "Will not overwrite non-empty $path" >&2; exit 1; }
  mkdir -p "$path"; git -C "$path" init -q
  git -C "$path" remote add origin "https://github.com/$repo.git"
  git -C "$path" fetch --depth 1 origin "$rev"
  git -C "$path" checkout -q --detach FETCH_HEAD
}
fetch_exact "$CONTRACTS/lib/forge-std" foundry-rs/forge-std f3dae6e6ee381f25eb6a246f7da9b85c91a68219
fetch_exact "$CONTRACTS/lib/openzeppelin-contracts" OpenZeppelin/openzeppelin-contracts cab19933c33c2ad1d4c7a84864a3601dddfd16f3
fetch_exact "$CONTRACTS/lib/v4-core" Uniswap/v4-core e50237c43811bd9b526eff40f26772152a42daba
fetch_exact "$CONTRACTS/lib/v4-periphery" Uniswap/v4-periphery 9969eec44cfdf07e24b41de47f40276a58401976
fetch_exact "$CONTRACTS/lib/v4-core/lib/solmate" transmissions11/solmate 4b47a19038b798b4a33d9749d25e570443520647
fetch_exact "$CONTRACTS/lib/v4-periphery/lib/permit2" Uniswap/permit2 cc56ad0f3439c502c246fc5cfcc3db92bb8b7219
fetch_exact "$HERE/bundler" eth-infinitism/bundler aae77140e5c2b1386d04eaeba2d23fc17a62bd87
mkdir -p "$HERE/compile/src/"{paymaster,session,utils} "$HERE/compile/lib" "$HERE/site/web/lib/aa" "$HERE/site/sdk/session-keys/src"
cp "$CONTRACTS/src/paymaster/DisciplePaymasterV5.sol" "$CONTRACTS/src/paymaster/IPaymasterV07.sol" "$HERE/compile/src/paymaster/"
cp "$CONTRACTS/src/session/DiscipleSessionPolicyV143.sol" "$CONTRACTS/src/session/IERC6900.sol" "$HERE/compile/src/session/"
cp "$CONTRACTS/src/utils/Owned2Step.sol" "$HERE/compile/src/utils/"
# No whole-tree compilation. Only these five source files and their OZ dependency closure are compiled.
[[ -e "$HERE/compile/lib/openzeppelin-contracts" ]] || ln -s "$CONTRACTS/lib/openzeppelin-contracts" "$HERE/compile/lib/openzeppelin-contracts"
cp "$CONTRACTS/../web/lib/aa/"{constants,paymaster,paymasterClient,prepayBootstrap}.ts "$HERE/site/web/lib/aa/"
cp "$CONTRACTS/../sdk/session-keys/src/"*.ts "$HERE/site/sdk/session-keys/src/"
cat > "$HERE/compile/foundry.toml" <<'TOML'
[profile.default]
src = "src"
out = "../artifacts"
cache_path = "../forge-cache-small"
solc_version = "0.8.26"
auto_detect_solc = false
optimizer = true
optimizer_runs = 200
via_ir = true
evm_version = "cancun"
remappings = ["@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/"]
TOML
cd "$HERE"
npm ci --no-fund --no-audit
node build-validator.mjs
FOUNDRY_PROFILE=default forge build --root compile --threads 2 > forge-build-small.log 2>&1
printf 'Prepared PR %s; compiled ONLY 14 dependency-closure files with normal solc 0.8.26.\n' "$HEAD"
printf 'Run: bash %q/run.sh\n' "$HERE"
