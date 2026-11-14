#!/usr/bin/env node
// Disciple keeper. Usage:
//   node src/main.ts [--config keeper.config.json] [--once | --status | --collect]
// Env: ETH_RPC, RH_RPC (RPC URLs), KEEPER_ACCOUNT (cast keystore name, default "disciple"),
//      KEEPER_PASSWORD_FILE (or KEEPER_PASSWORD, else asked on the terminal),
//      ALERT_URL / HEARTBEAT_URL (optional, see src/alert.ts), KEEPER_NAME (label in alerts).
import { privateKeyToAccount } from "viem/accounts";
import { alert } from "./alert.ts";
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

async function main() {
  const cfg = loadConfig(opt("--config", process.env.KEEPER_CONFIG ?? "keeper.config.json"));
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
  const loop = async (on: boolean, every: number, fn: () => Promise<void>) => {
    while (on && !stop) {
      const t0 = Date.now();
      await fn();
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
  process.exit(1);
});
