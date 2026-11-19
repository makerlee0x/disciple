import "server-only";
/**
 * Relay wallet gas refill: the executor behind /api/cron/gas-refill. Planning rules live in lib/gasRefill (pure).
 *
 * One run:
 *  1. read ETH of the main relayer (RELAYER_PRIVATE_KEY) and of every pool wallet (RELAYER_KEY_POOL), and the main
 *     relayer's USDG (where the flat gasless fee and withdraw gas fees land)
 *  2. read the WETH/USDG v3 pool: tokens must be exactly USDG + the configured WETH, it must hold ≥ GAS_REFILL_MIN_POOL_ETH
 *     WETH, and its spot must sit inside the USD/ETH sanity band
 *  3. swap (planRefill) on the Universal Router: V3_SWAP_EXACT_IN to the router, then UNWRAP_WETH to the main relayer,
 *     both with amountOutMin = spot after fee − GAS_REFILL_SLIPPAGE_BPS. USDG reaches the router through Permit2 (a
 *     one-time USDG→Permit2 approve, then a per-run Permit2 allowance of exactly the swap amount for 10 minutes).
 *     Every tx is simulated first (eth_call) and nothing is sent on a revert.
 *  4. send ETH to each low pool wallet (planTopUps)
 *
 * Nonces: every tx is signed by the MAIN relayer through fastRelay.sendWithRelayerNonce (the same shared KV allocator the
 * relay paths and poke-pricer use). Pool wallets only receive ETH, so the pool's lease / per-instance cursors are never
 * touched. Run lock `gas-refill:lock` stops overlapping runs; daily caps in KV (`gas-refill:day:<utc day>:usdg|gwei`).
 * Alerts: console.error "[gas-refill] ALERT" (Vercel log alerts) + optional GAS_REFILL_ALERT_WEBHOOK (Discord / Slack style
 * JSON POST), each kind at most once per GAS_REFILL_ALERT_EVERY_MIN (default 360) via KV.
 */
import { createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, encodePacked, formatEther, formatUnits, http, maxUint256, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ACTIVE_CHAIN, deployment, ZERO } from "../chains";
import { dayKey, minOutWithSlippage, planRefill, planTopUps, refillConfig, spotWethOut, usdgPerEthAtSpot, type RefillConfig, type RelayWallet, type TopUp } from "../gasRefill";
import { kv } from "./kv";
import { relayerKey } from "./relayer";
import { poolKey, poolNames, uniquePoolNames } from "./relayerPool";

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const v3Pool = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);
const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const urAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
/** Universal Router commands + recipient constants (v1 and v2 agree). */
const V3_SWAP_EXACT_IN = 0x00, UNWRAP_WETH = 0x0c;
const MSG_SENDER = "0x0000000000000000000000000000000000000001" as Address;
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as Address;
const DAY_TTL = 3 * 86_400;
const GWEI = BigInt(1e9);
/** ETH kept back on the main relayer for the run's own sends (gas × fee headroom), over mainFloorWei. */
const GAS_RESERVE_WEI = BigInt(3e14);

export type RefillReport = {
  ok: boolean; dryRun: boolean; skipped?: string;
  wallets: { name: string; address: Address; eth: string }[];
  usdg?: string; usdPerEth?: string; pool?: Address;
  swap?: { usdgIn: string; minEthOut: string; txHash?: Hex; ethGot?: string };
  topUps: { name: string; address: Address; eth: string; txHash?: Hex; error?: string }[];
  alerts: string[]; error?: string;
};

type Deps = { now?: () => number; env?: NodeJS.ProcessEnv };

/** Every relay wallet: the main relayer first, then each resolvable pool key (one per address). Addresses only. */
export function relayWalletAddresses(env: NodeJS.ProcessEnv = process.env): { name: string; address: Address; main: boolean }[] {
  const main = privateKeyToAccount(relayerKey(env)).address;
  const out = [{ name: "RELAYER_PRIVATE_KEY", address: main, main: true }];
  for (const n of uniquePoolNames(env, poolNames(env))) {
    const k = poolKey(env, n);
    if (!k) continue;
    const a = privateKeyToAccount(k).address;
    if (a.toLowerCase() !== main.toLowerCase()) out.push({ name: n, address: a, main: false });
  }
  return out;
}

async function alert(kinds: string[], cfgEnv: NodeJS.ProcessEnv): Promise<void> {
  if (!kinds.length) return;
  const every = Math.max(1, Number(cfgEnv.GAS_REFILL_ALERT_EVERY_MIN) || 360) * 60;
  const hook = cfgEnv.GAS_REFILL_ALERT_WEBHOOK;
  for (const msg of kinds) {
    const kind = msg.split(":")[0];
    const fresh = await kv().setNX(`gas-refill:alert:${kind}`, "1", every).catch(() => true);
    if (!fresh) continue;
    console.error(`[gas-refill] ALERT ${msg}`);
    if (hook && /^https:\/\//.test(hook)) {
      const text = `DISCIPLE gas refill (${ACTIVE_CHAIN.id}): ${msg}`;
      await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text, text }), signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    }
  }
}

