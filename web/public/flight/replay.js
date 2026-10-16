/* DISCIPLE flight — deterministic replay renderer for share videos.
 *
 *   const r = await window.__flight.replay({coin, supply, ticker, t0, t1, trades:[{ts,tx,li,side,usd,mcapUsd,impactBps,trader,mine}],
 *                                          startMcap, durationSec:12, fps:30, width:1080, height:1920, seed, clean:true, canvas?});
 *   r.canvas  r.frames  r.step()  r.stateAt(t)  r.on('trade'|'bomb'|'tier'|'frame', cb)  r.hash()  r.dispose()
 *
 * How: a SECOND engine instance is evaluated from engine.js inside a sandbox (with-scope over a fake window), so the
 * live game (window.__flight, its canvas, events, storage) is never touched. Every clock the engine can read
 * (performance.now, Date.now, setTimeout/setInterval, requestAnimationFrame) is driven by the replay's sim clock and
 * Math.random is a seeded mulberry32 — same inputs + seed ⇒ identical frames. No rAF, no timers: step() renders one
 * frame synchronously, so it works in a hidden tab. Trades are re-timed from [t0,t1] onto [lead, durationSec−tail].
 */
(function(){
'use strict';
let SRC=null;
const base=()=>(window.__DISCIPLE_BASE_PATH__||'');
async function engineSrc(){ if(SRC) return SRC; const r=await fetch(base()+'/flight/engine.js',{cache:'force-cache'}); if(!r.ok) throw new Error('engine.js '+r.status); return (SRC=await r.text()); }
function mulberry32(a){ a=a>>>0||0x9e3779b9; return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function hashStr(s){ let h=2166136261>>>0; s=String(s); for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return h>>>0; }
/* tier ladder copy (engine.js TIERS / contracts Constants.sol lows) — only for stateAt(); the engine draws its own */
const TIER_LO=[7e3,12e3,18e3,25e3,33e3,55e3,100e3,333e3,777e3,1.2e6,3.3e6,7.7e6,33e6,77e6,120e6,777e6,1.2e9,3.3e9];
const TIER_NAMES=['LAUNCH PAD','LIMBO','ASCENSION','NARROW GATE','PEARLY GATES','FIRMAMENT','ANGELS','ARCHANGELS','HEAVENLY HOST','MORNING STARS','VIRTUES','DOMINIONS','THRONE ROOM','CHERUBIM','SERAPHIM','AETHER','EMPYREAN','SEVENTH HEAVEN'];
const tierOf=m=>{ let i=0; while(i<TIER_LO.length-1&&m>=TIER_LO[i+1]) i++; return i; };
const fmtUsd=v=>v>=1e9?'$'+(v/1e9).toFixed(2)+'B':v>=1e6?'$'+(v/1e6).toFixed(2)+'M':v>=1e3?'$'+(v/1e3).toFixed(1)+'K':'$'+(+v).toFixed(2);

async function replay(o){
  o=Object.assign({durationSec:12,fps:30,width:1080,height:1920,seed:1,clean:true,lead:0.6,tail:1.2},o||{});
  const fps=Math.max(1,Math.round(o.fps)), W=Math.round(o.width), H=Math.round(o.height), dur=+o.durationSec;
  const frames=Math.max(1,Math.round(dur*fps)), frameMs=1000/fps;
  const seed=typeof o.seed==='number'?o.seed:hashStr(o.seed==null?'':o.seed);
  // ---- re-time the trades (pure)
  const raw=(o.trades||[]).filter(t=>t&&+t.mcapUsd>0).slice().sort((a,b)=>(+a.ts-+b.ts)||((+a.li||0)-(+b.li||0)));
  const t0=o.t0!=null?+o.t0:(raw.length?+raw[0].ts:0), t1=o.t1!=null?+o.t1:(raw.length?+raw[raw.length-1].ts:t0+1);
  const lead=Math.min(o.lead,dur*0.2), span=Math.max(0.1,dur-lead-Math.min(o.tail,dur*0.2));
  const startMcap=+o.startMcap>0?+o.startMcap:(raw.length?+raw[0].mcapUsd:7e3);
  const supply=+o.supply>0?+o.supply:7e9;
  let prev=startMcap;
  const trades=raw.filter(t=>+t.ts>=t0&&+t.ts<=t1).map((t,i)=>{ const at=lead+span*((+t.ts-t0)/Math.max(1e-9,t1-t0)); const pre=prev; prev=+t.mcapUsd;
    return {i,at,ts:+t.ts,tx:t.tx||'',side:t.side==='sell'?'sell':'buy',usd:+t.usd||0,mcap:+t.mcapUsd,pre,impactPct:(+t.impactBps||0)/100,trader:t.trader||null,mine:!!t.mine}; });
  // ---- sim clock + deterministic timers
  let clockMs=0, timerId=0; const timers=[];
  const addTimer=(fn,ms,rep)=>{ const id=++timerId; timers.push({id,at:clockMs+Math.max(0,+ms||0),ms:Math.max(1,+ms||0),fn,rep}); return id; };
  const clearTimer=id=>{ const k=timers.findIndex(t=>t.id===id); if(k>=0) timers.splice(k,1); };
  const runTimers=()=>{ for(let guard=0;guard<1000;guard++){ let k=-1; for(let i=0;i<timers.length;i++) if(timers[i].at<=clockMs&&(k<0||timers[i].at<timers[k].at||(timers[i].at===timers[k].at&&timers[i].id<timers[k].id))) k=i;
    if(k<0) return; const t=timers[k]; if(t.rep) t.at+=t.ms; else timers.splice(k,1); try{ t.fn(); }catch(e){ console.warn('[replay] timer',e); } } };
  const RNG=mulberry32(seed), M=Object.create(Math); M.random=RNG;
  class SimDate extends Date { constructor(...a){ if(a.length) super(...a); else super((o.dateBase||0)+clockMs); } static now(){ return (o.dateBase||0)+clockMs; } }
  // ---- sandbox window
  const listeners={}, store=new Map([['disciple.sim','off'],['disciple.orbs','off'],['disciple.chartmap','on']]);
  const cbs={trade:[],bomb:[],tier:[],frame:[]}; const fire=(k,d)=>{ (cbs[k]||[]).slice().forEach(f=>{ try{ f(d); }catch(e){ console.warn(e); } }); };
  const cv=o.canvas||document.createElement('canvas');
  const wrap={clientWidth:W,clientHeight:H,style:{}}, stubEl={style:{},classList:{toggle(){},add(){},remove(){}},addEventListener(){},removeEventListener(){},blur(){},textContent:''};
  const sb={
    Math:M, Date:SimDate, performance:{now:()=>clockMs}, devicePixelRatio:1, innerWidth:W, innerHeight:H,
    setTimeout:(f,ms)=>addTimer(f,ms,false), setInterval:(f,ms)=>addTimer(f,ms,true), clearTimeout:clearTimer, clearInterval:clearTimer,
    requestAnimationFrame:()=>0, cancelAnimationFrame(){},
    addEventListener:(k,f)=>{ (listeners[k]||(listeners[k]=[])).push(f); }, removeEventListener:(k,f)=>{ const a=listeners[k]; if(a){ const i=a.indexOf(f); if(i>=0) a.splice(i,1); } },
    dispatchEvent:e=>{ (listeners[e.type]||[]).slice().forEach(f=>{ try{ f(e); }catch(_){} }); return true; },
    localStorage:{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)},
    fetch:()=>Promise.reject(new Error('replay: no network')),
    location:{search:'',href:'about:replay',pathname:'/replay',origin:''},
    document:{ hidden:false, head:stubEl, body:stubEl, addEventListener(){}, removeEventListener(){},
      getElementById:id=>id==='c'?cv:id==='wrap'?wrap:stubEl, createElement:t=>document.createElement(t) },
    Q_OVERRIDE:new URLSearchParams({source:'hook',capture:'1',fixedDt:String(fps),dpr:'1',clean:o.clean?'1':'0',ticker:o.ticker||'',candleSec:String(Math.max(0.1,dur/36))}),
    __DISCIPLE_BASE_PATH__:base(),
    __flightHookOpts:{name:'REPLAY',supply,ticker:o.ticker||'',startMcap},
    __flightHook:(k,d)=>fire(k,Object.assign({t:clockMs/1000},d)),
  };
  sb.window=sb.self=sb.globalThis=sb;
  const proxy=new Proxy(sb,{ has:(t,k)=>k in t, get:(t,k)=>k===Symbol.unscopables?undefined:t[k], set:(t,k,v)=>{ t[k]=v; return true; } });
  const src=await engineSrc();
  // eslint-disable-next-line no-new-func
  new Function('__sb','with(__sb){\n'+src+'\n}')(proxy);
  const F=sb.__flight; if(!F||!sb.__flightFeed) throw new Error('replay: engine failed to boot');
  // seed price, then wait for the engine's image assets (the only async part)
  sb.__flightFeed({t:'swap',block:0,ts:0,txHash:'(start)',side:'buy',usd:0,mcap:startMcap,price:startMcap/supply});
  const t0w=performance.now(); while(!F.assetsReady()){ if(performance.now()-t0w>20000) throw new Error('replay: assets timeout'); await new Promise(r=>setTimeout(r,25)); }
  // ---- driver
  let frame=0, next=0, disposed=false; const shownMine=[];
  const ctx=cv.getContext('2d');
  function drawMine(){   // 'mine' trades: big callout on top of the engine frame (replay-only, deterministic)
    const now=clockMs/1000;
    for(const m of shownMine){ const age=now-m.at; if(age<0||age>1.6) continue; const a=Math.min(1,(1.6-age)/0.4)*Math.min(1,age/0.12), s=W/1080;
      const y=H*0.30-age*40*s, buy=m.side==='buy', txt=(buy?'YOU BOUGHT ':'YOU SOLD ')+fmtUsd(m.usd);
      ctx.save(); ctx.globalAlpha=a; ctx.font=`bold ${Math.round(56*s)}px ui-monospace,monospace`; ctx.textAlign='center';
      const tw=ctx.measureText(txt).width+60*s; ctx.fillStyle='rgba(8,10,20,.72)'; ctx.fillRect(W/2-tw/2,y-62*s,tw,86*s);
      ctx.strokeStyle=buy?'#3ddc97':'#ff5c7a'; ctx.lineWidth=4*s; ctx.strokeRect(W/2-tw/2,y-62*s,tw,86*s);
      ctx.fillStyle=buy?'#9ff3c8':'#ffb0c8'; ctx.fillText(txt,W/2,y); ctx.restore(); }
  }
  const r={ canvas:cv, frames, fps, width:W, height:H, seed, trades,
    step(){ if(disposed||frame>=frames) return null;
      clockMs=frame*frameMs; const t=clockMs/1000;
      while(next<trades.length&&trades[next].at<=t){ const x=trades[next++];
        sb.__flightFeed({t:'block',block:x.i+1,ts:clockMs});
        sb.__flightFeed({t:'swap',block:x.i+1,ts:clockMs,txHash:x.tx,side:x.side,usd:x.usd,mcap:x.mcap,price:x.mcap/supply,prePrice:x.pre/supply,postPrice:x.mcap/supply,impactPct:x.impactPct,trader:x.trader,mine:x.mine});
        if(x.mine) shownMine.push({at:t,side:x.side,usd:x.usd});
        fire('trade',Object.assign({t},x)); }
      runTimers(); F.step(1); drawMine();
      const d={i:frame,t,done:frame+1>=frames}; frame++; fire('frame',d); return d; },
    stateAt(t){ t=+t||0; let m=startMcap, n=0; for(const x of trades){ if(x.at>t) break; m=x.mcap; n++; } const ti=tierOf(m);
      return {t,mcap:m,tier:ti,tierName:TIER_NAMES[ti],tradesSoFar:n,frame:Math.min(frames-1,Math.floor(t*fps))}; },
    on(k,cb){ (cbs[k]||(cbs[k]=[])).push(cb); return ()=>{ const a=cbs[k]; const i=a.indexOf(cb); if(i>=0) a.splice(i,1); }; },
    hash(){ const d=ctx.getImageData(0,0,cv.width,cv.height).data; let h=2166136261>>>0; const u=new Uint32Array(d.buffer,d.byteOffset,d.byteLength>>2);
      for(let i=0;i<u.length;i++){ h^=u[i]; h=Math.imul(h,16777619); } return (h>>>0).toString(16).padStart(8,'0'); },
    dispose(){ disposed=true; try{ F.source&&F.source.stop&&F.source.stop(); }catch(_){} timers.length=0; for(const k in listeners) delete listeners[k]; for(const k in cbs) cbs[k]=[]; if(!o.canvas){ cv.width=cv.height=0; } },
  };
  return r;
}
window.__flightReplay=replay;
})();
