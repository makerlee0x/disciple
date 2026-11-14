#!/usr/bin/env bash
# Started by carry-keeper.service. Reads the keeper's secrets from SSM Parameter Store (SecureString, decrypted by the
# instance role) into this service's private tmpfs folder, then runs the keeper. Nothing secret touches the disk.
set -euo pipefail
PREFIX="${PARAM_PREFIX:-/carry-keeper}"
RUN="${RUNTIME_DIRECTORY:-/run/carry-keeper}"
umask 077

param() { aws ssm get-parameter --with-decryption --name "$PREFIX/$1" --query Parameter.Value --output text; }
optparam() { aws ssm get-parameter --with-decryption --name "$PREFIX/$1" --query Parameter.Value --output text 2>/dev/null || true; }

param keystore > "$RUN/keystore.json"
param password > "$RUN/password"
export RH_RPC="$(param rpc)"
export ALERT_URL="$(optparam alert-url)"
export HEARTBEAT_URL="$(optparam heartbeat-url)"
export KEEPER_PASSWORD_FILE="$RUN/password"
export KEEPER_ACCOUNT="$RUN/keystore.json"
export KEEPER_CONFIG="${KEEPER_CONFIG:-/etc/carry-keeper/carry-keeper.json}"
export KEEPER_NAME="${KEEPER_NAME:-carry keeper (aws)}"

cd /opt/carry-keeper/keeper
exec /opt/node/bin/node --max-old-space-size=200 src/main.ts
