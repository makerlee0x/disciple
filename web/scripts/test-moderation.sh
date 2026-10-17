#!/usr/bin/env bash
# Moderation route smoke test. Uses only safe images + SYNTHETIC mocked classifier scores.
set -u
cd "$(dirname "$0")/.."
# Denylist: Upstash KV when configured, else in-memory per server process (lib/server/denylist), so the reupload checks
# run against the same server instance that recorded the block (they show provider "denylist", not "mock").
P=3041
srv(){ fuser -k $P/tcp >/dev/null 2>&1; sleep 1; env "$@" ./node_modules/.bin/next start -p $P >/tmp/modtest.log 2>&1 & sleep 5; }
post(){ curl -s -m 30 -F "file=@$1${2:+;type=$2}" localhost:$P/api/moderate-image | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('verdict'),d.get('provider'),d.get('error',''))"; }
srv MODERATION_MOCK_SCORES='{"Porn":0.93}' MODERATION_ALLOW_MOCK=1
echo "mock porn 0.93     -> $(post public/test-icons/wide.png)"
echo "denylisted reupload-> $(post public/test-icons/wide.png)"
python3 -c "from PIL import Image;Image.open('public/test-icons/wide.png').resize((640,360)).convert('RGB').save('/tmp/wide2.jpg',quality=80)"
echo "denylist phash(jpg)-> $(post /tmp/wide2.jpg image/jpeg)"
srv MODERATION_MOCK_SCORES='{"Sexy":0.9}' MODERATION_ALLOW_MOCK=1
echo "mock sexy 0.90     -> $(post public/assets/tier2.png)"
srv MODERATION_MOCK_SCORES='{"Porn":0.4}' MODERATION_ALLOW_MOCK=1
echo "mock porn 0.40     -> $(post public/test-icons/transparent.png)"
srv X=1
echo "safe tier0         -> $(post public/assets/tier0.png)"
printf 'hello' > /tmp/x.txt; echo "text as png        -> $(post /tmp/x.txt image/png)"
head -c 2200000 /dev/urandom > /tmp/big.png; echo "2.2MB              -> $(post /tmp/big.png image/png)"
fuser -k $P/tcp >/dev/null 2>&1
