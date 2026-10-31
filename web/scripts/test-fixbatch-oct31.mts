/** Fix batch (lee, Oct 31): own TRADES row from the receipt + de-dup by tx hash; desktop TOP HOLDERS curve row; no creator pill.
 *  Run: npm run test:fixbatch-oct31 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHolders, holderLabelText } from "../lib/flight/holders";

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const eng = fs.readFileSync(path.join(web, "public/flight/engine.js"), "utf8");
const block = (a: string, b: string) => { const i = eng.indexOf(a), j = eng.indexOf(b, i); if (!(i > 0 && j > i)) throw new Error("engine block " + a); return eng.slice(i, j); };
const line = (re: RegExp) => { const m = eng.match(re); if (!m) throw new Error("engine: " + re); return m[0]; };
const fmtShot = (u: number) => "$" + u.toFixed(2), fmtUsd = (u: number) => "$" + u.toFixed(0);
const ME = "0xaaaa00000000000000000000000000000000cafe", TX = "0x" + "ab".repeat(32), TX2 = "0x" + "cd".repeat(32);

function engineFeed() {
  const S: Record<string, unknown> & { feed: Record<string, unknown>[] } = { feed: [], fuelers: { you: 0 }, volEma: 0, buyEma: 0, sellEma: 0, confirmed: {}, fullStackNext: false, wallet: "" };
  const seen = new Set<string>();
  const f = new Function("S", "markMcap", "chartTick", "chartMine", "chartState", "momNote", "noteSell", "award", "fmtShot", "fmtUsd", "isLive", "addEventListener",
    block("/* @sellfill", "/* @sellfill-end */") + "\nreturn { onFillReceipt, ownSellSwap };");
  const H = f(S, () => 5e5, () => {}, () => {}, () => ({ seen }), () => {}, () => {}, () => {}, fmtShot, fmtUsd, () => true, () => {});
  return { S, H, seen };
}

test("own BOOST row straight from the receipt: hash, side, $, tokens, price, time", () => {
  const { S, H, seen } = engineFeed(); const t0 = Date.now();
  H.onFillReceipt({ txHash: TX.toUpperCase().replace("0X", "0x"), side: "buy", usd: 2.5, tokens: 1000, trader: ME });
  const r = S.feed[0];
  assert.equal(S.feed.length, 1);
  assert.match(String(r.txt), /^▲ BOOST\s+\$2\.50 {2}\(you\)$/);   // text unchanged
  assert.equal(r.tx, TX); assert.equal(r.side, "buy"); assert.equal(r.usd, 2.5); assert.equal(r.tokens, 1000); assert.equal(r.price, 0.0025);
  assert.ok((r.at as number) >= t0 && r.t === 1 && r.own === 1);
  assert.ok(seen.has(TX), "the /api/trades backfill skips this tx");
});

test("the polled log for that tx is de-duplicated by hash (mine, or not yet flagged mine but our receipt's trader)", () => {
  const { S, H } = engineFeed();
  H.onFillReceipt({ txHash: TX, side: "sell", usd: 9, tokens: 3000, trader: ME });
  assert.equal(S.feed.length, 1); assert.match(String(S.feed[0].txt), /^▼ DUMP/);
  assert.equal(H.ownSellSwap({ t: "swap", side: "sell", mine: true, txHash: TX.toUpperCase(), usd: 9.1, mcap: 4e5 }), null);
  assert.equal(H.ownSellSwap({ t: "swap", side: "sell", mine: false, trader: ME.toUpperCase().replace("0X", "0x"), txHash: TX, usd: 9.1, mcap: 4e5 }), null);
  const other = { t: "swap", side: "buy", mine: false, trader: "0x" + "1".repeat(40), txHash: TX, usd: 3, mcap: 4e5 };
  assert.equal(H.ownSellSwap(other), other, "someone else's swap in the same (bundle) tx still shows");
  const fresh = { t: "swap", side: "buy", mine: false, trader: "0x" + "2".repeat(40), txHash: TX2, usd: 3 };
  assert.equal(H.ownSellSwap(fresh), fresh);
  // swap first, then the receipt: one row (the receipt adds nothing)
  const first = { t: "swap", side: "buy", mine: true, txHash: "0x" + "9".repeat(64), usd: 2 };
  assert.equal(H.ownSellSwap(first), first); H.onFillReceipt({ txHash: first.txHash, side: "buy", usd: 2, tokens: 5 });
  assert.equal(S.feed.length, 1);
});

