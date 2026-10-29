// RH testnet (46630) trade latency, per phase, through the app's own client code path (lib/aa/mav2 Mav2Account with
// USDG gas → /api/paymaster + /api/bundler disciple_sendUserOperationSync, quotes from lib/trade/usdgRouter).
// One $5 buy + one 10% sell on a fresh account (drip ETH → mint test USDG via the public mint), then optionally a
// burst: BURST=5 ⇒ 5 back-to-back buys + 5 back-to-back 10% sells, priced the way lib/protocol-viem prices queued
// trades (lib/trade/queuePricing). Prints timings + hashes only (no keys).
//   APP=https://disciple-pearl.vercel.app [COIN=0x…] [BURST=5] npx tsx scripts/trade-latency.mts
import { createPublicClient, encodeFunctionData, http, parseAbi, parseUnits, formatUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Mav2Account } from "../lib/aa/mav2";
import { routerBuyWithUsdgCalls, routerSellToUsdgCalls, toCalls, usdgRouteQuote } from "../lib/trade/usdgRouter";
import { addInflight, marginalQuote, key as ckey, QUOTES, LAST_QUOTE } from "../lib/trade/hotCache";
import { applySlippage } from "../lib/curveMath";
import { noRefuseMinOut, holdInflightUntilSeen, sendWithRequote } from "../lib/trade/queuePricing";
const APP = process.env.APP || "https://disciple-pearl.vercel.app";
const BURST = Number(process.env.BURST || 0);
/** OLD=1: the burst as main prices it (Auto 1 % minOut, no resend, in-flight released at the receipt) for a before/after. */
const OLD = process.env.OLD === "1";
const SKIP_SINGLE = process.env.SKIP_SINGLE === "1";
const { robinhoodTestnet, DEPLOYMENTS, TESTNET_COINS } = await import("../lib/chains");
const d = DEPLOYMENTS[46630]; const COIN = (process.env.COIN || TESTNET_COINS.graduated) as Address;
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http(undefined, { fetchOptions: { keepalive: true } }) });
const erc20 = parseAbi(["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"]);
const bal = (t: Address, a: Address) => pc.readContract({ address: t, abi: erc20, functionName: "balanceOf", args: [a] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ---- fetch tap: per-URL timings + NDJSON frame arrival times (the app code calls global fetch)
type Tap = { url: string; method: string; start: number; headers?: number; frames: { kind: string; at: number }[]; end?: number };
let taps: Tap[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  let method = ""; try { method = JSON.parse(String(init?.body ?? "{}")).method ?? ""; } catch { /* */ }
  const tap: Tap = { url, method, start: now(), frames: [] };
  if (/\/api\/(bundler|paymaster)/.test(url)) taps.push(tap);
  const r = await realFetch(input, init); tap.headers = now();
  if (!r.body || !/ndjson/.test(r.headers.get("content-type") || "")) { void r.clone().text().then(() => { tap.end = now(); }); return r; }
  const dec = new TextDecoder(); let buf = "";
  const ts = new TransformStream<Uint8Array, Uint8Array>({
    transform(c, ctl) { buf += dec.decode(c, { stream: true }); let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { tap.frames.push({ kind: JSON.parse(l).kind, at: now() }); } catch { /* */ } } ctl.enqueue(c); },
    flush() { tap.end = now(); },
  });
  return new Response(r.body.pipeThrough(ts), { status: r.status, headers: r.headers });
}) as typeof fetch;

// ---- raw RPC round trip + block time
const rtt: number[] = []; for (let i = 0; i < 8; i++) { const s = now(); await pc.getBlockNumber({ cacheTime: 0 }); rtt.push(now() - s); }
const head = await pc.getBlock(); const past = await pc.getBlock({ blockNumber: head.number - BigInt(200) });
const blockMs = (Number(head.timestamp - past.timestamp) * 1000) / 200;
console.log(`RPC round trip (eth_blockNumber, median of 8): ${med(rtt).toFixed(0)} ms · block time (200-block avg): ${blockMs.toFixed(0)} ms`);
const bs = now(); await realFetch(`${APP}/api/bundler`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }).then((r) => r.text());
const bs2 = now(); await realFetch(`${APP}/api/bundler`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }).then((r) => r.text());
console.log(`app /api/bundler round trip (eth_chainId): cold ${(bs2 - bs).toFixed(0)} ms, warm ${(now() - bs2).toFixed(0)} ms`);

