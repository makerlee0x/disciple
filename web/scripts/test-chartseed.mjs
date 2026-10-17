// Unit test for the minimap history backfill bucketing (chartSeedK in public/flight/engine.js, between @chart-seed markers).
// Usage: node scripts/test-chartseed.mjs
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const src=fs.readFileSync(path.join(root,'public/flight/engine.js'),'utf8');
const m=src.match(/\/\* @chart-seed:start[\s\S]*?\*\/([\s\S]*?)\/\* @chart-seed:end \*\//); if(!m) throw new Error('chart-seed markers missing');
const chartSeedK=new Function(m[1]+'\nreturn chartSeedK;')();
let fail=0; const ok=(c,msg)=>{ if(!c){ fail++; console.log('FAIL '+msg); } };
const T=1_700_000_000-(1_700_000_000%3600);   // aligned hour, seconds
// 1) empty → history buckets (ms ts → sec), OHLC, volume, gap dojis
{ const k={60:[],3600:[]};
  const f=[{t:T+5,m:100,usd:10,side:'buy'},{t:T+30,m:120,usd:5,side:'buy'},{t:T+50,m:90,usd:7,side:'sell'},{t:T+185,m:110,usd:1,side:'buy'}];
  chartSeedK(k,f.slice().reverse(),160); const a=k[60];
  ok(a.length===4,'1m: 4 buckets (1 + 2 dojis + 1) got '+a.length);
  ok(a[0].b===T/60&&a[0].o===100&&a[0].h===120&&a[0].l===90&&a[0].c===90&&a[0].v===22,'1m first bucket OHLCV '+JSON.stringify(a[0]));
  ok(a[1].o===90&&a[1].c===90&&a[1].v===0&&a[2].v===0,'gap dojis flat at prev close');
  ok(a[3].o===90&&a[3].c===110&&a[3].h===110&&a[3].l===90,'continuous open');
  const h=k[3600]; ok(h.length===1&&h[0].o===100&&h[0].c===110&&h[0].h===120&&h[0].l===90&&h[0].v===23,'1h aggregated '+JSON.stringify(h[0])); }
// 2) gap cap: huge gap never produces more than keep candles
{ const k={60:[]}; chartSeedK(k,[{t:T,m:1,usd:1},{t:T+60*100000,m:2,usd:1}],160);
  ok(k[60].length===160&&k[60][159].c===2,'gap capped at keep='+k[60].length); }
// 3) merge with live candles: history prepends, overlapping fill widens h/l + adds volume, live close wins, open continuous
{ const L=T/60+10; const k={60:[{b:L,o:200,h:205,l:200,c:204,v:3}]};
  chartSeedK(k,[{t:T,m:150,usd:2},{t:L*60+1,m:300,usd:4}],160); const a=k[60];
  ok(a[0].b===T/60&&a[a.length-1].b===L&&a.length===11,'prepended + gap to live '+a.length);
  const lv=a[a.length-1]; ok(lv.c===204&&lv.h===300&&lv.v===7&&lv.o===150&&lv.l===150,'live candle merged '+JSON.stringify(lv)); }
// 4) bad rows ignored
{ const k={60:[]}; chartSeedK(k,[{t:NaN,m:1},{t:T,m:0}],160); ok(k[60].length===0,'bad rows ignored'); }
console.log(fail?`FAIL · ${fail} checks`:'PASS · chart backfill bucketing'); process.exit(fail?1:0);
