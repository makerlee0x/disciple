# Run the Carry keeper on AWS

One small always-on EC2 instance. It runs the keeper as a systemd service that restarts on any crash and on reboot.
The keeper wallet's keystore and password are kept in SSM Parameter Store, encrypted, and only this instance's role can read
them. At start they are copied into a private in-memory folder (`/run/carry-keeper`) and are never written to disk. The
instance has no open ports: you get a shell through Session Manager in the browser, so there's no SSH key to manage.

Cost: about $7.40 a month in us-east-1:

| Item | Monthly |
|---|---|
| t4g.nano (2 vCPU burst, 0.5 GB RAM, Arm) | ~$3.07 |
| 8 GB gp3 disk | ~$0.64 |
| Public IPv4 address | ~$3.65 |
| Parameter Store (standard), Session Manager | free |

The public IPv4 address can't be avoided cheaply. An IPv6-only instance would need github.com (no IPv6 at all), the
Robinhood RPC and the AWS endpoints to all answer over IPv6, and a NAT gateway instead costs ~$33 a month. The keeper itself
uses ~130 MB of RAM. There is no swap on purpose: the secrets live only in memory, and swap could write them to the
disk. The installer refuses to run if swap is on, and the service also sets `MemorySwapMax=0`.

You can only run **one keeper per wallet** at a time. Two keepers on the same wallet send clashing nonces, so stop the Mac
keeper before you start this one (step 6).

## 1. Put the secrets in Parameter Store

Pick one region and use it for everything below (for example `us-east-1`). Then go to **AWS Systems Manager → Parameter
Store → Create parameter**. Create each parameter with **Tier: Standard**, **Type: SecureString**, and **KMS key: alias/aws/ssm**
(the default).

| Name | Value |
|---|---|
| `/carry-keeper/keystore` | The keeper keystore file. On the Mac, `cat ~/.foundry/keystores/carry-keeper \| pbcopy` copies it, then paste. |
| `/carry-keeper/password` | That keystore's password |
| `/carry-keeper/rpc` | The Robinhood RPC URL the Mac keeper uses (your `RH_RPC`) |
| `/carry-keeper/alert-url` | Optional. Where alerts go. The easiest is `https://ntfy.sh/<long-random-name>`: install the ntfy app and subscribe to that name. A Discord or Slack webhook URL works too. |
| `/carry-keeper/heartbeat-url` | Optional. A healthchecks.io ping URL (free). It emails or texts you when the pings **stop**, which also covers the server going down. Set its period to 5 minutes and its grace to 10 minutes. |

## 2. Create the instance role

Go to **IAM → Roles → Create role**, choose **AWS service → EC2**, and then:
- Attach the AWS policy **AmazonSSMManagedInstanceCore**. This is what lets you open a browser shell.
- Name the role `carry-keeper` and create it.
- Open the role, then go to **Add permissions → Create inline policy → JSON**. Paste [`iam-policy.json`](iam-policy.json), and name it
  `carry-keeper-secrets`. It allows reading `/carry-keeper/*` and nothing else.

## 3. Launch the instance

Go to **EC2 → Launch instance**:
- **Name**: `carry-keeper`
- **AMI**: Amazon Linux 2023, **64-bit (Arm)**
- **Instance type**: `t4g.nano`
- **Key pair**: Proceed without a key pair
- **Network settings → Edit**: Leave **Auto-assign public IP** on (outbound needs it). Create a security group, and **untick
  "Allow SSH traffic"**, so there are no inbound rules. Outbound stays open (the instance needs it to reach the RPC).
- **Storage**: 8 GiB gp3 (the default; the install uses about 2.5 GB)
- **Advanced details → IAM instance profile**: `carry-keeper`
- **Advanced details → Termination protection**: Enable

Then click Launch.

## 4. Open a shell and install

Wait about 2 minutes after the launch. Then go to **EC2 → Instances → carry-keeper → Connect → Session Manager → Connect** and paste:

```
curl -fsSL https://raw.githubusercontent.com/makerlee0x/disciple/follower/keeper/deploy/aws/setup.sh | sudo bash
```

This installs Node 22 (checksum-verified), clones the keeper from the `follower` branch into `/opt/carry-keeper`, puts the
config at `/etc/carry-keeper/carry-keeper.json`, and installs the service. It doesn't start the keeper yet.

## 5. Check the role can read the secrets

The installer prints this command at the end, with your region filled in:

```
sudo -u keeper aws ssm get-parameter --region <your-region> --name /carry-keeper/rpc --with-decryption --query Parameter.Name --output text
```

This should print `/carry-keeper/rpc`. If it says AccessDenied, step 2's inline policy is missing.

## 6. Switch over from the Mac

On the Mac, stop the keeper (Ctrl-C in its terminal) and wait for it to print `stopping after this tick` and exit. Then, in the
AWS shell:

```
sudo systemctl enable --now carry-keeper
```

```
journalctl -u carry-keeper -f
```

You should see `robinhood: keeper 0xc259…D136 balance … ETH`, then `carry: sampling pool 0x170b…`, and samples and matches as usual.
If you set `alert-url`, you'll also get a "started" alert. Press Ctrl-C to stop following the log (the keeper keeps running).

## Day to day

| What | Command (in the Session Manager shell) |
|---|---|
| Follow the log | `journalctl -u carry-keeper -f` |
| Last hour of log | `journalctl -u carry-keeper --since -1h` |
| Is it running | `systemctl status carry-keeper` |
| Update to the latest `follower` | `sudo carry-keeper-update` |
| Restart | `sudo systemctl restart carry-keeper` |
| Stop (for example to run it on the Mac again) | `sudo systemctl stop carry-keeper` |
| Edit the config (pools, sampling) | `sudo nano /etc/carry-keeper/carry-keeper.json`, then restart |
| Change a secret | Edit it in Parameter Store, then restart |

## Alerts

These go to `alert-url`:
- **Low gas**: the keeper wallet has less than `alerts.minEth` ETH (default 0.003, about a month at the current rate). At most once every 6 hours.
- **Failing**: 10 rounds in a row failed (RPC down, for example), and again when it recovers.
- **Started** and **stopped (fatal error)**. systemd restarts it 20 seconds after any crash.

The heartbeat (`heartbeat-url`) is the alert for when the box itself is gone, since nothing on the box can report that.

## Adding a market

Carry's per-market hooks each get their own `sameChain` entry (same `stockQueue`, that market's hook and pool). The keeper
then matches each market's queue from the entry that lists its pool. Keep `"scanPools": false` and list each pool id
under `pools`. Scanning from the deploy block at 10 blocks per call is slower than the chain makes blocks.
