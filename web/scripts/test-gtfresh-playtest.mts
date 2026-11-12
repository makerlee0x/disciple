// Regression inputs below are the real public GTFRESH fill, not production mock/seed data.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {statsFromFills,prePriceOf} from '../lib/home/trending';
import {fmtUsd} from '../lib/gamechat/format';import {defaultUsername} from '../lib/defaultUsername';
import type {Fill} from '../lib/trades';
const eng=readFileSync(new URL('../public/flight/engine.js',import.meta.url),'utf8');
const fill:Fill={id:'0xea47629399fc35b2559843e96a80f96aa98cba7d9be872f78a6943e6ed5599d5:12',tx:'0xea47629399fc35b2559843e96a80f96aa98cba7d9be872f78a6943e6ed5599d5',logIndex:12,block:149565214,ts:1793975254000,coin:'0xab9e86498c9b32743e31b0fca02d6b254bcddd4e',trader:'0xd9fdf29fbab9be7ca1f6a3a07e0c36d65170aef5',side:'buy',venue:'curve',tokens:73.01044766601298,usd:0.2458131024488206,priceUsd:0.003333305425025708,mcapUsd:3333.3054250257082,usdBasis:'quote',impactBps:0};
test('GTFRESH fee-inclusive launch fill does not fabricate a 2% fall',()=>{
 const stats=statsFromFills([fill],fill.ts+3600000,fill.mcapUsd);assert.ok(Math.abs(stats.chg24!)<1e-9);assert.equal(stats.trades24,1);
 assert.equal(prePriceOf({...fill,impactBps:undefined}),null,'quote notional without price impact is unknown, not a mid-price');
 assert.ok(Math.abs(prePriceOf({...fill,priceUsd:110,impactBps:1000})!-100)<1e-10);
 assert.ok(Math.abs(prePriceOf({...fill,side:'sell',priceUsd:90,impactBps:1000})!-100)<1e-10);
 assert.equal(prePriceOf({...fill,side:'sell',impactBps:10000}),null);
});
test('generated call sign and nonzero sub-dollar holdings are not zero or a claimed identity',()=>{
 assert.equal(defaultUsername(fill.trader),'Captain Nova');
 const value=fill.tokens*fill.priceUsd;assert.ok(value>0.24&&value<0.25);assert.equal(fmtUsd(value),'$0.24');assert.equal(fmtUsd(0),'$0');assert.equal(fmtUsd(1e-8),'<$0.01');
});
test('feed timestamps use historical block time, mark live receipt time, and never date missing history as now',()=>{
 const code=eng.match(/\/\* @feed-names:start[\s\S]*?\*\/([\s\S]*?)\/\* @feed-names:end \*\//)![1];
 const E=new Function('window',`const short=a=>a,fmtShot=v=>'$'+v.toFixed(2),fmtUsd=fmtShot,fillUsd=f=>f.usd;${code};return {feedTime,feedSeedFills,feedTradeRow};`)({});
 const rows:any[]=[];E.feedSeedFills(rows,[fill],null,new Set());assert.equal(rows[0].at,fill.ts);assert.equal(rows[0].received,false);
 const date=new Date(fill.ts),clock=[date.getHours(),date.getMinutes(),date.getSeconds()].map(v=>String(v).padStart(2,'0')).join(':');assert.equal(E.feedTime(rows[0]),clock);
 assert.match(E.feedTime(E.feedTradeRow('buy',1,null,fill.trader)),/^~\d{2}:\d{2}:\d{2}$/);
 const unknown:any[]=[];E.feedSeedFills(unknown,[{...fill,ts:undefined}],null,new Set());assert.equal(E.feedTime(unknown[0]),'—');
 assert.match(eng,/ctx\.fillText\(feedTime\(r\),FX\+FW-16,fy\)/);assert.match(eng,/ctx\.fillText\(feedTime\(r\),cx,cy\+12\)/);
});
test('held S/Down reaches straight down at every viewport/zoom and smoothly recovers, without wrap',()=>{
 const code=eng.slice(eng.indexOf('/*HEADING-BEGIN*/'),eng.indexOf('/*HEADING-END*/')).replace(/^function rocketDrawAngle.*$/m,'');
 const {aimFromMotion,aimWithDive,stepHeading}=new Function(`${code};return {aimFromMotion,aimWithDive,stepHeading};`)();
 assert.match(eng,/stepHeading\(S, aimWithDive\(aimFromMotion/);assert.doesNotMatch(eng,/S\.vyAtt=[^\n]*-260/);
 for(const height of [320,720,1536,2160])for(const zoom of [1,3,10,40])for(const fps of [20,60,144])for(const side of [-1,1]){
  const st={aimDisp:90,aimVel:0,aimTgt:90,lastSide:side},dt=1/fps,v0=1.5*height*zoom*0.02;let dive=0,prev=90;
  for(let i=0;i<6*fps;i++){dive+=(1-dive)*(1-Math.exp(-dt*8));const motion=aimFromMotion(0,side,0,v0,st);stepHeading(st,aimWithDive(motion,dive,st),0,dt);assert.ok(Math.abs(st.aimDisp-prev)<=110*dt+1e-6);prev=st.aimDisp;}
  assert.ok(Math.abs(Math.abs(90-st.aimDisp)-180)<0.1,`H=${height} zoom=${zoom} fps=${fps} side=${side}`);
  for(let i=0;i<8*fps;i++){dive*=Math.exp(-dt*4);stepHeading(st,aimWithDive(aimFromMotion(0,0,0,v0,st),dive,st),0,dt);}
  assert.ok(Math.abs(st.aimDisp-90)<0.1,'release recovers upright');
 }
});
