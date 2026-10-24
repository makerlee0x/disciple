/**
 * Live prod retest (2026-10-24) SITE fixes:
 *  #4 graduation % — lib/mcap graduationPct (cards) and indexer math.graduationPct match the curve's progressBps();
 *     RPNR on-chain snapshot: mcap $27,465.22, progressBps 9179 (91.8%), the card said 79% (mcap-linear).
 *  #3 feed amounts — playerUsd / tradeFromLog: the real USDG paid / received when the router reported it.
 *  #4b home 24h change on a coin's own supply (was a fixed 7B).
 *  #5 username lookup — lowercase keys, cache, owner fallback, chip label.
 * Run: pnpm test:live-retest
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { graduationPct, pctFromBps } from "../lib/mcap";
import { graduationPct as idxGraduationPct } from "../../indexer/src/math";
import { playerUsd, type Fill } from "../lib/trades";
import { tradeFromLog } from "../lib/events";
import { statsFromFills } from "../lib/home/trending";
import { chipLabel, clearNameCache, lookupFirstName, lookupName, cachedName } from "../lib/nameLookup";

const near = (a: number | null, b: number, eps: number, msg?: string) => { assert.ok(a != null && Math.abs(a - b) <= eps, `${msg ?? ""} ${a} vs ${b}`); };

test("#4 RPNR: graduation % = the curve's progressBps (91.8%), not the old mcap-linear 79%", () => {
  const mcap = 27465.222876627162;           // curve.marketCapQuote × quotePriceUsd, read-only on chain 2026-10-24
  near(graduationPct(mcap), 91.79, 0.01, "web");
  near(idxGraduationPct(mcap), 91.79, 0.01, "indexer");
  near(pctFromBps(9179), 91.79, 1e-9);
  const linear = ((mcap - 7000) / (33000 - 7000)) * 100;
  assert.equal(Math.round(linear), 79);       // what the card showed
  near(graduationPct(7081.061019245381), 1.06, 0.01, "GOLDEN (progressBps 106)");
  near(graduationPct(7004.57632997613), 0.06, 0.01, "RPFR (progressBps 6)");
});

test("#4 graduationPct = tokensSold / sCurve along the real CurveMath curve (any quote price, own start/grad)", () => {
  // RPNR curveParams(): totalSupply 7e9, sCurve 5.04e9, x0 3,029,122.678, y0 9,343,129,543.6 (whole units); qp $0.0030844
  const S = 7e9, sC = 5.04e9, x0 = 3029122.6781125995, y0 = 9343129543.615236, qp = 0.003084434186546977;
  const mcapAt = (sold: number) => { const y = y0 - sold, x = (x0 * y0) / y; return (x * S / y) * qp; };
  near(mcapAt(0), 7000, 0.01); near(mcapAt(sC), 33000, 0.05);
  for (const f of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9179, 0.99]) {
    near(graduationPct(mcapAt(f * sC)), f * 100, 1e-6, `web @${f}`);
    near(idxGraduationPct(mcapAt(f * sC)), f * 100, 1e-6, `indexer @${f}`);
  }
  // a coin launched with other targets (LaunchTierContext start/graduation)
  near(graduationPct(40_000, 10_000, 90_000), (1 - Math.sqrt(10 / 40)) / (1 - Math.sqrt(10 / 90)) * 100, 1e-9);
  assert.equal(graduationPct(33_000), 100); assert.equal(graduationPct(50_000), 100);
  assert.equal(graduationPct(6_000), 0); assert.equal(graduationPct(null), null); assert.equal(graduationPct(NaN), null);
  assert.equal(idxGraduationPct(null), null);
});

test("#3 playerUsd: buys = USDG paid, sells = USDG received, else the estimate", () => {
  assert.equal(playerUsd({ side: "buy", usd: 8.18, usdIn: 10 }), 10);
  assert.equal(playerUsd({ side: "sell", usd: 208.25, usdOut: 245 }), 245);
  assert.equal(playerUsd({ side: "sell", usd: 2.47, usdIn: 9 }), 2.47);   // wrong-side amount ignored
  assert.equal(playerUsd({ side: "buy", usd: 3 }), 3);
  assert.equal(playerUsd({ side: "buy", usd: NaN }), 0);
});

const E18 = BigInt(10) ** BigInt(18);
const TRADER = "0x3dfe06e0854788eed40f852d097d3cf0337dbede";
const TOKEN = "0xedb9546d2f5a594c47f18ed9b63df7be95d412f5";
const mkLog = (isBuy: boolean, quoteAmt: bigint) => ({
  eventName: "Trade", transactionHash: "0xabc", blockNumber: BigInt(1), logIndex: 3,
  args: { token: TOKEN, trader: TRADER, isBuy, quoteAmt, tokenAmt: BigInt(1000) * E18, fee: BigInt(0), snipeFee: BigInt(0), impactBps: BigInt(5), mcapAfterUsd: BigInt(7100) * E18, priceAfterX18: BigInt(0) },
}) as never;
const QP = BigInt("2532872904936540");   // GOLDEN launch quote price (USD WAD per quote)

test("#3 live Trade events carry the router's USDG as usd (feed = status line)", () => {
  // $10 buy: the curve got 3,230 STRATEGY (net of route) ⇒ $8.18 at the launch quote price; the player paid $10
  const quote = (BigInt(3230) * E18);
  const est = Number(quote) / 1e18 * 0.00253287290493654;
  const plain = tradeFromLog(mkLog(true, quote), QP, "curve") as { usd: number; usdIn?: number };
  near(plain.usd, est, 1e-9, "no router event ⇒ quote value");
  const buy = tradeFromLog(mkLog(true, quote), QP, "curve", undefined, { trader: TRADER, token: TOKEN, isBuy: true, amountIn: BigInt(10) * E18, amountOut: BigInt(0) }) as { usd: number; usdIn?: number };
  assert.equal(buy.usd, 10); assert.equal(buy.usdIn, 10);
  const sell = tradeFromLog(mkLog(false, quote), QP, "curve", undefined, { trader: TRADER, token: TOKEN, isBuy: false, amountIn: BigInt(0), amountOut: BigInt(244) * E18 / BigInt(100) }) as { usd: number; usdOut?: number };
  assert.equal(sell.usd, 2.44); assert.equal(sell.usdOut, 2.44);
  // UsdgTrade of another trader in the same tx is not applied
  const other = tradeFromLog(mkLog(true, quote), QP, "curve", undefined, { trader: "0x" + "1".repeat(40), token: TOKEN, isBuy: true, amountIn: BigInt(10) * E18, amountOut: BigInt(0) }) as { usd: number };
  near(other.usd, est, 1e-9);
});

const fill = (o: Partial<Fill>): Fill => ({ id: "x", tx: "0x", logIndex: 0, block: 1, ts: 0, coin: TOKEN, trader: TRADER, side: "buy", venue: "curve", tokens: 1, usd: 1, priceUsd: 1, mcapUsd: 1, ...o });

test("#4b home 24h change uses the coin's own supply (1M-supply coin)", () => {
  const now = 10 * 86_400_000;
  // 1M supply: mcap $20K at the 24h mark ⇒ priceUsd 0.02; live mcap $30K ⇒ +50%
  const f = [fill({ ts: now - 2 * 86_400_000, priceUsd: 0.02, mcapUsd: 20_000 }), fill({ id: "y", block: 2, ts: now - 3600_000, side: "buy", usd: 9, usdIn: 10, priceUsd: 0.03, mcapUsd: 30_000 })];
  const s = statsFromFills(f, now, 30_000);
  near(s.chg24, 50, 1e-9);
  assert.equal(s.vol24, 10);   // 24h volume = USDG paid
});

test("#5 username lookup: lowercase key, cached, owner fallback, chip label", async () => {
  clearNameCache();
  const asked: string[] = [];
  const names: Record<string, string | null> = { [TRADER]: "maker" };
  const fetcher = async (a: string) => { asked.push(a); return names[a] ?? null; };
  const mixed = "0x3DFE06E0854788EED40F852D097D3CF0337DBEDE";
  const [a, b] = await Promise.all([lookupName(mixed, fetcher), lookupName(TRADER, fetcher)]);
  assert.equal(a, "maker"); assert.equal(b, "maker");
  assert.deepEqual(asked, [TRADER]);           // one request, lowercase
  await lookupName(TRADER, fetcher); assert.equal(asked.length, 1);   // cached
  assert.equal(cachedName(mixed), "maker");
  const smart = "0x" + "a".repeat(40);
  assert.equal(await lookupFirstName([smart, mixed], fetcher), "maker");   // smart account unnamed ⇒ owner's name
  assert.equal(await lookupName("nope", fetcher), null);
  assert.equal(chipLabel("maker", mixed), "@maker");
  assert.equal(chipLabel("@maker", mixed), "@maker");
  assert.equal(chipLabel(null, mixed), "0x3DFE…BEDE");
  clearNameCache();
  assert.equal(await lookupName(TRADER, async () => { throw new Error("down"); }), null);
});