// ---- fresh account: drip ETH (owner self-pay mint), public USDG mint, then USDG-gas trades
const owner = privateKeyToAccount(generatePrivateKey());
for (const k of ["signMessage", "signTypedData", "sign"] as const) {
  const f = (owner as unknown as Record<string, unknown>)[k] as ((...a: unknown[]) => Promise<Hex>) | undefined;
  if (f) (owner as unknown as Record<string, unknown>)[k] = async (...a: unknown[]) => { const s = now(); try { return await f.apply(owner, a); } finally { signMs += now() - s; } };
}
let signMs = 0;
const boot = new Mav2Account({ chain: robinhoodTestnet, pc: pc as never, bundlerUrl: `${APP}/api/bundler` }, owner);
const sa = new Mav2Account({ chain: robinhoodTestnet, pc: pc as never, bundlerUrl: `${APP}/api/bundler`, usdgGas: { paymaster: d.paymaster, usdg: d.usdg, url: `${APP}/api/paymaster`, session: false } }, owner);
const me = await sa.address();
console.log("APP", APP, "\ncoin", COIN, "\naccount", me);
const drip = await realFetch(`${APP}/api/drip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: me }) }).then((r) => r.json());
if (drip.txHash) await pc.waitForTransactionReceipt({ hash: drip.txHash });
for (let i = 0; i < 100 && (await pc.getBalance({ address: me })) === BigInt(0); i++) await sleep(200);
const m = await boot.sendCalls([{ to: d.usdg, data: encodeFunctionData({ abi: erc20, functionName: "mint", args: [me, parseUnits("200", 6)] }) }], "owner");
await pc.waitForTransactionReceipt({ hash: m.txHash as Hex });
for (let i = 0; i < 50 && !(await bal(d.usdg, me)); i++) await sleep(300);
await sa.warm(); await sa.warmGasReserve().catch(() => undefined);
const dl = () => BigInt(Math.floor(Date.now() / 1000) + 300);

type Row = Record<string, number | string>;
async function one(label: string, isBuy: boolean, amountIn: bigint, slipBps: number): Promise<Row> {
  taps = []; signMs = 0;
  const t0 = now();
  const q = await usdgRouteQuote(pc as never, d.router, COIN, isBuy, amountIn, 0, me, true);
  const t1 = now();
  const mo = noRefuseMinOut(q, slipBps ?? null);
  const calls = toCalls(isBuy ? routerBuyWithUsdgCalls({ router: d.router, usdg: d.usdg, token: COIN, usdgIn: amountIn, minTokensOut: mo, deadline: dl() })
    : routerSellToUsdgCalls({ router: d.router, token: COIN, tokensIn: amountIn, minUsdgOut: mo, deadline: dl() }));
  const t2 = now();
  // receipt watcher on the public RPC (starts when the bundler request goes out)
  let seenAt = 0, landedTs = 0;
  const r = await sa.sendCalls(calls, "owner");
  const t3 = now();
  const bun = taps.find((x) => /bundler/.test(x.url) && /sendUserOperation/.test(x.method));
  const pm = taps.filter((x) => /paymaster/.test(x.url));
  for (let i = 0; i < 200 && !seenAt; i++) { const rc = await pc.getTransactionReceipt({ hash: r.txHash }).catch(() => null); if (rc) { seenAt = now(); landedTs = Number((await pc.getBlock({ blockNumber: rc.blockNumber })).timestamp); } else await sleep(50); }
  const sv = (r.timings?.server ?? {}) as Record<string, number>;
  return {
    trade: label, quote: Math.round(t1 - t0), build: Math.round(t2 - t1),
    paymaster: Math.round(pm.reduce((s, x) => s + ((x.end ?? x.headers ?? x.start) - x.start), 0)), pmCalls: pm.length,
    sign: Math.round(signMs),
    bundlerFirstFrame: bun ? Math.round((bun.frames[0]?.at ?? bun.end ?? t3) - bun.start) : -1,
    bundlerDone: bun ? Math.round((bun.end ?? t3) - bun.start) : -1,
    frames: bun ? bun.frames.map((f) => `${f.kind}@${Math.round(f.at - bun.start)}`).join(" ") : "",
    srvSim: sv.simulate ?? -1, srvSignTx: sv.signTx ?? -1, srvSend: sv.send ?? -1, srvMined: sv.mined ?? -1, srvTotal: sv.total ?? -1,
    tapToAccepted: bun ? Math.round((bun.frames.find((f) => f.kind === "pending")?.at ?? bun.end ?? t3) - t0) : -1,
    tapToLanded: Math.round(t3 - t0), rpcReceiptSeen: Math.round(seenAt - t0), blockTs: landedTs, tx: r.txHash.slice(0, 12),
  };
}
const rows: Row[] = [];
if (!SKIP_SINGLE) {
rows.push(await one("$5 buy", true, parseUnits("5", 6), 100));
let tok = BigInt(0); for (let i = 0; i < 50 && !tok; i++) { tok = await bal(COIN, me); if (!tok) await sleep(200); }
rows.push(await one("10% sell", false, tok / BigInt(10), 100));
console.table(rows);
}

if (BURST > 0) {
  if (SKIP_SINGLE) { const r0 = await sa.sendCalls(toCalls(routerBuyWithUsdgCalls({ router: d.router, usdg: d.usdg, token: COIN, usdgIn: parseUnits("5", 6), minTokensOut: BigInt(1), deadline: dl() })), "owner"); console.log("seed buy", r0.txHash.slice(0, 12)); await sleep(1500); }
  // back-to-back: BURST buys fired 150 ms apart, then BURST 10%-of-bag sells, each priced after the ones in flight ahead
  // of it (queuePricing), no minimum-payout refusal (noRefuseMinOut), one fresh-quote resend on a definite min-out revert
  const burst = async (isBuy: boolean) => {
    const bag = isBuy ? BigInt(0) : await bal(COIN, me);
    const ik = ckey("usdgroute", COIN, isBuy ? "buy" : "sell");
    const jobs: Promise<string>[] = [];
    for (let i = 0; i < BURST; i++) {
      const amountIn = isBuy ? parseUnits(process.env.BURST_BUY_USD || "5", 6) : bag / BigInt(10);
      jobs.push((async () => {
        const quoteNow = () => marginalQuote(ik, amountIn, (a, age) => usdgRouteQuote(pc as never, d.router, COIN, isBuy, a, age ?? 0, me, true));
        const build = async () => { const q = await quoteNow(); const mo = OLD ? applySlippage(q, 100) : noRefuseMinOut(q, null);
          return toCalls(isBuy ? routerBuyWithUsdgCalls({ router: d.router, usdg: d.usdg, token: COIN, usdgIn: amountIn, minTokensOut: mo, deadline: dl() })
            : routerSellToUsdgCalls({ router: d.router, token: COIN, tokensIn: amountIn, minUsdgOut: mo, deadline: dl() })); };
        const done = addInflight(ik, amountIn); let block: bigint | undefined;
        try {
          const r = OLD ? await sa.sendCalls(await build(), "owner") as Awaited<ReturnType<typeof sa.sendCalls>> & { resent?: boolean }
            : await sendWithRequote(build, (c) => sa.sendCalls(c, "owner"), () => { QUOTES.dropWhere((k) => k.includes(COIN.toLowerCase())); LAST_QUOTE.clear(); });
          const rc = await pc.getTransactionReceipt({ hash: r.txHash }).catch(() => null); block = rc?.blockNumber;
          return `ok ${r.txHash.slice(0, 10)}${r.resent ? " (resent once after a price move)" : ""}`;
        } catch (e) { return `FAILED ${(e as { code?: string }).code ?? ""} ${String((e as Error).message).slice(0, 80)}`; }
        finally { if (OLD) done(); else void holdInflightUntilSeen(done, block, () => pc.getBlockNumber({ cacheTime: 0 })); }
      })());
      await sleep(150);
    }
    return Promise.all(jobs);
  };
  const t0 = now(); const b = await burst(true); console.log(`${BURST} back-to-back $${process.env.BURST_BUY_USD || 5} buys (${Math.round(now() - t0)} ms):`, b);
  await sleep(1500);
  const t1 = now(); const s = await burst(false); console.log(`${BURST} back-to-back 10% sells (${Math.round(now() - t1)} ms):`, s);
  const all = [...b, ...s].every((x) => x.startsWith("ok"));
  console.log(all ? `PASS: all ${BURST * 2} filled` : "FAIL: some did not fill"); process.exit(all ? 0 : 1);
}
process.exit(0);
