// pnlForPosition core (lib/sharePnl.ts → lib/pnl.ts) + fill decoding (lib/trades.ts).   Run: node scripts/test-share-pnl.mjs
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const dir = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spnl-"));
for (const f of ["pnl", "config", "trades", "sharePnl"]) {
  const src = fs.readFileSync(path.join(dir, `../lib/${f}.ts`), "utf8").replace(/from "\.\/(\w+)"/g, 'from "./$1.mjs"');
  fs.writeFileSync(path.join(tmp, f + ".mjs"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText);
}
const { pnlFromFills } = await import(pathToFileURL(path.join(tmp, "sharePnl.mjs")).href);
const { fillUsd, TOTAL_SUPPLY_TOKENS: S } = await import(pathToFileURL(path.join(tmp, "trades.mjs")).href);
const { FEE } = await import(pathToFileURL(path.join(tmp, "pnl.mjs")).href);
let fail = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fail++; console.error("FAIL " + m); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
let li = 0;
const fill = (side, usd, mcap, ts) => {
  const price = mcap / S;
  return { id: `t:${li}`, tx: "0x", logIndex: li++, block: li, ts, coin: "0xc", trader: "0xw", side, venue: "curve",
    tokens: side === "buy" ? (usd * (1 - FEE)) / price : usd / price, usd, priceUsd: price, mcapUsd: mcap };
};
const T = 1_700_000_000_000;

// 1) still holding: uPnL at the current mcap, end = now
{
  const fs_ = [fill("buy", 100, 10_000, T)];
  const p = pnlFromFills("0xw", "0xc", fs_, 30_000, T + 5000);
  const tokens = fs_[0].tokens, expect = tokens * (30_000 / S) - 100;
  ok(p.kind === "unrealized", "kind unrealized");
  ok(near(p.gainUsd, expect), `uPnL ${p.gainUsd} vs ${expect}`);
  ok(near(p.gainPct, (expect / 100) * 100), "pct = gain / invested");
  ok(p.endTs === T + 5000 && p.startTs === T, "start = first buy, end = now");
  ok(p.mcapEndUsd === 30_000 && p.mcapStartUsd === 10_000, "mcaps");
}
// 2) sold everything: realized, end = final sell, mcap at the sell (ignores current mcap)
{
  const b = fill("buy", 100, 10_000, T);
  const sellUsd = b.tokens * (20_000 / S);
  const p = pnlFromFills("0xw", "0xc", [b, fill("sell", sellUsd, 20_000, T + 60_000)], 999_999, T + 1e6);
  const expect = sellUsd - 100 - sellUsd * FEE; // net of exit fee
  ok(p.kind === "realized", "kind realized");
  ok(near(p.gainUsd, expect), `realized ${p.gainUsd} vs ${expect}`);
  ok(p.endTs === T + 60_000 && p.mcapEndUsd === 20_000 && p.holding === 0, "end = final sell");
}
// 3) sells before the first buy are ignored (entry = first buy)
{
  const p = pnlFromFills("0xw", "0xc", [fill("sell", 50, 5_000, T - 10), fill("buy", 100, 10_000, T)], 10_000, T + 1);
  ok(p.fills.length === 1 && p.startTs === T, "pre-entry sell dropped");
  ok(p.gainUsd < 0 && p.gainUsd > -2, `flat mark ⇒ only the buy fee lost (${p.gainUsd})`);
}
// 4) partial sell + still holding: gain = realized + uPnL; flat mark after fills ⇒ unchanged by time
{
  const fs_ = [fill("buy", 200, 10_000, T), fill("sell", 100, 40_000, T + 10), fill("buy", 50, 30_000, T + 20)];
  const a = pnlFromFills("0xw", "0xc", fs_, 40_000, T + 30), b = pnlFromFills("0xw", "0xc", fs_, 40_000, T + 9e9);
  ok(a.kind === "unrealized" && a.realizedUsd > 0 && a.unrealizedUsd > 0, "mixed position");
  ok(near(a.gainUsd, a.realizedUsd + a.unrealizedUsd), "gain = realized + uPnL");
  ok(near(a.gainUsd, b.gainUsd), "no drift with time at a flat mark");
  ok(near(a.investedUsd, 250), "invested = sum of buys");
}
// 5) no buys ⇒ none
{ const p = pnlFromFills("0xw", "0xc", [], 1, T); ok(p.kind === "none" && p.gainUsd === 0, "empty"); }
// 6) fillUsd: mcapAfterUsd WAD → $; mid price between before/after
{
  const u = fillUsd({ tokenAmt: 1_000n * 10n ** 18n, priceBeforeX18: 100n, priceAfterX18: 100n, mcapAfterUsd: 70_000n * 10n ** 18n });
  ok(near(u.mcapUsd, 70_000) && near(u.priceUsd, 0.07) && near(u.usd, 70), `fillUsd flat ${JSON.stringify(u)}`);
  const v = fillUsd({ tokenAmt: 10n ** 18n, priceBeforeX18: 50n, priceAfterX18: 100n, mcapAfterUsd: 1_000_000n * 10n ** 18n });
  ok(near(v.usd, 0.75), `fillUsd mid ${v.usd}`);
}
// 7) v4 hook fill (no mcapAfterUsd): mcap = priceAfterX18 × supply × quotePriceUsd. 1 token raw = 0.07 quote raw·1e18
//    ⇒ price 7e16 (x18), quote $2 ⇒ token $0.14, mcap 1e6 × 0.14 = $140k; must match the curve formula for the same mcap.
{
  const h = fillUsd({ tokenAmt: 10n ** 18n, priceBeforeX18: 7n * 10n ** 16n, priceAfterX18: 7n * 10n ** 16n, quotePriceUsd: 2n * 10n ** 18n });
  ok(near(h.mcapUsd, 140_000) && near(h.priceUsd, 0.14), `fillUsd hook ${JSON.stringify(h)}`);
  const c = fillUsd({ tokenAmt: 10n ** 18n, priceBeforeX18: 7n * 10n ** 16n, priceAfterX18: 7n * 10n ** 16n, mcapAfterUsd: 140_000n * 10n ** 18n });
  ok(near(c.usd, h.usd), "hook fill USD == curve fill USD at the same mcap");
  const z = fillUsd({ tokenAmt: 10n ** 18n, priceBeforeX18: 1n, priceAfterX18: 1n });
  ok(z.mcapUsd === 0 && z.usd === 0, "hook fill without a quote price ⇒ 0, never NaN");
}
console.log(fail ? `${fail}/${n} FAILED` : `ok ${n} checks`);
process.exit(fail ? 1 : 0);
