# Run the Carry keeper on AWS

This is the runbook for moving the keeper off the Mac onto one small always-on EC2 instance. The keeper runs as a
systemd service that restarts after any crash and after a reboot. The keeper wallet's keystore and password live in SSM
Parameter Store, encrypted, and only this instance's role can read them. At start they are copied into a private
in-memory folder (`/run/carry-keeper`) and never touch the disk. The instance has no open ports. You get a shell through
Session Manager in the browser, so there is no SSH key to manage.

Every step here is done by you, in the AWS console or the Session Manager shell. Nothing in this repository holds a key,
a password or an RPC URL, and nothing should ever be committed that does.

## 0. Before you start

- **The code must be on the branch you install from.** The installer clones `follower`. Until the keeper PRs are
  merged into `follower`, install from the PR branch instead (step 4 shows how).
- **One keeper per wallet.** Two keepers on the same wallet send clashing nonces. You stop the Mac keeper in step 7,
  right before you start this one.
- **The keeper wallet only pays gas.** It holds no user funds and has no admin role, so the most anyone could take from
  this box is its gas ETH (about 0.01). Keep it that way: never put the deployer, Safe signer or a funded wallet's key here.
- **Region.** Pick one AWS region and use it for everything below (for example `us-east-1`).

Cost: about $7.40 a month in us-east-1.

| Item | Monthly |
|---|---|
| t4g.nano (2 vCPU burst, 0.5 GB RAM, Arm) | ~$3.07 |
| 8 GB gp3 disk | ~$0.64 |
| Public IPv4 address | ~$3.65 |
| Parameter Store (standard), Session Manager | free |

The public IPv4 address can't be avoided cheaply. github.com has no IPv6, and a NAT gateway costs ~$33 a month. The
keeper uses ~130 MB of RAM. There is no swap on purpose, because swap could write the secrets in memory to disk. The
installer refuses to run if swap is on, and the service also sets `MemorySwapMax=0`.

## 1. Put the secrets in Parameter Store

Go to **AWS Systems Manager → Parameter Store → Create parameter**. Create each one with **Tier: Standard**, **Type:
SecureString** and **KMS key: alias/aws/ssm** (the default).

| Name | Value |
|---|---|
| `/carry-keeper/keystore` | The keeper keystore file. On the Mac, `cat ~/.foundry/keystores/carry-keeper \| pbcopy` copies it, then paste. |
| `/carry-keeper/password` | That keystore's password |
| `/carry-keeper/rpc` | The Robinhood RPC URL (your `RH_RPC`). Use a fresh Alchemy key here if the old one was ever pasted anywhere. |
| `/carry-keeper/alert-url` | Optional but recommended. Where alerts go, see step 6. |
| `/carry-keeper/heartbeat-url` | Optional but recommended. A healthchecks.io ping URL, see step 6. |

After pasting, clear the clipboard on the Mac (copy any other text). Don't save the keystore or password anywhere else
on the way, such as a notes app, a chat or a file in this repo.

## 2. Create the instance role

Go to **IAM → Roles → Create role**, choose **AWS service → EC2**, and then:
- Attach the AWS policy **AmazonSSMManagedInstanceCore**. This is what lets you open a browser shell.
- Name the role `carry-keeper` and create it.
- Open the role, then **Add permissions → Create inline policy → JSON**. Paste [`iam-policy.json`](iam-policy.json) and
  name it `carry-keeper-secrets`. It allows reading `/carry-keeper/*` and nothing else.

## 3. Launch the instance

Go to **EC2 → Launch instance**:
- **Name**: `carry-keeper`
- **AMI**: Amazon Linux 2023, **64-bit (Arm)**
- **Instance type**: `t4g.nano`
- **Key pair**: Proceed without a key pair
- **Network settings → Edit**: leave **Auto-assign public IP** on (outbound needs it). Create a security group and
  **untick "Allow SSH traffic"**, so there are no inbound rules. Outbound stays open.