export async function runGasRefill(deps: Deps = {}): Promise<RefillReport> {
  const env = deps.env ?? process.env, now = deps.now ?? Date.now;
  const d = deployment();
  const cfg: RefillConfig = refillConfig(env, ACTIVE_CHAIN.id, d.usdgDecimals);
  const report: RefillReport = { ok: true, dryRun: cfg.dryRun, wallets: [], topUps: [], alerts: [] };
  if (!cfg.enabled) return { ...report, skipped: "disabled (GAS_REFILL_ENABLED != 1)" };

  const store = kv();
  const lockId = globalThis.crypto.randomUUID();
  if (!(await store.setNX("gas-refill:lock", lockId, 240))) return { ...report, skipped: "locked" };
  try {
    const key = relayerKey(env);
    const account = privateKeyToAccount(key);
    const pc = createPublicClient({ chain: ACTIVE_CHAIN, transport: http() });
    const wc = createWalletClient({ chain: ACTIVE_CHAIN, transport: http(undefined, { retryCount: 0 }), account });   // never resend a signed tx at the transport
    const { sendWithRelayerNonce } = await import("./fastRelay");
    const send = async (to: Address, data: Hex | undefined, value: bigint) => {
      const gas = await pc.estimateGas({ account: account.address, to, data, value });   // also the simulation: a revert throws here
      const hash = await sendWithRelayerNonce((nonce) => wc.sendTransaction({ to, data, value, gas: (gas * BigInt(13)) / BigInt(10), nonce }));
      const rc = await pc.waitForTransactionReceipt({ hash, timeout: 30_000 });
      if (rc.status !== "success") throw Object.assign(new Error(`reverted ${hash}`), { txHash: hash });
      return hash;
    };

    const list = relayWalletAddresses(env);
    const balOf = async () => Promise.all(list.map(async (w) => ({ ...w, balance: await pc.getBalance({ address: w.address }) }))) as Promise<RelayWallet[]>;
    let wallets = await balOf();
    report.wallets = wallets.map((w) => ({ name: w.name, address: w.address, eth: formatEther(w.balance) }));
    const usdgBal = await pc.readContract({ address: d.usdg, abi: erc20, functionName: "balanceOf", args: [account.address] });
    report.usdg = formatUnits(usdgBal, d.usdgDecimals);
    const day = dayKey(now());
    const dayUsdgKey = `gas-refill:day:${day}:usdg`, dayGweiKey = `gas-refill:day:${day}:gwei`;
    const [du, dg] = await store.mget([dayUsdgKey, dayGweiKey]);
    const dayUsdgUsed = BigInt(Number(du) || 0), dayWeiUsed = BigInt(Number(dg) || 0) * GWEI;

    // pool: tokens, depth, spot
    let usdgPerEth = BigInt(0), poolOk = false, usdgIsToken0 = false, fee = 0, sqrtP = BigInt(0);
    if (cfg.pool && cfg.weth) {
      report.pool = cfg.pool;
      try {
        const [t0, t1, f, s0, poolWeth] = await Promise.all([
          pc.readContract({ address: cfg.pool, abi: v3Pool, functionName: "token0" }),
          pc.readContract({ address: cfg.pool, abi: v3Pool, functionName: "token1" }),
          pc.readContract({ address: cfg.pool, abi: v3Pool, functionName: "fee" }),
          pc.readContract({ address: cfg.pool, abi: v3Pool, functionName: "slot0" }),
          pc.readContract({ address: cfg.weth, abi: erc20, functionName: "balanceOf", args: [cfg.pool] }),
        ]);
        const u = d.usdg.toLowerCase(), w = cfg.weth.toLowerCase();
        const pair = [t0.toLowerCase(), t1.toLowerCase()];
        usdgIsToken0 = pair[0] === u; fee = Number(f); sqrtP = s0[0];
        usdgPerEth = usdgPerEthAtSpot(sqrtP, usdgIsToken0);
        const usd = Number(formatUnits(usdgPerEth, d.usdgDecimals));
        report.usdPerEth = usd.toFixed(2);
        if (!(pair.includes(u) && pair.includes(w))) report.alerts.push(`bad_pool: ${cfg.pool} is not USDG/WETH`);
        else if (poolWeth < cfg.minPoolWei) report.alerts.push(`thin_pool: pool holds ${formatEther(poolWeth)} WETH (< GAS_REFILL_MIN_POOL_ETH)`);
        else if (usd < cfg.minUsdPerEth || usd > cfg.maxUsdPerEth) report.alerts.push(`bad_price: spot ${usd.toFixed(2)} USD/ETH outside the sanity band`);
        else poolOk = true;
      } catch (e) { report.alerts.push(`pool_read: ${(e as Error).message.split("\n")[0].slice(0, 160)}`); }
    } else report.alerts.push("no_pool: set GAS_REFILL_POOL and GAS_REFILL_WETH for this chain");

    const plan = planRefill({ wallets, usdgBalance: usdgBal, usdgPerEth: poolOk ? usdgPerEth : BigInt(0), dayUsdgUsed, cfg });
    report.alerts.push(...plan.alerts);
    const router = cfg.router ?? (d.universalRouter !== ZERO ? d.universalRouter : undefined);

    // 3) swap
    if (plan.swapUsdg > BigInt(0) && poolOk && router) {
      const minOut = minOutWithSlippage(spotWethOut(plan.swapUsdg, sqrtP, usdgIsToken0, fee), cfg.slippageBps);
      report.swap = { usdgIn: formatUnits(plan.swapUsdg, d.usdgDecimals), minEthOut: formatEther(minOut) };
      if (!cfg.dryRun) {
        // reserve the day cap before sending (refunded below if nothing was sent)
        const used = await store.incrByEx(dayUsdgKey, Number(plan.swapUsdg), DAY_TTL);
        if (BigInt(used) > cfg.maxDayUsdg) { await store.incrByEx(dayUsdgKey, -Number(plan.swapUsdg), DAY_TTL); report.alerts.push("day_cap: another run used the day cap"); }
        else {
          let swapped = false;
          try {
            const permit2 = d.permit2;
            const a = await pc.readContract({ address: d.usdg, abi: erc20, functionName: "allowance", args: [account.address, permit2] });
            if (a < plan.swapUsdg) await send(d.usdg, encodeFunctionData({ abi: erc20, functionName: "approve", args: [permit2, maxUint256] }), BigInt(0));
            const nowSec = Math.floor(now() / 1000);
            const [amt, exp] = await pc.readContract({ address: permit2, abi: permit2Abi, functionName: "allowance", args: [account.address, d.usdg, router] });
            if (amt < plan.swapUsdg || Number(exp) < nowSec + 120) {
              await send(permit2, encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [d.usdg, router, plan.swapUsdg, nowSec + 600] }), BigInt(0));
            }
            const path = encodePacked(["address", "uint24", "address"], [d.usdg, fee, cfg.weth!]);
            const inputs = [
              encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }], [ADDRESS_THIS, plan.swapUsdg, minOut, path, true]),
              encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [MSG_SENDER, minOut]),
            ];
            const commands = encodePacked(["uint8", "uint8"], [V3_SWAP_EXACT_IN, UNWRAP_WETH]);
            const before = await pc.getBalance({ address: account.address });
            const hash = await send(router, encodeFunctionData({ abi: urAbi, functionName: "execute", args: [commands, inputs, BigInt(Math.floor(now() / 1000) + 300)] }), BigInt(0));
            swapped = true;
            const after = await pc.getBalance({ address: account.address });
            report.swap.txHash = hash; report.swap.ethGot = formatEther(after - before);
          } catch (e) {
            report.ok = false;
            report.alerts.push(`swap_failed: ${String((e as { shortMessage?: string }).shortMessage || (e as Error).message).split("\n")[0].slice(0, 200)}`);
          } finally {
            if (!swapped) await store.incrByEx(dayUsdgKey, -Number(plan.swapUsdg), DAY_TTL).catch(() => undefined);
          }
        }
      }
    } else if (plan.swapUsdg > BigInt(0) && !router) report.alerts.push("no_router: set GAS_REFILL_ROUTER");

    // 4) top up pool wallets from the main relayer
    if (!cfg.dryRun) wallets = await balOf();
    const main = wallets.find((w) => w.main)!;
    const tp = planTopUps({ wallets, mainBalance: main.balance, gasReserveWei: GAS_RESERVE_WEI, dayWeiUsed, cfg });
    report.alerts.push(...tp.alerts);
    for (const t of tp.sends as TopUp[]) {
      const row: RefillReport["topUps"][number] = { name: t.name, address: t.address, eth: formatEther(t.wei) };
      report.topUps.push(row);
      if (cfg.dryRun) continue;
      try {
        row.txHash = await send(t.address, undefined, t.wei);
        await store.incrByEx(dayGweiKey, Number(t.wei / GWEI), DAY_TTL).catch(() => undefined);
      } catch (e) { report.ok = false; row.error = String((e as Error).message).split("\n")[0].slice(0, 160); report.alerts.push(`topup_failed: ${t.name}`); }
    }

    // 5) after the run: anything still under min, or the main relayer too low to pay its own gas
    if (!cfg.dryRun) {
      const end = await balOf();
      report.wallets = end.map((w) => ({ name: w.name, address: w.address, eth: formatEther(w.balance) }));
      const still = end.filter((w) => w.balance < cfg.minWei).map((w) => w.name);
      if (still.length) report.alerts.push(`still_low: ${still.join(", ")} below GAS_REFILL_MIN_ETH after the run`);
      if (end.find((w) => w.main)!.balance < GAS_RESERVE_WEI) report.alerts.push("main_out_of_eth: main relayer can't pay for the swap; send it ETH by hand");
    }
    report.alerts = Array.from(new Set(report.alerts));
    await alert(report.alerts, env);
    return report;
  } catch (e) {
    const msg = String((e as Error).message).split("\n")[0].slice(0, 200);
    await alert([`run_error: ${msg}`], env).catch(() => undefined);
    return { ...report, ok: false, error: msg };
  } finally {
    await store.delIfEq("gas-refill:lock", lockId).catch(() => undefined);
  }
}