test("TRADES seed after the receipt row: the same tx from /api/trades is not shown twice", () => {
  const blk = eng.match(/\/\* @feed-names:start[\s\S]*?\*\/([\s\S]*?)\/\* @feed-names:end \*\//); assert.ok(blk);
  const src = [line(/^const short=.*$/m), line(/^function fillUsd\(f\).*$/m), line(/^const fmtUsd=.*$/m), "const fmtShot=v=>'$'+v.toFixed(2);", blk![1], "return {feedSeedFills};"].join("\n");
  const E = new Function("window", src)({});
  const feed: Record<string, unknown>[] = [{ txt: "▲ BOOST   $2.50  (you)", own: 1, t: 1, tx: TX }];
  E.feedSeedFills(feed, [{ tx: TX, logIndex: 3, side: "buy", trader: ME, usdIn: 2.5 }, { tx: TX2, logIndex: 0, side: "buy", trader: "0x" + "3".repeat(40), usdIn: 7 }], ME, new Set());
  assert.equal(feed.length, 2); assert.equal(feed[1].tx, TX2);
});

test("curve row: labelled 'Bonding curve', on top, never ranked or counted as a holder", () => {
  const CURVE = "0x" + "c".repeat(40), A = "0x" + "1".repeat(40), B = "0x" + "2".repeat(40), E18 = BigInt(10) ** BigInt(18);
  const rows = buildHolders([{ address: A, balance: BigInt(100) * E18 }, { address: CURVE, balance: BigInt(800) * E18 }, { address: B, balance: BigInt(50) * E18 }],
    { labels: { [CURVE]: "curve" }, totalSupplyRaw: BigInt(1000) * E18, priceUsd: 0.01, me: B });
  assert.equal(rows[0].address, CURVE); assert.equal(rows[0].label, "curve"); assert.equal(holderLabelText(rows[0].label), "Bonding curve");
  // engine: realHolders splits it into `system`; topFuelers (desktop list, KOTH, achievements, 'you' $) only has the real holders
  const src = [block("function realHolders(){", "let _twT="), "return {realHolders,topFuelers,kothLines};"].join("\n");
  const S = { t: 10, holders: { rows, asOfBlock: 1 }, fuelers: {} };
  const E = new Function("S", "markMcap", "myWallet", "short", "_topT", "_top", src)(S, () => 0, () => B, (a: string) => a.slice(0, 6), -1, []);
  const h = E.realHolders(), top = E.topFuelers();
  assert.equal(h.system.length, 1); assert.equal(h.system[0].label, "curve");
  assert.deepEqual(top.map((x: [string, number]) => x[0]), [A.slice(0, 6), "you"]);
  // desktop TOP HOLDERS card: curve line on top, then the ranked holders, 3 lines in all
  const kl = E.kothLines(top, h.system);
  assert.equal(kl.sys.length, 1); assert.equal(kl.ranked.length, 2);
  const many = [{ label: "pool" }, { label: "locker" }, { label: "burn" }];
  assert.equal(E.kothLines(top, many).sys.length, 2, "one line always stays for a real holder");
  assert.equal(E.kothLines([], many).sys.length, 3);
  assert.equal(E.kothLines(top, null).ranked.length, 2);
  // the draw uses it, greyed + labelled with the shared HOLDER_KIND text
  assert.match(eng, /const kl=kothLines\(top,S\.holders\?\(realHolders\(\)\|\|\{\}\)\.system:null\);/);
  assert.match(eng, /kl\.sys\.forEach\(\(r,j\)=>\{ ctx\.fillStyle='rgba\(220,228,255,\.5\)';[^\n]*holderKindText\(r\.label\)/);
});

test("coin screen: no creator fee pill (crew pill + shared CSS stay); claim amounts in $", () => {
  const cc = fs.readFileSync(path.join(web, "components/claims/CoinClaims.tsx"), "utf8");
  const ui = fs.readFileSync(path.join(web, "components/claims/ui.tsx"), "utf8");
  const css = fs.readFileSync(path.join(web, "app/claims.css"), "utf8");
  assert.ok(!/data-testid="creator-badge"|className="cl-coin-pill creator"|creatorClaimable|sendCreatorClaims/.test(cc));
  assert.ok(/data-testid="crew-pill"/.test(cc) && /\.cl-coin-pill \{/.test(css) && /\.cl-coin-pill\.crew \{/.test(css));
  assert.match(ui, /if \(!exact && usd != null\) return \(\s*<span className=\{"cl-money" \+ \(big \? " big" : ""\)\} title=\{fmtAmount\(raw, asset\)\}>\s*<span className="amt">\{fmtUsd\(usd\)\}<\/span>/);
  assert.match(ui, /<Money raw=\{l\.raw\} asset=\{l\.asset\} exact \/>/);   // confirm sheet keeps the exact token amount
});