- **Storage**: 8 GiB gp3 (the default; the install uses about 2.5 GB)
- **Advanced details → IAM instance profile**: `carry-keeper`
- **Advanced details → Metadata version**: V2 only
- **Advanced details → Termination protection**: Enable

Then click Launch.

## 4. Open a shell and install

Wait about 2 minutes. Then go to **EC2 → Instances → carry-keeper → Connect → Session Manager → Connect** and paste:

```
curl -fsSL https://raw.githubusercontent.com/makerlee0x/disciple/follower/keeper/deploy/aws/setup.sh | sudo bash
```

If the keeper PRs aren't merged into `follower` yet, use the PR branch in both places instead:

```
B=claude/project-thread-rs12y3; curl -fsSL https://raw.githubusercontent.com/makerlee0x/disciple/$B/keeper/deploy/aws/setup.sh | sudo BRANCH=$B bash
```

This installs Node 22 (checksum-verified), clones the keeper into `/opt/carry-keeper`, puts the config at
`/etc/carry-keeper/carry-keeper.json` (v0.3 hook, stock queue and MSTR pool), and installs the service plus two
commands, `carry-keeper-update` and `carry-keeper-health`. It doesn't start the keeper.

## 5. Check the role can read the secrets

The installer prints this at the end, with your region filled in:

```
sudo -u keeper aws ssm get-parameter --region <your-region> --name /carry-keeper/rpc --with-decryption --query Parameter.Name --output text
```

It should print `/carry-keeper/rpc`. If it says AccessDenied, step 2's inline policy is missing.

## 6. Set up alerts

Two different things, and you want both:

- **Alerts (`alert-url`)** come from the keeper when it sees a problem. The easiest is ntfy: install the ntfy phone app,
  subscribe to a long random topic name, and store `https://ntfy.sh/<that-name>` as `/carry-keeper/alert-url`. A
  Discord or Slack webhook URL works too. Anyone who knows the topic name can read it, so make it long and random.
- **Heartbeat (`heartbeat-url`)** catches what the keeper can't report: the box is gone, out of memory, or the keeper
  keeps crashing. Make a free check at healthchecks.io with **period 5 minutes, grace 10 minutes**, connect it to email
  or your phone, and store its ping URL as `/carry-keeper/heartbeat-url`. The keeper pings it once a minute while rounds
  work, and pings `/fail` when it stops on an error.

To test the alert URL before going live, run this in the AWS shell (it sends one message and nothing else):

```
curl -d "carry keeper test alert" "$(sudo -u keeper aws ssm get-parameter --with-decryption --name /carry-keeper/alert-url --query Parameter.Value --output text)"
```

## 7. Switch over from the Mac

On the Mac, stop the keeper (Ctrl-C in its terminal) and wait for it to print `stopping after this tick` and exit. Then,
in the AWS shell:

```
sudo systemctl enable --now carry-keeper
```

```
journalctl -u carry-keeper -f
```

You should see `robinhood: keeper 0xc259…D136 balance … ETH`, `robinhood: multicall on (0xcA11…CA11)`, then
`carry-v03: sampling pool 0xdf91…19fa`, and samples, matches and payouts as usual. You'll also get a "started" alert.
Press Ctrl-C to stop following the log (the keeper keeps running).

## 8. Check it's healthy

A minute after the start:

```
sudo carry-keeper-health
```

It prints `HEALTHY` or `UNHEALTHY` with the reasons, then the RPC block, wallet balance, each pool's gap to its leader
and the last 24 h of transactions. It reads a small file the keeper writes each round, so it needs no keys and works
even while the keeper is stopped (it will then say the last good round was long ago).

## Day to day

