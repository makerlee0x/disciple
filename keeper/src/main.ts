#!/usr/bin/env node
// Disciple keeper. Usage:
//   node src/main.ts [--config keeper.config.json] [--once | --status | --collect | --health]
// --health reads the health file the running keeper writes each round (no keys, no RPC) and exits 1 if unhealthy.
// Env: ETH_RPC, RH_RPC (RPC URLs), KEEPER_ACCOUNT (cast keystore name, default "disciple"),
//      KEEPER_PASSWORD_FILE (or KEEPER_PASSWORD, else asked on the terminal),
//      ALERT_URL / HEARTBEAT_URL (optional, see src/alert.ts), KEEPER_NAME (label in alerts).
import { formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { alert, heartbeatFail } from "./alert.ts";
import { judgeHealth, readHealth } from "./health.ts";
import { loadConfig } from "./config.ts";
import { Keeper } from "./keeper.ts";
import { loadKey } from "./keystore.ts";
import { loadState } from "./state.ts";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string, d: string) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = {
  info: (m: string) => console.log(`${stamp()} ${m}`),
  warn: (m: string) => console.warn(`${stamp()} WARN ${m}`),
};

function health(path: string): number {
  // the health check needs no RPC: give every chain a placeholder so the config loads without the secrets
  const env = new Proxy(process.env, { get: (e, k: string) => e[k] ?? (k.endsWith("_RPC") ? "http://unused" : undefined) });
  const cfg = loadConfig(path, env);
  let h;
  try {
    h = readHealth(cfg.healthFile);
  } catch {
    console.log(`UNHEALTHY: no health file at ${cfg.healthFile} (keeper not running yet?)`);
    return 1;
  }
  const t = Math.floor(Date.now() / 1000);
  const { ok, problems } = judgeHealth(h, t, {
    stallSec: cfg.alerts.stallSec,
    staleHeadSec: cfg.alerts.staleHeadSec,
    minEth: formatEther(cfg.alerts.minEth),
    offLeaderSec: cfg.alerts.offLeaderSec,
  });
  console.log(ok ? "HEALTHY" : "UNHEALTHY");
  for (const p of problems) console.log(`  - ${p}`);
  console.log(`  wallet ${h.wallet}, up ${Math.round((t - h.startedAt) / 60)} min, last good round ${t - h.lastOkAt}s ago`);
  for (const [n, c] of Object.entries(h.chains)) console.log(`  ${n}: block ${c.head} (${t - c.headAt}s old), ${c.balanceEth} ETH, multicall ${h.multicall[n] ? "on" : "off"}`);
  for (const [id, p] of Object.entries(h.pools)) console.log(`  pool ${id.slice(0, 10)} (${p.entry}): ${p.gapBps} bps from its leader, read ${t - p.at}s ago`);
  for (const [k, d] of Object.entries(h.day)) console.log(`  24h ${k}: ${d.sent} sent, ${d.reverted} reverted, ${d.gasEth} ETH gas`);
  return ok ? 0 : 1;
}

async function main() {
  const cfgPath = opt("--config", process.env.KEEPER_CONFIG ?? "keeper.config.json");
  if (flag("--health")) process.exit(health(cfgPath));
  const cfg = loadConfig(cfgPath);
  if (cfg.routes.length === 0 && cfg.sameChain.length === 0) throw new Error("no routes or sameChain pools in the config");
  const account = privateKeyToAccount(await loadKey(cfg.account));
  const state = loadState(cfg.stateFile);
  const k = new Keeper(cfg, state, account, log);
  await k.checkChains();
  if (flag("--status")) {
    for (const l of await k.status()) console.log(l);
    return;
  }
  if (flag("--once")) {
    await k.tick();
    await k.sampleTick();
    return;
  }
  if (flag("--collect")) {
    for (const r of cfg.routes) await k.collectDue(r, true);
    return;
  }
  await alert("start", `started, wallet ${account.address}`, 0);
  let stop = false;
  process.on("SIGINT", () => {
    log.info("stopping after this tick");
    stop = true;
  });
  process.on("SIGTERM", () => (stop = true));
  // two loops: cross-chain pushes every pollSeconds, same-chain samples every sampling.everySec (sends on one
  // chain are serialised inside the keeper, so the loops never race for a nonce)
  // watchdog: a round that never finishes (a hung RPC call, say) would stop the keeper silently. Every round has a
  // time bound (RPC calls 30 s, receipts alerts.stuckTxSec), so no progress for alerts.stallSec means something hung:
  // exit, and systemd starts a fresh process.
  let progress = Date.now();
  if (cfg.alerts.stallSec > 0) {
    setInterval(async () => {
      const quiet = (Date.now() - progress) / 1000;
      if (quiet < cfg.alerts.stallSec) return;
      console.error(`${stamp()} FATAL no round finished for ${Math.round(quiet)}s, exiting so the service restarts`);
      await alert("stall", `no round finished for ${Math.round(quiet)}s; exiting so systemd restarts it`, 0);
      process.exit(2);
    }, 30_000).unref();
  }
  const loop = async (on: boolean, every: number, fn: () => Promise<void>) => {
    while (on && !stop) {
      const t0 = Date.now();
      await fn();
      progress = Date.now();
      const wait = every * 1000 - (Date.now() - t0);
      if (wait > 0 && !stop) await new Promise((r) => setTimeout(r, wait));
    }
  };
  await Promise.all([
    loop(cfg.routes.length > 0, cfg.pollSeconds, () => k.tick()),
    loop(cfg.sameChain.length > 0, cfg.sampling.everySec, () => k.sampleTick()),
  ]);
}

main().catch(async (e) => {
  const m = (e as Error).message?.split("\n")[0] ?? String(e);
  console.error(`${stamp()} FATAL ${m}`);
  await alert("fatal", `stopped: ${m}`, 0);
  await heartbeatFail(m);
  process.exit(1);
});
