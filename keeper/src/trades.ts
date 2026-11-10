#!/usr/bin/env node
// Trade watcher for one Disciple pool. Read-only: no key, sends nothing.
//   RH_RPC=https://... node src/trades.ts [--every 15] [--out trades.csv] [--hook 0x..] [--pool 0x..] [--no-notify]
//   RH_RPC=https://... node src/trades.ts --summary      totals: trades, volume, fees, fee APY
// Every `--every` seconds it reads the pool's reserves (one cheap call). Only when they changed does it scan the
// blocks since the last check for HookSwap / HookModifyLiquidity events, so it stays inside a free RPC plan.
// Each trade: a console line, a CSV row, running totals, and (on macOS) a desktop notification. A new CSV is first
// backfilled with the pool's trades from before the watcher existed (from their tx hashes).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createPublicClient, decodeEventLog, http, parseAbi, type Hex, type Log } from "viem";
import { hookAbi } from "./abi.ts";

export const tradeAbi = parseAbi([
  "event HookSwap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint128 hookLPfeeAmount0, uint128 hookLPfeeAmount1)",
  "event HookModifyLiquidity(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1)",
]);

export type Trade = {
  kind: "BUY" | "SELL" | "DEPOSIT" | "WITHDRAW";
  coin: bigint; // STRATEGY raw (currency0), absolute
  quote: bigint; // USDG raw (currency1), absolute
  feeQuote: number; // LP fee in USDG (sells valued at the trade price)
};

/** Pool view: amounts + = into the pool. Coin (currency0, 18 dec) / quote (currency1, 6 dec). */
export function decodeTrade(log: { data: Hex; topics: [Hex, ...Hex[]] }): Trade {
  const ev = decodeEventLog({ abi: tradeAbi, data: log.data, topics: log.topics });
  const a0 = ev.args.amount0;
  const a1 = ev.args.amount1;
  const abs = (v: bigint) => (v < 0n ? -v : v);
  if (ev.eventName === "HookModifyLiquidity") {
    return { kind: a0 + a1 >= 0n ? "DEPOSIT" : "WITHDRAW", coin: abs(a0), quote: abs(a1), feeQuote: 0 };
  }
  const buy = a1 > 0n; // USDG in -> STRATEGY out
  const coin = abs(a0);
  const quote = abs(a1);
  const f0 = Number(ev.args.hookLPfeeAmount0);
  const f1 = Number(ev.args.hookLPfeeAmount1);
  const price = coin === 0n ? 0 : Number(quote) / 1e6 / (Number(coin) / 1e18);
  return { kind: buy ? "BUY" : "SELL", coin, quote, feeQuote: f1 / 1e6 + (f0 / 1e18) * price };
}

export type Row = { time: string; kind: string; usdg: number; fee: number; price: number };

export function readRows(csv: string): Row[] {
  return csv
    .trim()
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const c = l.split(",");
      return { time: c[0], kind: c[3], usdg: Number(c[5]), price: Number(c[6]), fee: Number(c[7]) };
    });
}

/** Totals, fee APY and turnover. APY = fees / pool value now, annualised since launch (simple, no compounding). */
export function summarise(rows: Row[], poolUsd: number, nowMs: number, launchMs: number): string[] {
  const trades = rows.filter((r) => r.kind === "BUY" || r.kind === "SELL");
  const sum = (rs: Row[], k: "usdg" | "fee") => rs.reduce((a, r) => a + r[k], 0);
  const days = (nowMs - launchMs) / 86_400_000;
  const fees = sum(trades, "fee");
  const apy = poolUsd > 0 && days > 0 ? (fees / poolUsd) * (365 / days) * 100 : 0;
  const day = trades.filter((r) => nowMs - Date.parse(r.time) <= 86_400_000);
  const buys = trades.filter((r) => r.kind === "BUY").length;
  const turn = poolUsd > 0 ? sum(trades, "usdg") / poolUsd : 0; // how hard each dollar of depth works
  return [
    `${trades.length} trades (${buys} buys, ${trades.length - buys} sells) in ${days.toFixed(2)} days since launch`,
    `volume $${sum(trades, "usdg").toFixed(2)} total, $${sum(day, "usdg").toFixed(2)} in the last 24 h (${day.length} trades)`,
    `LP fees $${fees.toFixed(4)} total (12% of fees fill the tip jar until it is full)`,
    `pool value $${poolUsd.toFixed(2)}, fee APY ${apy.toFixed(1)}% (fees only; price moves are in the tracker's pnl vs hold)`,
    `turnover ${turn.toFixed(2)}x (volume / pool value), ${(days > 0 ? turn / days : 0).toFixed(2)}x per day, ` +
      `${(poolUsd > 0 ? sum(day, "usdg") / poolUsd : 0).toFixed(2)}x in the last 24 h`,
  ];
}