| What | Command (in the Session Manager shell) |
|---|---|
| Is it healthy | `sudo carry-keeper-health` |
| Follow the log | `journalctl -u carry-keeper -f` |
| Last hour of log | `journalctl -u carry-keeper --since -1h` |
| Is it running | `systemctl status carry-keeper` |
| Update to the latest code | `sudo carry-keeper-update` |
| Restart | `sudo systemctl restart carry-keeper` |
| Stop (for example to run it on the Mac again) | `sudo systemctl stop carry-keeper` |
| Edit the config (pools, sampling) | `sudo nano /etc/carry-keeper/carry-keeper.json`, then restart |
| Change a secret | Edit it in Parameter Store, then restart |

## What alerts you'll get

| Alert | When | What to do |
|---|---|---|
| Low gas | wallet below `alerts.minEth` (0.003 ETH, about a month), at most every 6 h | Send ETH on Robinhood Chain to the keeper wallet |
| Rounds failing | 10 rounds in a row failed, and again when it recovers | Usually the RPC. Check the log; change `/carry-keeper/rpc` if the provider is down |
| RPC head stale | counts as a failed round when the RPC's latest block is over 5 min old | Same as above |
| Stuck transaction | a transaction has no receipt after 3 min | Usually clears itself. If it repeats, the gas cap (`maxFeeGwei`) may be too low |
| Pool off its leader | the pool's centre stayed 1% or more from the leader for 30 min | Look at the log for reverted or skipped samples |
| Layout changed | the hook's storage stopped matching its own view | Hourly payout is paused; the keeper needs an update for that hook |
| Stall | no round finished for 15 min | Nothing: the keeper exits and systemd restarts it 20 s later |
| Started / stopped | start, and a fatal error (systemd restarts it 20 s later) | Only act if it keeps repeating |
| Daily summary | once a day | Transactions by kind, gas spent, balance and pool gaps. Nothing to do |

The heartbeat (healthchecks.io) is what tells you the box itself is down.

## Keys and secrets

- The keystore, password, RPC URL and alert URLs live only in Parameter Store. On the box they exist in `/run/carry-keeper`
  (memory only, readable only by the `keeper` user, deleted when the service stops) and in the keeper's own memory. The
  keeper never logs them.
- **Rotating the keeper wallet:** make a new keystore on the Mac (`cast wallet new` then `cast wallet import`), fund it
  with a little ETH, put the new keystore and password into the two parameters, and `sudo systemctl restart carry-keeper`.
  Then move the leftover ETH out of the old wallet. The keeper has no role on the contracts, so nothing on chain changes.
- **Rotating the RPC key:** create a new key at the provider, update `/carry-keeper/rpc`, restart, then delete the old key.
- **If the instance might be compromised:** stop it in the EC2 console, rotate the keeper wallet and the RPC key as
  above, and launch a fresh instance. The most at risk is the keeper wallet's gas ETH.
- Never paste a key into the config file, the repo, a GitHub issue, or a chat.

## Updating and rolling back

`sudo carry-keeper-update` pulls the branch it was installed from, reinstalls and restarts, then prints the commit it's
on. To go back to an earlier commit:

```
sudo git -C /opt/carry-keeper checkout <commit> && sudo systemctl restart carry-keeper
```

The next `carry-keeper-update` moves it forward again. To move an install from the PR branch to `follower` once the PRs
are merged, run the `follower` install command from step 4 again. It keeps your config.

## Adding a market

Carry's per-market hooks each get their own `sameChain` entry (same `stockQueue`, that market's hook and pool). The
keeper then matches each market's queue from the entry that lists its pool. Keep `"scanPools": false` and list each
pool id under `pools`. Scanning from the deploy block at 10 blocks per call is slower than the chain makes blocks.

## Going back to the Mac

`sudo systemctl disable --now carry-keeper` in the AWS shell, wait for it to stop, then start the keeper on the Mac as
before. To shut AWS down for good, also stop or terminate the instance (turn off termination protection first) and
delete the `/carry-keeper/*` parameters.
