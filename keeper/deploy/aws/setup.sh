#!/usr/bin/env bash
# One-time setup on a fresh Amazon Linux 2023 instance (arm64 or x86_64). Run as root:
#   curl -fsSL https://raw.githubusercontent.com/makerlee0x/disciple/follower/keeper/deploy/aws/setup.sh | sudo bash
# Installs Node 22 (checksum-verified), the keeper from the disciple `follower` branch, and the systemd service.
# It does NOT start the keeper: stop the one on the Mac first (same wallet), then `sudo systemctl enable --now carry-keeper`.
set -euo pipefail
BRANCH="${BRANCH:-follower}"
REGION="$(TOKEN=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60') && curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)"

dnf install -y -q git tar xz >/dev/null

# No swap: the keystore, its password and the decrypted key live in memory (/run tmpfs and the node process), and
# swap would let memory pressure write them to the root volume. The keeper uses ~130 MB of the nano's 0.5 GB.
if swapon --show --noheadings | grep -q .; then echo "swap is on: turn it off (swapoff -a, remove it from /etc/fstab) before running the keeper"; exit 1; fi

# Node 22 from nodejs.org, newest 22.x, checked against its SHASUMS256
case "$(uname -m)" in aarch64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) echo "unsupported $(uname -m)"; exit 1 ;; esac
cd /tmp
curl -fsSLO https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
TGZ="$(grep -o "node-v22[.0-9]*-linux-$ARCH.tar.xz" SHASUMS256.txt | head -1)"
curl -fsSLO "https://nodejs.org/dist/latest-v22.x/$TGZ"
grep " $TGZ\$" SHASUMS256.txt | sha256sum -c -
rm -rf /opt/node && mkdir -p /opt/node && tar -xJf "$TGZ" -C /opt/node --strip-components=1
rm -f "$TGZ" SHASUMS256.txt
/opt/node/bin/node --version

id keeper >/dev/null 2>&1 || useradd --system --home-dir /var/lib/carry-keeper --shell /sbin/nologin keeper

if [ -d /opt/carry-keeper/.git ]; then
  git -C /opt/carry-keeper fetch -q origin "$BRANCH" && git -C /opt/carry-keeper checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" --single-branch https://github.com/makerlee0x/disciple.git /opt/carry-keeper
fi
cd /opt/carry-keeper/keeper
PATH=/opt/node/bin:$PATH npm ci --omit=dev --no-audit --no-fund
chown -R root:root /opt/carry-keeper

mkdir -p /etc/carry-keeper
[ -f /etc/carry-keeper/carry-keeper.json ] || cp deploy/aws/carry-keeper.json /etc/carry-keeper/carry-keeper.json
sed "s/__REGION__/$REGION/" deploy/aws/carry-keeper.service > /etc/systemd/system/carry-keeper.service

# keep logs across reboots, at most 300 MB
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=persistent\nSystemMaxUse=300M\n' > /etc/systemd/journald.conf.d/carry-keeper.conf
systemctl restart systemd-journald
systemctl daemon-reload

# an update command: pulls the branch, reinstalls, restarts
cat > /usr/local/bin/carry-keeper-update <<UPD
#!/usr/bin/env bash
set -euo pipefail
git -C /opt/carry-keeper fetch -q origin $BRANCH
git -C /opt/carry-keeper checkout -q -B $BRANCH origin/$BRANCH
cd /opt/carry-keeper/keeper && PATH=/opt/node/bin:\$PATH npm ci --omit=dev --no-audit --no-fund
systemctl restart carry-keeper
git -C /opt/carry-keeper log --oneline -1
UPD
chmod +x /usr/local/bin/carry-keeper-update

echo
echo "Installed. Check the secrets can be read:  sudo -u keeper aws ssm get-parameter --region $REGION --name /carry-keeper/rpc --with-decryption --query Parameter.Name"
echo "Then stop the Mac keeper and start this one:  sudo systemctl enable --now carry-keeper"
echo "Logs:  journalctl -u carry-keeper -f"