const args = process.argv.slice(2);
const opt = (f: string, d: string) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const HOOK = opt("--hook", "0xC0E513735F35df6A82523744E2aE8a601C772a88") as Hex;
const POOL = opt("--pool", "0x8a1d5f363db9d4a7b874abc858a8fdc86786a9208835aa8360b953cad223b8cd") as Hex;
const OUT = opt("--out", "trades.csv");
const LAUNCH = Date.parse(opt("--launch", "2026-11-08T20:54:44Z")); // v0.2 pool created
// trades on the v0.2 pool before the watcher existed (backfilled into a new CSV)
const BACKFILL: Hex[] = [
  "0xab6c2be1854968d07fc9e1e6f0a479d044217e08932d0e057a0da064acbdc51b",
  "0xc3f4ea09b9281e64eb6a1f5d7ca7b5325adf81b4b2364a2127b31b93beddd5e1",
  "0xe62939a5b292626bb78e612d3b7243309777c4fdcbb685bdc3710e3820e5a3e3",
  "0x3ddc40d8ec7412bbd8599f03a220e30feb0417673d6bf1c8161b5af5e2ad5f20",
  "0xef1358c0c84048e3a810fe832c50ef80a3e2e513464337bc6a59d14a55804d22",
  "0xf48e1123c8ea839f68bb85f30ccb3ecd2a889dc141cae7be7bda5eb2d6f9d760",
  "0x9b409b6124a469cc782c4222b40d83fcadcfe4ded34b3efe62c7eec838346cc1",
];
const HEADER = "time_utc,block,tx,kind,strategy,usdg,price_usdg,lp_fee_usdg,tx_from,tx_to";

async function main() {
  const rpc = process.env.RH_RPC;
  if (!rpc) throw new Error("set RH_RPC");
  const every = Number(opt("--every", "15"));
  const chunk = BigInt(opt("--chunk", "10")); // Alchemy free tier: 10 blocks per eth_getLogs
  const notify = !args.includes("--no-notify") && process.platform === "darwin";
  const pc = createPublicClient({ transport: http(rpc) });

  const state = () => pc.readContract({ address: HOOK, abi: hookAbi, functionName: "poolState", args: [POOL] });
  const rows = () => readRows(existsSync(OUT) ? readFileSync(OUT, "utf8") : HEADER);
  const totals = async () => {
    const v = await state();
    const p = rows().filter((r) => r.price > 0).at(-1)?.price ?? 0; // valued at the last trade price
    const usd = Number(v.quoteReserve) / 1e6 + (Number(v.coinReserve) / 1e18) * p;
    return summarise(rows(), usd, Date.now(), LAUNCH);
  };

  if (args.includes("--summary")) {
    for (const l of await totals()) console.log(l);
    return;
  }

  const seenTx = new Set<string>();
  const record = async (l: Log, quiet = false) => {
    if (l.address.toLowerCase() !== HOOK.toLowerCase() || l.topics[1]?.toLowerCase() !== POOL.toLowerCase()) return;
    let t: Trade;
    try {
      t = decodeTrade(l as { data: Hex; topics: [Hex, ...Hex[]] });
    } catch {
      return; // another event (Tipped, PriceAccepted, ...)
    }
    if (seenTx.has(l.transactionHash!)) return;
    seenTx.add(l.transactionHash!);
    const tx = await pc.getTransaction({ hash: l.transactionHash! });
    const blk = await pc.getBlock({ blockNumber: l.blockNumber! });
    const time = new Date(Number(blk.timestamp) * 1000).toISOString().slice(0, 19) + "Z";
    const s = Number(t.coin) / 1e18;
    const u = Number(t.quote) / 1e6;
    const price = s ? u / s : 0;
    appendFileSync(OUT, [time, l.blockNumber, l.transactionHash, t.kind, s, u, price.toPrecision(6),
      t.feeQuote.toFixed(6), tx.from, tx.to].join(",") + "\n");
    const msg = `${t.kind} $${u.toFixed(2)} (${s.toFixed(0)} STRATEGY @ ${price.toPrecision(4)}), fee $${t.feeQuote.toFixed(4)}`;
    console.log(`${time} ${msg}  tx ${l.transactionHash}  via ${tx.to}`);
    if (notify && !quiet) execFile("osascript", ["-e", `display notification "${msg}" with title "Disciple pool trade"`]);
  };

  if (!existsSync(OUT)) {
    writeFileSync(OUT, HEADER + "\n");
    console.log(`backfilling ${BACKFILL.length} earlier trades into ${OUT}`);
    for (const h of BACKFILL) for (const l of (await pc.getTransactionReceipt({ hash: h })).logs) await record(l as Log, true);
  } else {
    for (const l of readFileSync(OUT, "utf8").split("\n").slice(1)) if (l) seenTx.add(l.split(",")[2]);
  }
  for (const l of await totals()) console.log("  " + l);

  const reserves = async () => {
    const v = await state();
    return `${v.coinReserve}/${v.quoteReserve}`;
  };
  let seen = await reserves();
  let from = (await pc.getBlockNumber({ cacheTime: 0 })) + 1n;
  console.log(`${new Date().toISOString()} watching pool ${POOL.slice(0, 10)} from block ${from}, every ${every}s -> ${OUT}`);

  for (;;) {
    await new Promise((r) => setTimeout(r, every * 1000));
    try {
      const now = await reserves(); // read first: any trade it reflects is at or below `head`
      const head = await pc.getBlockNumber({ cacheTime: 0 }); // no cache: a stale head would skip the trade
      if (now === seen) {
        from = head + 1n; // nothing traded: skip the scan
        continue;
      }
      for (let a = from; a <= head; a += chunk) {
        const b = a + chunk - 1n > head ? head : a + chunk - 1n;
        for (const l of (await pc.getLogs({ address: HOOK, fromBlock: a, toBlock: b })) as Log[]) await record(l);
      }
      seen = now;
      from = head + 1n;
      for (const l of await totals()) console.log("  " + l);
    } catch (e) {
      console.warn(`${new Date().toISOString()} WARN ${(e as Error).message.split("\n")[0]} (retrying next round)`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
