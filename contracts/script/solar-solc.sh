#!/usr/bin/env bash
# Lets forge drive the Solar compiler (https://github.com/paradigmxyz/solar) as if it were solc.
# Used ONLY by `FOUNDRY_PROFILE=solar` for fast local builds and tests. Deployed bytecode always comes
# from solc 0.8.26 (the default profile); see README "Fast builds with Solar".
#
# forge reads the compiler version from `--version` and checks it against pragmas. Solar reports its own
# version string, and v4-core pins `pragma solidity 0.8.26;`, so we answer as 0.8.26. Every other call
# (forge uses `--standard-json`) is passed straight to Solar.
# Solar binary: $SOLAR_BIN, else `solar` on PATH (install: `cargo install solar-compiler --locked`, needs rustc 1.98+).
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  echo "solc, the solidity compiler commandline interface"
  echo "Version: 0.8.26+commit.8a97fa7a.Linux.g++"
  exit 0
fi
exec "${SOLAR_BIN:-solar}" "$@"
