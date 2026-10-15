/* DISCIPLE flight engine — ported from prototype/game.html (faithful port).
 * Prerequisites on the page: #c canvas, #orbBtn, #launchFade, optional #exitX.
 * Set window.REPLAY before running, or fetch /replay.json.
 * Query string: ?replay=1&speed=&zoom=&source=&coin=&launched=1&debugBomb=
 */
(function(){
'use strict';
/* =====================================================================
   DISCIPLE flight prototype — single file, no build step, runs offline.
   Data source: default = LIVE real pool (AI/WETH Uniswap v3 on Robinhood Chain, RPC getLogs)
   ?replay=1[&speed=4]  replay of 30 min of real swaps (replay.js)   ?source=mock | dexscreener | rpc
   ?zoom=N altitude zoom (default 10 for the real pool)
   ===================================================================== */
const W = 1280, H = 720;                       // logical 16:9 canvas
const Q = (typeof Q_OVERRIDE !== "undefined" && Q_OVERRIDE) ? Q_OVERRIDE : new URLSearchParams(location.search);

// ---------- [PARAM] tier ladder (USD market-cap lower bounds) ----------
const TIERS = [
  // DISCIPLE constitution tier ladder (LOCKED 2026-10-15, re-priced).
  // Non-overlapping half-open [lo, hi). Start $7K → graduation Pearly Gates $33K
  // (single CPAMM, 72% sold ≈ $10.9K USDG raised). Seventh Heaven caps at $7.77B;
  // beyond that altitude continues as prestige (2× spans).
  {name:'LAUNCH PAD',      lo: 7e3,     hi: 12e3,    bg:'tier0'},
  {name:'LIMBO',           lo: 12e3,    hi: 18e3,    bg:'tier1'},
  {name:'ASCENSION',       lo: 18e3,    hi: 25e3,    bg:'tier2'},
  {name:'NARROW GATE',     lo: 25e3,    hi: 33e3,    bg:'tier3'},
  {name:'PEARLY GATES',    lo: 33e3,    hi: 55e3,    bg:'tier4'},
  {name:'FIRMAMENT',       lo: 55e3,    hi: 100e3,   bg:'tier5'},
  {name:'ANGELS',          lo: 100e3,   hi: 333e3,   bg:'tier6'},
  {name:'ARCHANGELS',      lo: 333e3,   hi: 777e3,   bg:'tier7'},
  {name:'HEAVENLY HOST',   lo: 777e3,   hi: 1.2e6,   bg:'tier8'},
  {name:'MORNING STARS',   lo: 1.2e6,   hi: 3.3e6,   bg:'tier9'},
  {name:'VIRTUES',         lo: 3.3e6,   hi: 7.7e6,   bg:'tier0'},
  {name:'DOMINIONS',       lo: 7.7e6,   hi: 33e6,    bg:'tier1'},
  {name:'THRONE ROOM',     lo: 33e6,    hi: 77e6,    bg:'tier2'},
  {name:'CHERUBIM',        lo: 77e6,    hi: 120e6,   bg:'tier3'},
  {name:'SERAPHIM',        lo: 120e6,   hi: 777e6,   bg:'tier4'},
  {name:'AETHER',          lo: 777e6,   hi: 1.2e9,   bg:'tier5'},
  {name:'EMPYREAN',        lo: 1.2e9,   hi: 3.3e9,   bg:'tier6'},
  {name:'SEVENTH HEAVEN',  lo: 3.3e9,   hi: 7.77e9,  bg:'tier7'},
];
const FLOOR_MCAP = 7e3;          // constitution start mcap / log-scale floor for tier 0
const GRADUATION_MCAP = 33e3;    // Pearly Gates open = graduation
const CURVE_SOLD_PCT = 72;       // % of supply sold on curve at graduation
const EMPYREAN_SPAN = 2;         // prestige beyond Seventh Heaven cap: frac per 2× mcap

// altitude: integer part = tier index, fractional = log position inside tier
function mcapToAlt(m){
  m = Math.max(m, FLOOR_MCAP);
  for (let i=0;i<TIERS.length;i++){
    const t=TIERS[i];
    if (i===TIERS.length-1){
      // Seventh Heaven [lo, hi); prestige continues above hi
      if (m < t.hi) return i + Math.log(m/t.lo)/Math.log(t.hi/t.lo);
      return i + 1 + Math.log(m/t.hi)/Math.log(EMPYREAN_SPAN);
    }
    if (m < t.hi){
      const lo = i===0?FLOOR_MCAP:t.lo;
      return i + Math.log(m/lo)/Math.log(t.hi/lo);
    }
  }
}
function altToMcap(a){
  const i=Math.max(0,Math.min(TIERS.length-1,Math.floor(a))), f=a-i, t=TIERS[i];
  if (i===TIERS.length-1){
    if (f < 1) return t.lo*Math.pow(t.hi/t.lo,f);
    return t.hi*Math.pow(EMPYREAN_SPAN,f-1);
  }
  const lo=i===0?FLOOR_MCAP:t.lo; return lo*Math.pow(t.hi/lo,f);
}
const PX_PER_ALT = 1.5*H*(+new URLSearchParams(location.search).get('zoom') || (['mock','dexscreener','rpc'].includes(new URLSearchParams(location.search).get('source'))?1:10));   // real pool: ×10 so a ~1% move ≈ 150 px
// ---------- [PARAM] MODES = $ per shot (see game-modes-and-progression.md §1) ----------
const MODES=[
  {key:'1',name:'FEATHER',  usd:0.01, range:'swarm label'},
  {key:'2',name:'EMBER',    usd:0.50, range:'swarm label'},
  {key:'3',name:'FLARE',    usd:5,    range:'Launch Pad–Narrow Gate'},
  {key:'4',name:'COMET',    usd:10,   range:'Pearly Gates–Angels'},
  {key:'5',name:'ARCHANGEL',usd:100,  range:'Angels–Virtues'},
  {key:'6',name:'GLORY',    usd:1000, range:'≥$33M (Dominions+)'},
];
// [MEASURED 2026-10-15 ~09:37 CT] executor swap gas ≈ 200K (v4 swap ~168K + vault ledger ~30K) × eth_gasPrice × ETH $2,372
const CHAIN_GAS={robinhood:{gwei:0.0207,label:'RH'},arbitrum:{gwei:0.020,label:'ARB'},base:{gwei:0.006,label:'BASE'}};
const CHAIN=CHAIN_GAS[Q.get('chain')]||CHAIN_GAS.robinhood, EXEC_GAS=200e3, ETH_USD=2372;
const GAS_USD=EXEC_GAS*CHAIN.gwei*1e-9*ETH_USD;   // ≈ $0.0098 on RH
const MAX_GAS_OVERHEAD=0.05;                       // [PARAM] min shot = gas / 5%
const MIN_SHOT=GAS_USD/MAX_GAS_OVERHEAD;           // ≈ $0.20 on RH/ARB, ≈ $0.06 on Base
const PROMO_GAS=false;                             // no gas sponsorship: shots below the min are blocked
// auto label: shot* ≈ 0.1% of quote depth x (≈0.2% price per press), snapped to nearest mode (log distance)
function autoMode(m){ const x=m<=50e3?Math.sqrt(Math.max(m,2e3)*5000):0.09*m, t=0.001*x;
  let b=0; MODES.forEach((md,i)=>{ if(Math.abs(Math.log(md.usd/t))<Math.abs(Math.log(MODES[b].usd/t))) b=i; }); return b; }
const LANES=[W/2-260,W/2,W/2+260];
// [PARAM] orb table (off-chain points layer; see game-modes-and-progression.md §6)
const ORB={
  halo: {pts:5,  r:14, c0:'rgba(255,245,200,.95)', c1:'rgba(255,220,140,0)', rim:'#ffe7a3'},
  mult: {pts:5,  r:16, c0:'rgba(200,235,255,.95)', c1:'rgba(120,180,255,0)', rim:'#9fd8ff'},
  rhalo:{pts:20, r:18, c0:'rgba(255,255,255,1)',   c1:'rgba(255,240,180,0)', rim:'#ffffff'},
  storm:{pts:25, r:22, c0:'rgba(10,0,4,.95)', c1:'rgba(140,10,24,.75)', rim:'#ff3344', tag:'STORM −25'},
  void: {pts:10, r:22, c0:'rgba(0,0,0,1)',    c1:'rgba(60,0,40,.8)',   rim:'#b02a6a', tag:'VOID · slow'},
};
// [PARAM] orb spawn: sparse by design (~1 orb / 8–15 s total, ≤2 on screen, penalties rarer)
const ORB_SPAWN={rewardBase:0.07, rewardFlow:0.02, rewardMax:0.10, penaltyBase:0.015, penaltyFlow:0.01, penaltyMax:0.03, maxOnScreen:2, minGap:4};
const fmtShot=v=>v<1?'$'+v.toFixed(2):'$'+v.toFixed(0);        // screen px per tier of altitude

// ---------- utils ----------
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const lerp=(a,b,t)=>a+(b-a)*t;
const fmtUsd=v=>v>=1e9?'$'+(v/1e9).toFixed(2)+'B':v>=1e6?'$'+(v/1e6).toFixed(2)+'M':v>=1e3?'$'+(v/1e3).toFixed(1)+'K':'$'+v.toFixed(0);
function hash(n){n=Math.sin(n*127.1+311.7)*43758.5453;return n-Math.floor(n);}
function randn(){return Math.sqrt(-2*Math.log(Math.random()+1e-9))*Math.cos(6.2831853*Math.random());}

/* =====================================================================
   DATA-SOURCE INTERFACE
   start(emit) → emit(event)   stop()   submitTrade?(side, usd) → Promise
   Events (same schema the relay sends, see flight-framework.md §6):
     {t:'block', block, ts}
     {t:'swap', block, ts, txHash, side:'buy'|'sell', usd, mcap, price, mine?}
     {t:'depth', block, mcap, levels:[{mcap, usd, side:'bid'|'ask', src:'amm'|'hook'}]}
     {t:'status', source, ok, msg}
   ===================================================================== */
class MockReplaySource {
  constructor(){ this.name='MOCK REPLAY'; this.block=89_266_000; this.mcap=+(Q.get('start')||7200); this.supply=1e9;
    this.levels=[]; this.turbo=false; this.idleUntil=0; this.nextTrade=0; }
  start(emit){
    this.emit=emit; this.seedDepth(); const tickMs=100;            // RH ≈100 ms blocks
    this.iv=setInterval(()=>this.onBlock(), tickMs);
    emit({t:'status',source:this.name,ok:true,msg:'simulated feed · 100ms blocks'});
  }
  stop(){clearInterval(this.iv);}
  liq(){ return Math.max(3000, this.mcap*0.18); }                  // pseudo quote-side liquidity $
  impact(usd, side){ // constant-product: price ratio = (1+dx/x)^2, x = quote reserve
    const x=this.liq()/2, r=Math.pow(1+usd/x,2); return side==='buy'? r : 1/Math.pow(1+usd/x,2); }
  seedDepth(){
    this.levels = this.levels.filter(l=>Math.abs(Math.log(l.mcap/this.mcap))<0.6);
    while(this.levels.length<16){
      const ask=Math.random()<0.5, d=0.03+Math.random()*0.45;
      const hook=Math.random()<0.3;
      this.levels.push({id:Math.random(), side:ask?'ask':'bid', src:hook?'hook':'amm',
        mcap:this.mcap*(ask?1+d:1/(1+d)), usd:(hook?3:1)*this.liq()*0.05*Math.exp(randn()*0.9)});
    }
  }
  onBlock(){
    this.block++; const now=performance.now();
    this.emit({t:'block',block:this.block,ts:Date.now()});
    if (now<this.idleUntil) return;                                  // quiet market → no swaps, rocket holds
    if (Math.random()<0.004){ this.idleUntil=now+3000+Math.random()*5000; return; }
    const rate = this.turbo?0.35:0.06;                               // trades per block
    if (Math.random()<rate){
      const drift=this.turbo?0.66:0.53;
      const side=Math.random()<drift?'buy':'sell';
      const usd=Math.exp(Math.log(40)+randn()*1.1)*(this.turbo?4:1);
      this.applyTrade(side,usd,false);
    }
    if (this.block%10===0){ this.seedDepth(); this.emitDepth(); }
  }
  applyTrade(side,usd,mine,txHash){
    const before=this.mcap; let after=before*this.impact(usd,side);
    // walls/trampolines absorb: crossing a level consumes it and damps the move
    for (const l of this.levels){
      const crossed = side==='buy' ? (l.side==='ask' && l.mcap>before && l.mcap<=after)
                                   : (l.side==='bid' && l.mcap<before && l.mcap>=after);
      if (crossed){ const eat=Math.min(usd,l.usd); l.usd-=eat; usd-=eat;
        if (l.usd<=1){ l.dead=true; this.emit({t:'levelFilled',level:l}); }
        if (usd<=0){ after=l.mcap; break; } }
    }
    this.levels=this.levels.filter(l=>!l.dead);
    this.mcap=after;
    this.emit({t:'swap',block:this.block,ts:Date.now(),txHash:txHash||'0x'+Math.random().toString(16).slice(2,10),
      side,usd,mcap:this.mcap,price:this.mcap/this.supply,mine});
    this.emitDepth();
  }
  emitDepth(){ this.emit({t:'depth',block:this.block,mcap:this.mcap,levels:this.levels.map(l=>({...l}))}); }
  // Mock "session-key" trade: sequencer soft-confirm after a simulated block delay
  submitTrade(side,usd){
    const hash='0x'+Math.random().toString(16).slice(2,14);
    const delay=180+Math.random()*700;          // bundler + 1-3 RH blocks
    return new Promise(res=>setTimeout(()=>{
      if (Math.random()<0.06) return res({ok:false,hash,reason:'slippage guard (amountOutMin)'});
      this.applyTrade(side,usd,true,hash); res({ok:true,hash,block:this.block});
    },delay)).then(r=>r).catch(e=>({ok:false,hash,reason:String(e)}));
  }
}

/* DexScreener polling adapter — real endpoint, verified 2026-10-15:
   GET https://api.dexscreener.com/latest/dex/pairs/{chainId}/{pairId}
   chainId "robinhood" works; v4 pairs use the 32-byte poolId as pairId.
   Poll ≤1/s (published per-endpoint limit not shown for /pairs; 60 rpm limits on other endpoints). */
class DexScreenerSource {
  constructor(chain,pair,ms=1500){this.name='DEXSCREENER';this.chain=chain;this.pair=pair;this.ms=ms;this.last=null;this.block=0;}
  start(emit){ this.emit=emit; const tick=async()=>{
      try{ const r=await fetch(`https://api.dexscreener.com/latest/dex/pairs/${this.chain}/${this.pair}`);
        if(!r.ok) throw new Error('HTTP '+r.status);
        const j=await r.json(); const p=(j.pairs||[])[0]; if(!p) throw new Error('pair not found');
        const mcap=p.marketCap||p.fdv; const price=+p.priceUsd; this.block++;
        emit({t:'block',block:this.block,ts:Date.now()});
        if (this.last!==null && mcap!==this.last){
          emit({t:'swap',block:this.block,ts:Date.now(),txHash:'(aggregated)',side:mcap>this.last?'buy':'sell',
                usd:Math.abs(mcap-this.last)*0.01,mcap,price}); }
        else if (this.last===null) emit({t:'swap',block:0,ts:Date.now(),txHash:'(snapshot)',side:'buy',usd:0,mcap,price});
        this.last=mcap; emit({t:'status',source:this.name,ok:true,msg:`${p.baseToken.symbol}/${p.quoteToken.symbol} ${p.dexId} ${(p.labels||[]).join(',')}`});
      }catch(e){ emit({t:'status',source:this.name,ok:false,msg:String(e.message||e)}); }
    }; tick(); this.iv=setInterval(tick,this.ms); }
  stop(){clearInterval(this.iv);}
}

/* Direct RPC adapter — Uniswap v4 PoolManager Swap logs + StateView.getSlot0.
   Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,
        uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)
   topic0 = 0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f
   wss (eth_subscribe "logs") when a WS URL is given (e.g. Alchemy wss://robinhood-mainnet.g.alchemy.com/v2/KEY),
   otherwise eth_getLogs polling over HTTP (Robinhood public RPC has no WS). */
const RH = { chainId:4663, poolManager:'0x8366a39cc670b4001a1121b8f6a443a643e40951',
             stateView:'0xf3334192d15450cdd385c8b70e03f9a6bd9e673b', http:'https://rpc.mainnet.chain.robinhood.com' };
const SWAP_TOPIC='0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
class RpcSource {
  // opts: {http, ws, poolManager, poolId, dec0, dec1, supply, quoteUsd, tokenIs0}
  constructor(o){ this.name='RPC'; Object.assign(this,{http:RH.http,poolManager:RH.poolManager,dec0:18,dec1:6,supply:1e9,quoteUsd:1,tokenIs0:true},o); }
  priceFromSqrt(sqrtHex){ const s=Number(BigInt(sqrtHex))/2**96; let p1per0=s*s*10**(this.dec0-this.dec1);
    return this.tokenIs0? p1per0*this.quoteUsd : (1/p1per0)*this.quoteUsd; }
  decode(log){ const d=log.data.slice(2), w=i=>'0x'+d.slice(64*i,64*i+64);
    const a0=BigInt.asIntN(128,BigInt(w(0))), a1=BigInt.asIntN(128,BigInt(w(1))), price=this.priceFromSqrt(w(2));
    // v4 Swap amounts are the swapper's BalanceDelta: negative = swapper paid that currency into the pool
    const tokIn = this.tokenIs0 ? a0<0n : a1<0n;     // swapper paid the launch token → SELL
    return {t:'swap',block:parseInt(log.blockNumber,16),ts:Date.now(),txHash:log.transactionHash,
            side: tokIn?'sell':'buy', usd:Math.abs(Number(this.tokenIs0?a1:a0))/10**(this.tokenIs0?this.dec1:this.dec0)*this.quoteUsd,
            mcap:price*this.supply, price, removed:!!log.removed}; }
  async rpc(m,p){ const r=await fetch(this.http,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})}); const j=await r.json(); if(j.error) throw new Error(j.error.message); return j.result; }
  start(emit){ this.emit=emit; const filter={address:this.poolManager,topics:[SWAP_TOPIC,this.poolId]};
    if (this.ws){ const s=new WebSocket(this.ws); this.sock=s;
      s.onopen=()=>{ s.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_subscribe',params:['logs',filter]}));
                     s.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'eth_subscribe',params:['newHeads']})); emit({t:'status',source:'RPC-WS',ok:true,msg:'subscribed'}); };
      s.onmessage=e=>{ const m=JSON.parse(e.data); const r=m.params&&m.params.result; if(!r) return;
        if (r.topics) emit(this.decode(r)); else if (r.number) emit({t:'block',block:parseInt(r.number,16),ts:Date.now()}); };
      s.onerror=()=>emit({t:'status',source:'RPC-WS',ok:false,msg:'ws error'});
      return; }
    let from=null; const poll=async()=>{ try{
        const head=parseInt(await this.rpc('eth_blockNumber',[]),16); if(from===null) from=head-50;
        if (head>=from){ const logs=await this.rpc('eth_getLogs',[{...filter,fromBlock:'0x'+from.toString(16),toBlock:'0x'+head.toString(16)}]);
          logs.forEach(l=>emit(this.decode(l))); from=head+1; }
        emit({t:'block',block:head,ts:Date.now()}); emit({t:'status',source:'RPC-HTTP',ok:true,msg:'polling getLogs'});
      }catch(e){ emit({t:'status',source:'RPC-HTTP',ok:false,msg:String(e.message||e)}); } };
    poll(); this.iv=setInterval(poll,1000); }
  stop(){ clearInterval(this.iv); this.sock&&this.sock.close(); }
}

/* =====================================================================
   REAL POOL: AI/WETH Uniswap v3 (1% fee, tickSpacing 200) on Robinhood Chain (chainId 4663)
   pool 0xc4a21f9d6485fc5893dd4a491b320a83daf4da1d · token0 WETH · token1 AI (Artificial Inu)
   Altitude = real price (mcap = price × totalSupply). Other traders' swaps move the rocket.
   Player shots are PAPER: simulated locally with v3 math on the pool's current liquidity,
   applied as a multiplicative offset on top of real price that decays (τ 20 s, stand-in for arbitrage).
   ===================================================================== */
const POOL={addr:'0xc4a21f9d6485fc5893dd4a491b320a83daf4da1d', http:RH.http, dec0:18, dec1:18, spacing:200,
  topic:'0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'};  // v3 Swap(address,address,int256,int256,uint160,uint128,int24)
const short=a=>a? a.slice(0,6)+'…'+a.slice(-4) : '?';
const i256=h=>BigInt.asIntN(256,BigInt('0x'+h));
class PoolV3Base {
  constructor(){ this.paper=1; this.real=null; this.L=null; this.levels=[]; this.supply=(window.REPLAY&&REPLAY.totalSupply)||null; this.ethUsd=(window.REPLAY&&REPLAY.ethUsd)||null; }
  mcap(){ return this.real*this.supply*this.paper; }
  sideOf(l){ return l.mcap>this.mcap()?'ask':'bid'; }
  emitDepth(){ this.emit({t:'depth',block:this.block,mcap:this.mcap(),levels:this.levels.map(l=>({...l,side:this.sideOf(l),src:'amm'}))}); }
  crossCheck(before,after){ for(const l of this.levels){ if((l.mcap-before)*(l.mcap-after)<0) this.emit({t:'levelFilled',level:{...l,side:after>before?'ask':'bid',src:'amm'}}); } }
  startPaperDecay(){ this.dv=setInterval(()=>{ if(this.real===null||this.paper===1) return; const b=this.mcap();
      this.paper=1+(this.paper-1)*Math.exp(-0.25/20); if(Math.abs(this.paper-1)<1e-5) this.paper=1; this.emit({t:'mark',mcap:this.mcap()}); this.crossCheck(b,this.mcap()); },250); }
  applyReal(s){ const b=this.real===null?null:this.mcap(), pre=this.real; this.real=s.price; if(s.liquidity) this.L=Number(s.liquidity); this.block=s.block;
    const m=this.mcap(); if(b!==null) this.crossCheck(b,m);
    this.emit({t:'swap',block:s.block,ts:s.ts*1000,txHash:s.tx,side:s.side,usd:s.usd,mcap:m,price:s.price,prePrice:pre,postPrice:s.price,impactPct:s.impactPct,trader:s.trader});
    this.emitDepth(); }
  // v3 in-range impact (token0=WETH, token1=AI). raw sqrtP = sqrt(AI per WETH) since both have 18 decimals.
  impact(usd,side){ if(!this.L) return 1; const sq=Math.sqrt(this.ethUsd/(this.real*this.paper));
    if(side==='buy'){ const dx=usd/this.ethUsd*1e18; return Math.pow(1+dx*sq/this.L,2); }
    const dy=usd/(this.real*this.paper)*1e18; return Math.pow(sq/(sq+dy/this.L),2); }
  submitTrade(side,usd){ const hash='paper-'+Math.random().toString(16).slice(2,10);
    return new Promise(res=>setTimeout(()=>{ const b=this.mcap(); this.paper*=this.impact(usd,side); const m=this.mcap(); this.crossCheck(b,m);
      this.emit({t:'swap',block:this.block,ts:Date.now(),txHash:hash,side,usd,mcap:m,price:m/this.supply,prePrice:b/this.supply,postPrice:m/this.supply,impactSrc:'v3sim',mine:true,trader:'you'}); this.emitDepth();
      res({ok:true,hash,block:this.block}); },150+Math.random()*250)); }
  stop(){ clearInterval(this.iv); clearInterval(this.dv); }
}
class ReplaySource extends PoolV3Base {
  constructor(data){ super(); this.D=data; this.name='REPLAY · real swaps'; this.speeds=[1,4,16,60]; this.si=Math.max(0,this.speeds.indexOf(+(Q.get('speed')||1))); if(Q.get('speed')&&this.si===0&&+Q.get('speed')!==1){ this.speeds.unshift(+Q.get('speed')); } }
  get speed(){ return this.speeds[this.si]; }
  faster(){ this.si=(this.si+1)%this.speeds.length; }
  start(emit){ this.emit=emit; const D=this.D; this.supply=D.totalSupply; this.ethUsd=D.ethUsd;
    this.levels=D.levels.map(l=>({id:l.tick,mcap:l.mcap,usd:l.usd,tick:l.tick}));
    const reset=()=>{ this.i=0; this.paper=1; this.real=null; this.clock=(D.swaps[0]?D.swaps[0].ts:D.fromTs)-2; this.blk=D.fromBlock; };
    reset(); let lastT=performance.now(), endAt=0;
    this.iv=setInterval(()=>{ const now=performance.now(), dt=(now-lastT)/1000; lastT=now; this.clock+=dt*this.speed;
      const span=D.toTs-D.fromTs, blk=Math.round(D.fromBlock+(D.toBlock-D.fromBlock)*clamp((this.clock-D.fromTs)/span,0,1));
      if(blk!==this.blk){ this.blk=blk; if(this.real!==null) this.block=blk; emit({t:'block',block:blk,ts:this.clock*1000}); }
      while(this.i<D.swaps.length && D.swaps[this.i].ts<=this.clock) this.applyReal(D.swaps[this.i++]);
      const d=new Date(this.clock*1000).toLocaleTimeString('en-US',{timeZone:'America/Chicago',hour12:false});
      emit({t:'status',source:this.name,ok:true,msg:`${d} CT ×${this.speed} · ${this.i}/${D.swaps.length} swaps (F faster)`});
      if(this.i>=D.swaps.length && this.clock>=D.toTs){ if(!endAt) endAt=now+3000; else if(now>endAt){ endAt=0; reset(); emit({t:'replayRestart'}); } }
    },50);
    this.startPaperDecay(); }
}
class PoolLiveSource extends PoolV3Base {
  constructor(){ super(); this.name='LIVE · RH RPC getLogs'; this.fails=0; this.got=false; }
  async rpcBatch(calls){ const r=await fetch(POOL.http,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(calls.map(([m,p],i)=>({jsonrpc:'2.0',id:i,method:m,params:p})))}); if(!r.ok) throw new Error('RPC HTTP '+r.status);
    const j=(await r.json()).sort((a,b)=>a.id-b.id); for(const x of j) if(x.error) throw new Error(x.error.message); return j.map(x=>x.result); }
  async rpc(m,p){ return (await this.rpcBatch([[m,p]]))[0]; }
  async init(){
    if(!this.ethUsd||!this.supply){ const r=await fetch('https://api.dexscreener.com/latest/dex/pairs/robinhood/'+POOL.addr); const p=(await r.json()).pairs[0];
      this.ethUsd=+p.priceUsd/+p.priceNative; if(!this.supply) this.supply=p.fdv/+p.priceUsd; }
    else { try{ const r=await fetch('https://api.dexscreener.com/latest/dex/pairs/robinhood/'+POOL.addr); const p=(await r.json()).pairs[0]; this.ethUsd=+p.priceUsd/+p.priceNative; }catch(_){} }
    const [s0,L,head]=await this.rpcBatch([['eth_call',[{to:POOL.addr,data:'0x3850c7bd'},'latest']],['eth_call',[{to:POOL.addr,data:'0x1a686502'},'latest']],['eth_blockNumber',[]]]);
    const sq=Number(BigInt('0x'+s0.slice(2,66)))/2**96, tick=Number(i256(s0.slice(66,130)));
    this.L=Number(BigInt(L)); this.real=this.ethUsd/(sq*sq); this.block=parseInt(head,16); this.from=this.block-3000;   // ~5 min of recent swaps at ~0.1 s blocks
    this.emit({t:'swap',block:this.block,ts:Date.now(),txHash:'(slot0)',side:'buy',usd:0,mcap:this.mcap(),price:this.real});
    // liquidity bands: initialized ticks ±40 spacings around current tick
    const base=Math.floor(tick/POOL.spacing)*POOL.spacing, tks=[]; for(let k=-40;k<=40;k++) tks.push(base+k*POOL.spacing);
    for(let i=0;i<tks.length;i+=10){ const res=await this.rpcBatch(tks.slice(i,i+10).map(t=>['eth_call',[{to:POOL.addr,data:'0xf30dba93'+BigInt.asUintN(256,BigInt(t)).toString(16).padStart(64,'0')},'latest']]));
      res.forEach((r,j)=>{ const t=tks[i+j], gross=BigInt('0x'+r.slice(2,66)); if(gross===0n) return; const net=Math.abs(Number(i256(r.slice(66,130))));
        const sa=Math.pow(1.0001,t/2), sb=Math.pow(1.0001,(t+POOL.spacing)/2), pr=this.ethUsd/Math.pow(1.0001,t);
        this.levels.push({id:t,tick:t,mcap:pr*this.supply,usd:net*(1/sa-1/sb)/1e18*this.ethUsd}); }); }
    this.emitDepth(); }
  decode(l){ const d=l.data.slice(2), w=i=>d.slice(64*i,64*i+64); const a0=i256(w(0)), a1=i256(w(1)), sq=Number(BigInt('0x'+w(2)))/2**96;
    return {block:parseInt(l.blockNumber,16),ts:Date.now()/1000,tx:l.transactionHash,side:a1<0n?'buy':'sell',
      usd:Math.abs(Number(a0))/1e18*this.ethUsd,price:this.ethUsd/(sq*sq),liquidity:BigInt('0x'+w(3)).toString(),removed:l.removed}; }
  start(emit){ this.emit=emit;
    const poll=async()=>{ if(this.busy) return; this.busy=true; try{
        if(!this.got){ await this.init(); this.got=true; }
        const head=parseInt(await this.rpc('eth_blockNumber',[]),16);
        if(head>=this.from){ const to=Math.min(head,this.from+20000);
          const logs=await this.rpc('eth_getLogs',[{address:POOL.addr,topics:[POOL.topic],fromBlock:'0x'+this.from.toString(16),toBlock:'0x'+to.toString(16)}]);
          const txs=[...new Set(logs.map(l=>l.transactionHash))], from={};
          if(txs.length){ const r=await this.rpcBatch(txs.map(h=>['eth_getTransactionByHash',[h]])); txs.forEach((h,i)=>from[h]=r[i]&&r[i].from); }
          for(const l of logs){ const s=this.decode(l); if(s.removed){ emit({t:'swap',removed:true,txHash:s.tx}); continue; } s.trader=from[s.tx]; this.applyReal(s); }
          this.from=to+1; }
        this.block=head; emit({t:'block',block:head,ts:Date.now()}); this.fails=0;
        emit({t:'status',source:this.name,ok:true,msg:'live · polling 1s'});
      }catch(e){ this.fails++; emit({t:'status',source:this.name,ok:false,msg:String(e.message||e)});
        if(!this.got && this.fails>=3 && window.REPLAY){ this.stop(); emit({t:'status',source:'LIVE FAILED → REPLAY',ok:false,msg:String(e.message||e)}); const r=new ReplaySource(REPLAY); window.__flight&&(window.__flight.source=r); r.start(emit); } } finally{ this.busy=false; } };
    poll(); this.iv=setInterval(poll,1000); this.startPaperDecay(); }
}

const IS_POOL=!['mock','dexscreener','rpc'].includes(Q.get('source')||'pool');
function makeSource(){
  const s=Q.get('source')||'pool';
  if (Q.get('replay')==='1'||s==='replay'){ if(window.REPLAY) return new ReplaySource(REPLAY); }
  if (s==='pool') return new PoolLiveSource();
  if (s==='dexscreener') return new DexScreenerSource(Q.get('chain')||'robinhood', Q.get('pair')||'0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a');
  if (s==='rpc') return new RpcSource({poolId:Q.get('pool'),ws:Q.get('ws')||null,supply:+(Q.get('supply')||1e9)});
  return new MockReplaySource();
}

/* =====================================================================
   GAME STATE  (confirmed state is the only thing that moves the rocket)
   ===================================================================== */
const S = {
  confirmed:{mcap:null, block:0, lastSwapTs:0, lastBlockTs:0},
  displayAlt:null, levels:[], pending:[], feed:[], volEma:0, buyEma:0, sellEma:0,
  x:W/2, vx:0, tilt:0, tradeUsd:5, mode:2, lane:1, balance:250, promoLeft:50, slowUntil:0, mult:1, multUntil:0, rhalo:0, shake:0, floaters:[], heading:0, toasts:[], ach:{}, streak:0, collected:0, obstacles:[], fuelers:{'you':0,'0xA11…ce':6,'0xB0b…42':4,'0xC4t…77':2}, cooldownUntil:0,
  status:{source:'',ok:true,msg:''}, score:0, motes:[], particles:[], shards:[], flashes:[],
  orbsOn:localStorage.getItem('disciple.orbs')!=='off', lastOrbT:-99,
  tierShown:-1, tierBanner:0, keys:{}, t:0, turbo:false,
  altVel:0, flatSince:0, cruise:0, bank:0, bob:0, sway:0, roll:1, glint:0,
  trail:[], bgScrollX:0, speedBits:[],
  aimDeg:0, thrustT:-99, lastTrailAlt:null,
  headTarget:Math.PI/2, headSmooth:Math.PI/2, camAlt:null, camX:null,
  thrustNet:0, thrustPend:null, trailAimLP:0,
};

const source = makeSource();
if (IS_POOL) S.fuelers={'you':0};
function onEvent(e){
  if (e.t==='block'){ S.confirmed.block=e.block; S.confirmed.lastBlockTs=performance.now(); }
  else if (e.t==='swap'){
    if (e.removed){ S.feed.unshift({txt:'REORG: swap '+e.txHash.slice(0,10)+' removed',c:'#f96'}); return; }
    S.confirmed.mcap=e.mcap; S.confirmed.lastSwapTs=performance.now();
    if (S.displayAlt===null) S.displayAlt=mcapToAlt(e.mcap);
    if(e.side==='buy'&&e.usd>0){ const who=e.mine?'you':e.trader?short(e.trader):['0xA11…ce','0xB0b…42','0xC4t…77'][Math.floor(Math.random()*3)]; S.fuelers[who]=(S.fuelers[who]||0)+e.usd; }
    if(e.side==='sell'&&e.mine) S.fuelers.you=Math.max(0,S.fuelers.you-e.usd);
    if(e.mine&&e.side==='buy') award('first','FIRST FLAME','first confirmed thrust');
    if (e.side==='sell'&&e.usd>0){ const fs=e.mine&&S.fullStackNext; if(e.mine) S.fullStackNext=false; noteSell({side:'sell',usd:e.usd,prePrice:e.prePrice,postPrice:e.postPrice,impactPct:e.impactPct,trader:e.trader,mine:e.mine,fullStack:fs}); }
    S.volEma+=e.usd; if(e.side==='buy') S.buyEma+=e.usd; else S.sellEma+=e.usd;
    if (e.usd>0){ if(!e.mine) queueThrust(e.side, e.usd);
      S.feed.unshift({txt:`${e.side==='buy'?'▲ FUEL':'▼ BOMB'} ${(e.usd<10?fmtShot(e.usd):fmtUsd(e.usd)).padStart(7)}  ${e.mine?'(you·paper)':e.trader?short(e.trader):'#'+e.block}`, c:e.side==='buy'?'#9ff3c8':'#ffb0c8'}); }
    if (e.usd>0 && !e.mine && e.trader){ const up=e.side==='buy'; S.floaters.push({x:S.x+(up?120:-120)+(Math.random()-.5)*40,y:ROCKET_Y+(up?30:-30),txt:`${up?'▲':'▼'} ${short(e.trader)} ${e.usd<10?fmtShot(e.usd):fmtUsd(e.usd)}`,c:up?'#9ff3c8':'#ffb0c8',life:2.2,small:true}); }
    S.feed.length=Math.min(S.feed.length,7);
  }
  else if (e.t==='depth'){ S.levels=e.levels; }
  else if (e.t==='mark'){ S.confirmed.mcap=e.mcap; }
  else if (e.t==='replayRestart'){ S.feed.unshift({txt:'⟲ replay restarted',c:'#ffe7a3'}); S.displayAlt=null; S.confirmed.mcap=null; }
  else if (e.t==='levelFilled'){ const l=e.level; const y=altToScreenY(mcapToAlt(l.mcap));
    for(let i=0;i<40;i++) S.shards.push({x:laneX(l)+ (Math.random()-.5)*laneW(l), y, vx:(Math.random()-.5)*300, vy:(Math.random()-.8)*260, life:1, c:l.side==='ask'?'#dfe8ff':'#ffd98a'});
    // lateral gameplay: being lined up with the level when it breaks scores "Breaker"/"Bounce"
    if (Math.abs(S.x-laneX(l))<laneW(l)/2){ S.score+=Math.round(10+Math.log10(1+l.usd)*10);
      S.flashes.push({txt:l.side==='ask'?'WALL BREAKER +':'TRAMPOLINE BOUNCE +', life:1.4}); award(l.side==='ask'?'wall':'tramp',l.side==='ask'?'WALL BREAKER':'TRAMPOLINE BOUNCE','lined up when a level broke'); }
    S.feed.unshift({txt:(l.side==='ask'?'⛨ wall cleared ':'⤒ trampoline used ')+fmtUsd(altToMcap(mcapToAlt(l.mcap))),c:'#ffe7a3'});
  }
  else if (e.t==='status'){ S.status=e; }
}
source.start(onEvent);

// ---------- trading (Space = FIRE AMMO / FUEL, Shift = BRAKE / DROP BOMB) ----------
const COOLDOWN_MS=250, MAX_PENDING=3;
/* Climb angle from horizontal (deg). Buys +, sells −.
   angleDeg = clamp(15 + 22*log10(1+usd), 15, 88)
   → ~$5≈32°, $10≈38°, $100≈59°, $1k≈81°, $10k+→88°. */
function climbAngleDeg(usd){ return clamp(15 + 22*Math.log10(1+Math.max(0,usd)), 15, 88); }
/* Coalesce many swaps/frame into one net signed USD thrust (applied once in the frame loop). */
function queueThrust(side, usd){
  const signed = (side==='buy'?1:-1)*Math.max(0,usd);
  S.thrustNet = (S.thrustNet||0) + signed;
  if (!S.thrustPend) S.thrustPend = {side, usd};
  else { S.thrustPend.usd = Math.abs(S.thrustNet); S.thrustPend.side = S.thrustNet>=0?'buy':'sell'; }
}
function applyThrust(side, usd){
  // Immediate path (tests / explicit); also used when flushing the per-frame queue.
  const deg = climbAngleDeg(usd);
  S.aimDeg = side==='buy' ? deg : -deg;
  S.thrustT = S.t;
  S.flatSince = 0;
  S.cruise = Math.min(S.cruise||0, 0.25);
  // Stair corner at stable tip (no sway) so flat segments stay steady.
  const tipX = S.x;
  const last = S.trail.length ? S.trail[S.trail.length-1] : null;
  if (!last || Math.abs(last.x-tipX)>3 || Math.abs(last.alt-S.displayAlt)>1e-8)
    S.trail.push({x:tipX, alt:S.displayAlt, tick:true, thrust:true});
  else { last.tick=true; last.thrust=true; }
}
function flushThrustQueue(){
  if (!S.thrustNet || Math.abs(S.thrustNet)<1e-9){ S.thrustNet=0; S.thrustPend=null; return; }
  const side = S.thrustNet>=0?'buy':'sell';
  const usd = Math.abs(S.thrustNet);
  S.thrustNet=0; S.thrustPend=null;
  applyThrust(side, usd);
}
function award(id,title,sub){ if(S.ach[id]) return; S.ach[id]=1; S.toasts.push({title,sub,life:4}); }
function trade(side,opt){
  let md=MODES[S.mode]; const stack=S.fuelers.you||0;
  if (side==='sell'&&opt&&opt.all){ if(stack<MIN_SHOT){ S.flashes.push({txt:'NO PAPER STACK TO DUMP',life:1.4}); return; } md={...md,usd:stack}; }
  if (side==='sell') S.fullStackNext = stack>=MIN_SHOT && md.usd>=stack*0.98;
  if (md.usd<MIN_SHOT){                                   // below net-buy minimum: blocked (no gas sponsorship)
    if (!PROMO_GAS || S.promoLeft<=0){ S.flashes.push({txt:`BELOW MIN SHOT ${fmtShot(MIN_SHOT)} · gas would eat ${(GAS_USD/md.usd*100).toFixed(0)}%`,life:1.6}); return; }
    S.promoLeft--; }
  if (side==='buy' && S.balance<md.usd){ S.flashes.push({txt:'INSUFFICIENT DEPOSITED BALANCE',life:1.5}); return; }
  // Immediate local aim for the player's shot; mine swaps skip queue to avoid double-apply.
  applyThrust(side, md.usd);
  submit(side, md.usd);
}
function submit(side,usd,force){
  S.tradeUsd=usd;
  const now=performance.now();
  if ((!force&&now<S.cooldownUntil) || S.pending.length>=MAX_PENDING || S.confirmed.mcap===null) return;
  S.cooldownUntil=now+COOLDOWN_MS;
  if (!source.submitTrade){ S.flashes.push({txt:'READ-ONLY SOURCE — trading disabled',life:1.5}); return; }
  // optimistic ghost: projected (NOT applied) price after our trade, from local impact estimate
  const proj = source.impact? S.confirmed.mcap*source.impact(S.tradeUsd,side) : S.confirmed.mcap;
  const p={id:Math.random(),side,usd:S.tradeUsd,proj,t0:now,state:'pending'}; S.pending.push(p);
  // no-signing model (fomo-style): ONE token approval at deposit, then shots run without per-trade signatures.
  // Gas is a real per-swap cost (it sets MIN_SHOT); nothing is sponsored. In this prototype shots are PAPER only.
  source.submitTrade(side,S.tradeUsd).then(r=>{
    p.state=r.ok?'confirmed':'failed';
    if(r.ok) S.balance+= (side==='buy' ? -p.usd : p.usd*0.99) - GAS_USD;
    if(r.ok) dispatchEvent(new CustomEvent('disciple:paperfill',{detail:{side,usd:p.usd,mcap:S.confirmed.mcap,supply:source.supply||1e9,gas:GAS_USD}}));   // → PnL HUD ledger   // mock ledger (sell proceeds net of 1% fee) p.t1=performance.now(); p.reason=r.reason;
    if(!r.ok){ S.feed.unshift({txt:'✕ tx reverted: '+r.reason,c:'#ff8f8f'}); S.flashes.push({txt:'TX REVERTED · '+r.reason,life:1.6}); }
    setTimeout(()=>{ S.pending=S.pending.filter(q=>q!==p); }, 450);
  });
}
addEventListener('keydown',e=>{
  S.keys[e.code]=true;
  if (e.code==='Space'){ e.preventDefault(); if(!e.repeat) trade('buy'); }
  if (e.code==='ShiftLeft'||e.code==='ShiftRight'){ if(!e.repeat) trade('sell',{all:e.ctrlKey||e.metaKey}); }
  const dm=/^Digit([1-6])$/.exec(e.code); if(dm){ S.mode=+dm[1]-1; }
  if (e.code==='Equal'||e.code==='BracketRight'){ S.mode=Math.min(MODES.length-1,S.mode+1); }
  if (e.code==='Minus'||e.code==='BracketLeft'){ S.mode=Math.max(0,S.mode-1); }
  if (!e.repeat&&(e.code==='KeyA'||e.code==='ArrowLeft')) S.lane=Math.max(0,S.lane-1);
  if (!e.repeat&&(e.code==='KeyD'||e.code==='ArrowRight')) S.lane=Math.min(2,S.lane+1);
  if (e.code==='KeyO'&&!e.repeat) setOrbs(!S.orbsOn);
  if (e.code==='KeyB'&&!e.repeat) setBombs(!S.bombsOn);
  if (e.code==='KeyF' && window.__flight.source.faster) window.__flight.source.faster();
  if (e.code==='KeyT' && source instanceof MockReplaySource){ source.turbo=!source.turbo; S.turbo=source.turbo; }
});
function setOrbs(on){ S.orbsOn=on; try{localStorage.setItem('disciple.orbs',on?'on':'off');}catch(_){}
  if(!on){ S.motes=[]; S.obstacles=[]; }
  const b=document.getElementById('orbBtn'); b.textContent='ORBS '+(on?'ON':'OFF')+' · O'; b.classList.toggle('off',!on); dispatchEvent(new Event('apflightorbs')); }
document.getElementById('orbBtn').addEventListener('click',e=>{ setOrbs(!S.orbsOn); e.currentTarget.blur(); });
setOrbs(S.orbsOn);
addEventListener('keyup',e=>{ S.keys[e.code]=false; });
addEventListener('blur',()=>{ S.keys={}; });

/* =====================================================================
   RENDER
   ===================================================================== */
const cv=document.getElementById('c'), ctx=cv.getContext('2d');
let scale=1;
function resize(){ const dpr=Math.min(2,devicePixelRatio||1); const wr=document.getElementById('wrap'); scale=Math.min((wr.clientWidth||innerWidth)/W,(wr.clientHeight||innerHeight)/H);
  cv.style.width=W*scale+'px'; cv.style.height=H*scale+'px'; cv.width=Math.round(W*scale*dpr); cv.height=Math.round(H*scale*dpr);
  ctx.setTransform(cv.width/W,0,0,cv.height/H,0,0); }
addEventListener('resize',resize); addEventListener('apsidebar',()=>requestAnimationFrame(resize)); resize();

const IMG={}; let loaded=0; const names=[...new Set(TIERS.map(t=>t.bg).concat(['rocket']))];
names.forEach(n=>{ const im=new Image(); im.onload=()=>loaded++; im.onerror=()=>{loaded++; im.bad=true; console.warn('asset failed',n);}; im.src='/assets/'+n+'.png'; IMG[n]=im; });

// film grain: pre-rendered noise tiles
const grain=[...Array(4)].map(()=>{ const g=document.createElement('canvas'); g.width=g.height=256; const gx=g.getContext('2d'), id=gx.createImageData(256,256);
  for(let i=0;i<id.data.length;i+=4){ const v=Math.random()*255; id.data[i]=id.data[i+1]=id.data[i+2]=v; id.data[i+3]=22; } gx.putImageData(id,0,0); return g; });

const ROCKET_Y = H*0.58;
const HUD_BOTTOM=140, BANNER_Y=HUD_BOTTOM+70, SAFE_LEFT=24;   // tier banner below the top HUD row; canvas is pushed right of the sidebar so no rail clearance needed
function altToScreenY(a){ const base=(S.camAlt!=null?S.camAlt:S.displayAlt); return ROCKET_Y - (a - base)*PX_PER_ALT; }
function laneW(l){ return clamp(90+Math.log10(1+l.usd)*55, 110, 420); }
function laneX(l){ return 140 + hash(Math.round(l.mcap*7)%9973 + (l.side==='ask'?3:0))*(W-280); }

function drawBg(){
  const a=S.displayAlt, i=clamp(Math.floor(a),0,TIERS.length-1), f=clamp(a-i,0,1);
  const cruise=S.cruise||0;
  const draw=(idx,alpha,off)=>{ const im=IMG[TIERS[idx].bg]; if(!im||!im.complete||im.bad) return;
    ctx.globalAlpha=alpha; const s=1.12, w=W*s, h=H*s;
    // sideways cruise drifts the plate like a tick chart; climb/fall still parallax vertically
    // Plates are tiled with alternating mirror flips so neighbouring edges match: no hard vertical seam
    // (the old un-mirrored second copy produced a red/dark vertical "wall" during sideways cruise).
    const ox=(S.x-W/2)*-0.03 - cruise*((S.bgScrollX||0)%(2*w)), y0=(H-h)/2+off;
    const x0=(W-w)/2+ox;
    for (let k=-2;k<=2;k++){ const tx=x0+k*w; if(tx>W||tx+w<0) continue;
      const odd=((k%2)+2)%2===1;
      // crop the plates' outer 10% (several tier paintings have a red/dark frame at the far edges)
      const sx=im.naturalWidth*0.1, sw=im.naturalWidth*0.8, ih=im.naturalHeight;
      if(!odd) ctx.drawImage(im,sx,0,sw,ih,tx,y0,w,h); else { ctx.save(); ctx.translate(tx+w,y0); ctx.scale(-1,1); ctx.drawImage(im,sx,0,sw,ih,0,0,w,h); ctx.restore(); } }
  };
  ctx.fillStyle='#0b0f22'; ctx.fillRect(0,0,W,H);
  const par=(f-0.5)*H*0.10;                                  // slow parallax inside tier
  draw(i,1,par);
  // crossfade toward the next / previous tier near the boundary
  const edge=0.18;
  if (f>1-edge && i<TIERS.length-1) draw(i+1, (f-(1-edge))/edge, par-H*0.06);
  if (f<edge && i>0) draw(i-1, (edge-f)/edge*0.6, par+H*0.06);
  ctx.globalAlpha=1;
  // grade: darken & cool the plate so HUD/terrain glow reads on bright tiers
  ctx.fillStyle='rgba(8,10,34,.38)'; ctx.fillRect(0,0,W,H);
}

/* angel clouds: 3 parallax depths, procedural soft puffs. Scroll opposite price velocity. */
const CLOUDS=(()=>{
  const layers=[];
  const spec=[{n:8,yJitter:0.9,r:64,a:0.55,spd:0.22},{n:6,yJitter:0.85,r:120,a:0.38,spd:0.48},{n:4,yJitter:0.8,r:200,a:0.22,spd:0.82}];
  spec.forEach((L,li)=>{
    for(let i=0;i<L.n;i++){
      const puffs=[]; const pc=3+((i*3+li)%4);
      for(let k=0;k<pc;k++) puffs.push({dx:(hash(i*17+k*3+li)-0.5)*L.r*1.6, dy:(hash(i*9+k+li*5)-0.5)*L.r*0.55, rr:0.45+hash(k*11+i+li)*0.7});
      layers.push({li, x:hash(i*13+li*7)*W, y:hash(i*29+li)*H, r:L.r*(0.75+hash(i+li*3)*0.5), a:L.a, spd:L.spd, puffs, phase:hash(i+li)*6.28});
    }
  });
  return layers;
})();
function drawClouds(){
  const v=S.vUp||0, cruise=S.cruise||0;
  ctx.save();
  for (const c of CLOUDS){
    // climb (v>0) scrolls clouds down; fall scrolls them up. Cruise adds a leftward drift.
    const yOff=((S.cloudY||0)*c.spd)%(H+400);
    const xOff=((S.bgScrollX||0)*c.spd*0.65)%(W+400);
    let x=c.x - xOff; x=((x%(W+400))+(W+400))%(W+400)-200;
    let y=c.y + yOff*Math.sign(1); y=((y%(H+400))+(H+400))%(H+400)-200;
    for (const cp of S.cloudPush){ const age=S.t-cp.t0, dx=x-cp.x, dy=y-cp.y, d=Math.hypot(dx,dy)+1, e=cp.amp*(1-Math.exp(-age*3.5))*Math.exp(-age/2.2)*(1/(1+d/600));
      x+=dx/d*e*(0.6+c.spd); y+=dy/d*e*(0.6+c.spd); }
    const breathe=1+0.04*Math.sin(S.t*0.6+c.phase);
    ctx.globalAlpha=c.a*(0.75+0.25*(1-cruise*0.25));
    ctx.fillStyle='rgba(255,252,245,1)';
    for (const p of c.puffs){
      const rr=c.r*p.rr*breathe;
      const g=ctx.createRadialGradient(x+p.dx,y+p.dy,rr*0.15,x+p.dx,y+p.dy,rr);
      g.addColorStop(0,'rgba(255,253,250,1)'); g.addColorStop(0.4,'rgba(236,242,255,0.72)'); g.addColorStop(1,'rgba(200,214,255,0)');
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(x+p.dx,y+p.dy,rr,0,7); ctx.fill();
    }
  }
  ctx.restore(); ctx.globalAlpha=1;
}
function drawSpeedLines(){
  if (!S.speedBits.length) return;
  ctx.save();
  const cruise=S.cruise||0;
  for (const b of S.speedBits){
    ctx.globalAlpha=b.life*0.55;
    ctx.strokeStyle=b.up?'rgba(220,240,255,.85)':'rgba(255,210,230,.8)';
    ctx.lineWidth=b.w;
    ctx.beginPath();
    if (cruise>0.45 && Math.abs(S.vUp||0)<80){
      ctx.moveTo(b.x,b.y); ctx.lineTo(b.x-b.len*(0.3+cruise),b.y);
    } else {
      ctx.moveTo(b.x,b.y); ctx.lineTo(b.x+b.dx,b.y+b.len*(b.up?1:-1));
    }
    ctx.stroke();
  }
  ctx.restore(); ctx.globalAlpha=1;
}
function drawTickTrail(){
  if (S.trail.length<2) return;
  // JET TRAIL → TICK LINE: thick/hot at the nozzle (pivot), thins into historical tick path (left=past).
  // Stair language: flat segments when sideways, angled segments on thrust (variable slope).
  // Tip = nozzle/aft pivot (rocket nose leads ahead of this point).
  const tail={x:(S.camX!=null?S.camX:S.x)+(S.sway||0)*0.35, y:ROCKET_Y+(S.bob||0)*0.5};
  const pts=S.trail.map(p=>({x:p.x,y:clamp(altToScreenY(p.alt),20,H-20),tick:p.tick,thrust:p.thrust})).filter(p=>p.x<tail.x-2); pts.push(tail);
  const n=pts.length; if(n<2) return;
  const vis=Math.max(0.35, S.cruise||0); // always visible; brighter in cruise
  ctx.save(); ctx.lineCap='round'; ctx.lineJoin='round'; ctx.globalCompositeOperation='lighter';
  for (let i=1;i<n;i++){ const u=i/(n-1);               // 0 = oldest (far left), 1 = at the nozzle
    const a=vis*Math.pow(u,1.25);
    const hot=pts[i].thrust||pts[i-1].thrust ? 1 : u;
    const sc=S.scorch||0; // ATOM: trail scorched to charcoal with ember edges, cools back over ~7 s
    ctx.strokeStyle=`rgba(${Math.round(lerp(255,70,sc))},${Math.round(lerp(190+55*hot,40,sc))},${Math.round(lerp(140+90*u,30,sc))},${0.18+0.72*a})`;
    ctx.lineWidth=1.2+16*Math.pow(u,2.6);               // thickest at nozzle, hairline far back
    ctx.shadowColor=(S.scorch||0)>0.05?`rgba(255,${Math.round(lerp(230,90,S.scorch))},40,.9)`:'rgba(255,230,180,.85)'; ctx.shadowBlur=12*u+10*(S.scorch||0);
    ctx.beginPath(); ctx.moveTo(pts[i-1].x,pts[i-1].y); ctx.lineTo(pts[i].x,pts[i].y); ctx.stroke(); }
  ctx.restore();
  // tick marks on thrust corners (Papertrade stair vertices)
  for (let i=0;i<n-1;i++){ const p=pts[i]; if(!p.tick) continue; const u=i/(n-1); ctx.strokeStyle=`rgba(255,255,255,${0.18+0.5*u})`; ctx.lineWidth=1.2;
    ctx.beginPath(); ctx.moveTo(p.x,p.y-6); ctx.lineTo(p.x,p.y+6); ctx.stroke(); }
  ctx.globalAlpha=1;
}

function drawLevels(){
  // tier boundary lines
  for (let k=Math.floor(S.displayAlt)-1;k<=Math.floor(S.displayAlt)+2;k++){
    if(k<1||k>=TIERS.length) continue; const y=altToScreenY(k); if(y<-20||y>H+20) continue;
    ctx.save(); ctx.strokeStyle='rgba(255,236,190,.55)'; ctx.setLineDash([2,10]); ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle='rgba(255,236,190,.9)'; ctx.font='bold 13px ui-monospace,monospace'; ctx.fillText('▲ '+TIERS[k].name+'  '+fmtUsd(TIERS[k].lo),SAFE_LEFT,Math.max(HUD_BOTTOM+18,y-8)); ctx.restore();
  }
  for (const l of S.levels){
    const y=altToScreenY(mcapToAlt(l.mcap)); if (y<-40||y>H+40) continue;
    const w=laneW(l), x=laneX(l), th=clamp(3+Math.log10(1+l.usd)*3.2,4,22), ask=l.side==='ask';
    ctx.save(); ctx.globalAlpha=0.55*(1-0.6*(S.cruise||0));   // soft depth cue, never a barrier
    const col= ask? (l.src==='hook'?'210,225,255':'170,190,255') : (l.src==='hook'?'255,215,120':'255,190,110');
    ctx.shadowColor=`rgba(${col},.9)`; ctx.shadowBlur=14;
    const g=ctx.createLinearGradient(x-w/2,0,x+w/2,0); g.addColorStop(0,`rgba(${col},0)`); g.addColorStop(.15,`rgba(${col},.85)`); g.addColorStop(.85,`rgba(${col},.85)`); g.addColorStop(1,`rgba(${col},0)`);
    ctx.fillStyle=g;
    if (ask){ // WALL: cloud-marble slab hanging above
      for(let k=0;k<5;k++){ ctx.beginPath(); ctx.arc(x-w/2+w*(k+.5)/5, y-th, th*0.7*(0.7+hash(k+l.mcap)*.6),Math.PI,0); ctx.fill(); }
    } else { // TRAMPOLINE: glowing sprung arc below
      ctx.lineWidth=th*0.6; ctx.strokeStyle=`rgba(${col},.8)`; ctx.beginPath(); ctx.moveTo(x-w/2,y); ctx.quadraticCurveTo(x,y+th*1.6+Math.sin(S.t*6+l.mcap)*2,x+w/2,y); ctx.stroke();
      ctx.lineWidth=2; for(const s of [-1,1]){ ctx.beginPath(); ctx.moveTo(x+s*w/2,y); ctx.lineTo(x+s*w/2,y+14); ctx.stroke(); }
    }
    ctx.shadowColor='rgba(0,0,20,.9)'; ctx.shadowBlur=4;
    ctx.fillStyle=ask?'rgba(225,232,255,.9)':'rgba(255,226,160,.9)'; ctx.font='11px ui-monospace,monospace';
    ctx.fillText(`${ask?'WALL':'TRAMP'} ${fmtUsd(l.usd)}${l.src==='hook'?' · limit':''}${l.tick!==undefined?' · tick '+l.tick:''}`, x-w/2+8, ask? y-th-8 : y+th+16);
    ctx.restore();
  }
}

function drawRocket(dt){
  const im=IMG.rocket, h=150, w=im.naturalWidth? h*im.naturalWidth/im.naturalHeight : 55;
  // (x,y) = nozzle / aft pivot — trail tip + rotation origin. Nose leads ahead of this point.
  const y=ROCKET_Y+(S.bob||0)*0.55, x=(S.camX!=null?S.camX:S.x)+(S.sway||0)*0.45;
  const NOZZLE_FROM_TOP = 0.96; // fraction of sprite height: engine sits just above the bottom edge
  const pivotY = h * NOZZLE_FROM_TOP; // draw offset so nozzle lands on (0,0) after rotate
  // ghost thrust for pending txs (projected, never applied to confirmed altitude)
  for (const p of S.pending){
    const gy=altToScreenY(mcapToAlt(p.proj)), a=p.state==='pending'? 0.28+0.12*Math.sin(S.t*14) : p.state==='confirmed'?0.5:0.2;
    ctx.save(); ctx.globalAlpha=a; ctx.translate(x,gy); ctx.rotate(S.heading);
    if(im.complete&&!im.bad) ctx.drawImage(im,-w/2,-pivotY,w,h);
    ctx.restore(); ctx.save(); ctx.strokeStyle=p.side==='buy'?'rgba(140,255,200,.6)':'rgba(255,150,190,.6)'; ctx.setLineDash([4,6]);
    ctx.beginPath(); ctx.moveTo(x+w/2+8,y); ctx.lineTo(x+w/2+8,gy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle=ctx.strokeStyle; ctx.font='11px ui-monospace,monospace';
    ctx.fillText((p.state==='pending'?'PENDING ':p.state==='confirmed'?'CONFIRMED ':'FAILED ')+(p.side==='buy'?'+':'-')+fmtUsd(p.usd), x+w/2+14, gy); ctx.restore();
  }
  // exhaust (procedural): leaves the nozzle opposite the nose
  const vol=clamp(Math.log10(1+S.volEma)/3.2,0,1), pend=S.pending.some(p=>p.side==='buy'&&p.state==='pending')?0.5:0;
  const braking=S.pending.some(p=>p.side==='sell'&&p.state==='pending');
  const I=clamp(0.25+vol*0.8+pend,0,1.4);
  const flick=0.72+0.28*Math.abs(Math.sin(S.t*37.0))*Math.abs(Math.sin(S.t*17.3+1.7));
  const move=clamp(Math.abs(S.vUp||0)/220 + Math.abs(S.vx||0)/400, 0, 1.2);
  const thrustBoost=clamp(Math.abs(S.aimDeg||0)/88,0,1)*(S.t-(S.thrustT||-99)<1.2?1:0);
  const flame=I*(0.65+0.9*move+0.55*thrustBoost)*flick*(0.85+0.3*(S.cruise||0));
  const sa=Math.sin(S.heading), ca=Math.cos(S.heading);
  // nozzle is at (x,y); exhaust streams aft = opposite nose (+rotated down-vector)
  const tx=x, ty=y;
  const n=Math.round((2+flame*9)*(0.55+flick));
  for(let i=0;i<n;i++){ const sp=(140+Math.random()*280*flame)*(0.75+flick*0.5), j=(Math.random()-.5)*(40+30*flick);
    S.particles.push({x:tx+(Math.random()-.5)*10, y:ty, vx:-sa*sp+ca*j, vy:ca*sp+sa*j, life:0.7+Math.random()*0.45, s:(5+Math.random()*14*flame)*flick, hot:Math.random()<0.45}); }
  ctx.save(); ctx.globalCompositeOperation='lighter';
  for (const p of S.particles){ const r=p.s*(1.3-p.life*0.3);
    const g=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,r); const c=p.hot?'255,240,200':'140,190,255';
    g.addColorStop(0,`rgba(${c},${0.32*p.life})`); g.addColorStop(1,`rgba(${c},0)`); ctx.fillStyle=g; ctx.fillRect(p.x-r,p.y-r,2*r,2*r); }
  // engine core bloom at nozzle
  const bx=x, by=y, cg=ctx.createRadialGradient(bx,by,0,bx,by,(48+70*flame)*flick); cg.addColorStop(0,`rgba(255,250,230,${0.55*flame*flick})`); cg.addColorStop(1,'rgba(120,170,255,0)');
  ctx.fillStyle=cg; ctx.beginPath(); ctx.arc(bx,by,(48+70*flame)*flick,0,7); ctx.fill();
  ctx.restore();
  // rocket — rotate about nozzle (aft). Nose leads; body trails. No center-spin / scaleX barrel-roll.
  ctx.save(); ctx.translate(x,y); ctx.rotate(S.heading+(S.microRot||0));
  ctx.shadowColor='rgba(200,220,255,.8)'; ctx.shadowBlur=24;
  if(im.complete&&!im.bad){
    const oc=drawRocket.oc||(drawRocket.oc=document.createElement('canvas')), ow=Math.ceil(w), oh=Math.ceil(h);
    if(oc.width!==ow||oc.height!==oh){ oc.width=ow; oc.height=oh; }
    const o=oc.getContext('2d'); o.clearRect(0,0,ow,oh); o.globalCompositeOperation='source-over'; o.drawImage(im,0,0,ow,oh);
    { const dec=window.__rocketDecal; if(dec&&dec.canvas){ const fa=clamp((performance.now()-dec.t0)/300,0,1); o.globalAlpha=fa; o.drawImage(dec.canvas,0,0,ow,oh); o.globalAlpha=1; } } // token decal (pre-composited offscreen, 300ms cross-fade)
    try{ const d=o.getImageData(0,0,ow,oh), px=d.data; for(let i=3;i<px.length;i+=4) if(px[i]<64) px[i]=0; o.putImageData(d,0,0); }catch(_){}
    const gx=ow/2+(S.glint||0)*w*0.28, gg=o.createLinearGradient(gx-14,oh*0.08,gx+14,oh*0.9);
    gg.addColorStop(0,'rgba(255,255,255,0)'); gg.addColorStop(0.45,`rgba(255,252,240,${0.08+0.12*Math.abs(S.glint||0)})`); gg.addColorStop(1,'rgba(255,255,255,0)');
    o.globalCompositeOperation='source-atop'; o.fillStyle=gg; o.fillRect(0,0,ow,oh);
    ctx.drawImage(oc,-w/2,-pivotY,w,h);
  }
  ctx.restore();
  // nose tip (for brake rings): ahead of nozzle along heading
  const noseX=x+sa*pivotY, noseY=y-ca*pivotY;
  if (braking){ ctx.save(); ctx.globalCompositeOperation='lighter'; ctx.strokeStyle='rgba(255,140,180,.5)'; ctx.lineWidth=3;
    for(let k=0;k<3;k++){ ctx.beginPath(); ctx.arc(noseX,noseY,30+k*12+Math.sin(S.t*20)*3,Math.PI*1.15+S.heading,Math.PI*1.85+S.heading); ctx.stroke(); } ctx.restore(); }
}

// faint 'your entry' altitude marker (set by the PnL HUD: window.__entryMcap)
function drawEntryLine(){ const m=window.__entryMcap; if(!(m>0)||S.displayAlt==null) return; const y=altToScreenY(mcapToAlt(m)); if(y<-20||y>H+20) return;
  const up=(S.confirmed.mcap||0)>=m; ctx.save(); ctx.strokeStyle=up?'rgba(143,240,192,.45)':'rgba(255,159,184,.45)'; ctx.setLineDash([10,8]); ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle=ctx.strokeStyle; ctx.font='bold 11px ui-monospace,monospace';
  ctx.fillText('YOUR ENTRY '+fmtUsd(m),W/2+60,y-6); ctx.restore(); }
function drawLanes(){ ctx.save(); ctx.strokeStyle='rgba(220,230,255,.08)'; ctx.setLineDash([6,18]); ctx.lineDashOffset=-S.t*60*(1+Math.log10(1+S.volEma));
  for (const lx of [W/2-130,W/2+130]){ ctx.beginPath(); ctx.moveTo(lx,0); ctx.lineTo(lx,H); ctx.stroke(); } ctx.restore(); }
function drawFx(dt){
  // collectible motes (cosmetic, lateral gameplay)
  ctx.save(); ctx.globalCompositeOperation='lighter';
  for (const m of S.motes){ const T=ORB[m.k], r=T.r*(1+0.12*Math.sin(S.t*6+m.x)); const g=ctx.createRadialGradient(m.x,m.y,0,m.x,m.y,r); g.addColorStop(0,T.c0); g.addColorStop(1,T.c1); ctx.fillStyle=g; ctx.fillRect(m.x-r,m.y-r,2*r,2*r); }
  for (const s of S.shards){ ctx.fillStyle=s.c; ctx.globalAlpha=s.life; ctx.fillRect(s.x,s.y,3,3); }
  ctx.restore(); ctx.globalAlpha=1;
  // PENALTY orbs: dark red/black storm cores (normal blending so they read as dark), crackling rim
  for (const o of S.obstacles){ const T=ORB[o.k], r=T.r; ctx.save();
    const g=ctx.createRadialGradient(o.x,o.y,0,o.x,o.y,r*1.6); g.addColorStop(0,T.c0); g.addColorStop(.55,T.c1); g.addColorStop(1,'rgba(40,0,0,0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(o.x,o.y,r*1.6,0,7); ctx.fill();
    ctx.strokeStyle=T.rim; ctx.lineWidth=2; ctx.shadowColor=T.rim; ctx.shadowBlur=12; ctx.beginPath();
    for(let k=0;k<=10;k++){ const a=k/10*6.283+S.t*3, rr=r*(0.9+0.25*hash(k+Math.floor(S.t*12)+o.x)); k?ctx.lineTo(o.x+Math.cos(a)*rr,o.y+Math.sin(a)*rr):ctx.moveTo(o.x+Math.cos(a)*rr,o.y+Math.sin(a)*rr); } ctx.stroke();
    ctx.shadowBlur=0; ctx.fillStyle=T.rim; ctx.font='bold 10px ui-monospace,monospace'; ctx.textAlign='center'; ctx.fillText(T.tag,o.x,o.y+r+14); ctx.restore(); }
  for (const f of S.floaters){ ctx.save(); ctx.globalAlpha=clamp(f.life,0,1); ctx.fillStyle=f.c; ctx.font=f.small?'bold 13px ui-monospace,monospace':'bold 16px ui-monospace,monospace'; ctx.textAlign='center'; ctx.fillText(f.txt,f.x,f.y); ctx.restore(); }
  if (performance.now()<S.slowUntil||S.shake>0.3){ ctx.save(); ctx.fillStyle=`rgba(120,0,10,${0.10+0.1*Math.sin(S.t*20)})`; ctx.fillRect(0,0,W,H); ctx.restore(); }
}

function drawPost(){
  // bloom-ish: brighten highlights by re-drawing the frame blurred & additive (cheap: downscaled copy)
  ctx.save(); ctx.globalCompositeOperation='lighter'; ctx.globalAlpha=0.07; ctx.filter='blur(14px)';
  ctx.drawImage(cv,0,0,cv.width,cv.height,0,0,W,H); ctx.restore();
  // vignette
  const v=ctx.createRadialGradient(W/2,H/2,H*0.35,W/2,H/2,H*0.95); v.addColorStop(0,'rgba(0,0,0,0)'); v.addColorStop(1,'rgba(4,4,16,.6)');
  ctx.fillStyle=v; ctx.fillRect(0,0,W,H);
  // grain
  const g=grain[(S.t*24|0)%4]; ctx.save(); ctx.globalCompositeOperation='overlay'; const ox=(Math.random()*256)|0, oy=(Math.random()*256)|0;
  for(let x=-ox;x<W;x+=256) for(let y=-oy;y<H;y+=256) ctx.drawImage(g,x,y); ctx.restore();
}

function panel(x,y,w,h){ ctx.save(); ctx.fillStyle='rgba(8,10,28,.62)'; ctx.strokeStyle='rgba(220,230,255,.18)'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.roundRect? ctx.roundRect(x,y,w,h,10) : ctx.rect(x,y,w,h); ctx.fill(); ctx.stroke(); ctx.restore(); }

function drawHud(){
  const m=S.confirmed.mcap, a=S.displayAlt, ti=clamp(Math.floor(mcapToAlt(m)),0,TIERS.length-1), t=TIERS[ti];
  ctx.save(); ctx.textBaseline='alphabetic';
  // top-left: MCAP + tier
  panel(20,18,380,112);
  ctx.fillStyle='rgba(200,210,255,.7)'; ctx.font='12px ui-monospace,monospace'; ctx.fillText(IS_POOL&&source.real?`PRICE $${(S.confirmed.mcap/source.supply).toFixed(5)}${source.paper!==1?' (incl. paper '+((source.paper-1)*100).toFixed(2)+'%)':''}`:'MARKET CAP · confirmed',36,42);
  ctx.fillStyle='#fff'; ctx.shadowColor='rgba(180,200,255,.9)'; ctx.shadowBlur=14; ctx.font='bold 40px ui-monospace,monospace'; ctx.fillText(fmtUsd(m),34,84); ctx.shadowBlur=0;
  ctx.fillStyle='#ffe7a3'; ctx.font='bold 14px ui-monospace,monospace'; ctx.fillText(`TIER ${ti} · ${t.name}`,36,108);
  // progress to next tier
  const f=clamp(mcapToAlt(m)-ti,0,1); ctx.fillStyle='rgba(255,255,255,.12)'; ctx.fillRect(36,116,348,4); ctx.fillStyle='#ffe7a3'; ctx.fillRect(36,116,348*f,4);
  if (ti<TIERS.length-1){ ctx.fillStyle='rgba(255,255,255,.55)'; ctx.font='10px ui-monospace,monospace'; ctx.textAlign='right'; ctx.fillText('next '+fmtUsd(TIERS[ti+1].lo),384,108); ctx.textAlign='left'; }
  // top-right: chain/feed status
  panel(W-330,18,310,92);
  const sinceSwap=(performance.now()-S.confirmed.lastSwapTs)/1000, holding=sinceSwap>1.5;
  ctx.fillStyle=S.status.ok?'#8ff0c0':'#ff8f8f'; ctx.font='bold 12px ui-monospace,monospace'; ctx.fillText('● '+(S.status.source||source.name),W-314,42);
  ctx.fillStyle='rgba(220,228,255,.8)'; ctx.font='11px ui-monospace,monospace'; ctx.fillText(String(S.status.msg).slice(0,40),W-314,60);
  ctx.fillText(`block #${S.confirmed.block}`,W-314,78);
  ctx.fillStyle=holding?'#ffd98a':'#8ff0c0'; ctx.fillText(holding?`HOLDING · no trades ${sinceSwap.toFixed(1)}s`:'LIVE · trade flow',W-314,96);
  // bottom-left: trade feed
  panel(20,H-190,330,170); ctx.font='12px ui-monospace,monospace';
  ctx.fillStyle='rgba(200,210,255,.7)'; ctx.fillText(IS_POOL?'TRADES (real onchain + your paper)':'TRADES (onchain only)',36,H-166);
  S.feed.slice(0,7).forEach((r,i)=>{ ctx.fillStyle=r.c; ctx.globalAlpha=1-i*0.11; ctx.fillText(r.txt.slice(0,40),36,H-144+i*19); }); ctx.globalAlpha=1;
  // bottom-right: controls + trade size
  panel(W-330,H-150,310,130);
  const md=MODES[S.mode]; ctx.fillStyle='#fff'; ctx.font='bold 13px ui-monospace,monospace'; ctx.fillText(`MODE ${md.name}  ammo ${fmtShot(md.usd)}/shot  [1-6]`,W-314,H-124);
  ctx.font='12px ui-monospace,monospace'; ctx.fillStyle='#9ff3c8'; ctx.fillText('SPACE  FIRE AMMO / FUEL',W-314,H-100);
  ctx.fillStyle='#ffb0c8'; ctx.fillText('SHIFT  BRAKE / DROP BOMB',W-314,H-82);
  ctx.fillStyle='rgba(220,228,255,.8)'; ctx.fillText('A/D ←/→  switch lane (cosmetic)',W-314,H-64);
  ctx.fillText(`pending ${S.pending.filter(p=>p.state==='pending').length}/${MAX_PENDING}${source instanceof MockReplaySource?'   T turbo '+(S.turbo?'ON':'off'):''}`,W-314,H-46);
  if (S.orbsOn){ ctx.fillStyle='#ffe7a3'; ctx.fillText(`POINTS ${S.score}  streak ${S.streak}${S.mult>1?'  ×'+S.mult:''}  rHALO ${S.rhalo}`,W-314,H-28); }
  const am=autoMode(m); panel(420,18,520,118);
  ctx.fillStyle='rgba(200,210,255,.7)'; ctx.font='11px ui-monospace,monospace'; ctx.fillText(`AMMO MODE · auto by depth: ${MODES[am].name} (${MODES[am].range})`,434,36);
  MODES.forEach((q,i)=>{ const bx=434+i*84, by=44, below=q.usd<MIN_SHOT; ctx.fillStyle=i===S.mode?'rgba(255,231,163,.9)':'rgba(255,255,255,.08)'; ctx.fillRect(bx,by,78,28);
    ctx.strokeStyle=i===am?'#9ff3c8':'rgba(255,255,255,.2)'; ctx.lineWidth=i===am?2:1; ctx.strokeRect(bx,by,78,28);
    ctx.fillStyle=i===S.mode?'#1a1630':'#e8ecff'; ctx.font='bold 10px ui-monospace,monospace'; ctx.fillText(`${q.key} ${q.name}`,bx+5,by+12); ctx.font='10px ui-monospace,monospace'; ctx.fillText(fmtShot(q.usd)+(below?' ·min✗':''),bx+5,by+24); });
  ctx.font='11px ui-monospace,monospace'; ctx.fillStyle='#cfd8ff';
  ctx.fillText(`MIN NET-BUY SHOT ${CHAIN.label} ${fmtShot(MIN_SHOT)}  (gas ≈$${GAS_USD.toFixed(4)} ≤ ${MAX_GAS_OVERHEAD*100}% of shot)`,434,90);
  ctx.fillStyle='#9ff3c8'; ctx.fillText(`PAPER BALANCE $${S.balance.toFixed(2)} · 1 approval at deposit, no per-trade signing`,434,108);
  if (MODES[S.mode].usd<MIN_SHOT){ ctx.fillStyle='#ffb0c8'; ctx.fillText(`below min shot on ${CHAIN.label}: blocked`,434,128); }
  else if (source.submitTrade && IS_POOL){ ctx.fillStyle='#ffd98a'; ctx.fillText('your shots = PAPER on top of the real price (no tx sent)',434,128); }
  const top=Object.entries(S.fuelers).sort((a,b)=>b[1]-a[1]); panel(W-330,120,310,96);
  ctx.fillStyle='#ffe7a3'; ctx.font='bold 12px ui-monospace,monospace'; ctx.fillText(IS_POOL?'TOP BUYERS · real wallets in feed':'KING OF THE HILL · top fuelers (mock)',W-314,140);
  top.slice(0,3).forEach(([w,v],i)=>{ ctx.fillStyle=w==='you'?'#9ff3c8':'rgba(220,228,255,.85)'; ctx.font='11px ui-monospace,monospace'; ctx.fillText(`${i===0?'👑':' '+(i+1)} ${w.padEnd(11)} ${fmtUsd(v)}`,W-314,160+i*18); });
  if (top[0][0]==='you'){ ctx.save(); ctx.fillStyle='#ffd24a'; ctx.shadowColor='#ffb000'; ctx.shadowBlur=16; ctx.font='bold 16px ui-monospace,monospace'; ctx.textAlign='center'; ctx.fillText('👑 KOTH',S.x,ROCKET_Y-100); ctx.restore(); }
  S.toasts.slice(0,3).forEach((t,i)=>{ const a=clamp(t.life,0,1), y=150+i*62; ctx.globalAlpha=a; panel(20,y,300,52);
    ctx.fillStyle='#ffe7a3'; ctx.font='bold 13px ui-monospace,monospace'; ctx.fillText('★ ACHIEVEMENT · '+t.title,34,y+22); ctx.fillStyle='rgba(220,228,255,.85)'; ctx.font='11px ui-monospace,monospace'; ctx.fillText(t.sub,34,y+40); ctx.globalAlpha=1; });
  // tier banner
  if (S.tierBanner>0){ ctx.globalAlpha=clamp(S.tierBanner,0,1); ctx.textAlign='center'; ctx.fillStyle='#fff7df'; ctx.shadowColor='rgba(255,220,150,1)'; ctx.shadowBlur=30;
    const BY=BANNER_Y; let fs=54; ctx.font=`bold ${fs}px Georgia,serif`; while(ctx.measureText(TIERS[S.tierShown].name).width>W-120&&fs>24){ fs-=4; ctx.font=`bold ${fs}px Georgia,serif`; } ctx.fillText(TIERS[S.tierShown].name,W/2,BY); ctx.font='16px ui-monospace,monospace'; ctx.fillText('ENTERED · '+fmtUsd(TIERS[S.tierShown].lo)+'+ MCAP',W/2,BY+30);
    ctx.shadowBlur=0; ctx.textAlign='left'; ctx.globalAlpha=1; }
  S.flashes.forEach((fl,i)=>{ ctx.globalAlpha=clamp(fl.life,0,1); ctx.textAlign='center'; ctx.fillStyle=fl.c||'#fff'; ctx.font='bold 18px ui-monospace,monospace'; ctx.fillText(fl.txt,W/2,H*0.40-i*24); ctx.textAlign='left'; ctx.globalAlpha=1; });
  ctx.restore();
}

function drawLoading(){ ctx.fillStyle='#05060c'; ctx.fillRect(0,0,W,H); ctx.fillStyle='#ccd'; ctx.font='16px ui-monospace,monospace'; ctx.textAlign='center';
  ctx.fillText(S.confirmed.mcap===null?`waiting for first confirmed trade… (${source.name}) ${S.status.ok?'':S.status.msg}`:`loading assets ${loaded}/${names.length}`,W/2,H/2); ctx.textAlign='left'; }

/* =====================================================================
   NUKE ON DUMP — sell bombs (visual layer only; never touches rocket motion/springs)
   Impact → tier. Thresholds in % price move (abs). Tune here.
   ===================================================================== */
const BOMB_PCT={GRENADE:2, BUNKER:5, CRUISE:12, NUKE:25, ATOM:50};
const BOMB_TIERS=[
  {k:'puff',    name:'BRAKE',         min:0,                life:0.6, shake:0,  sf:0,   tau:0},
  {k:'grenade', name:'GRENADE',       min:BOMB_PCT.GRENADE, life:0.9, shake:2,  sf:11,  tau:0.12},
  {k:'bunker',  name:'BUNKER BUSTER', min:BOMB_PCT.BUNKER,  life:2.0, shake:5,  sf:9,   tau:0.22, fall:0.45},
  {k:'cruise',  name:'CRUISE MISSILE',min:BOMB_PCT.CRUISE,  life:2.2, shake:10, sf:7,   tau:0.40, fall:0.55},
  {k:'nuke',    name:'NUKE',          min:BOMB_PCT.NUKE,    life:2.8, shake:15, sf:5.5, tau:0.70, fall:0.30},
  {k:'atom',    name:'ATOM BOMB',     min:BOMB_PCT.ATOM,    life:4.6, shake:20, sf:3.2, tau:1.10, fall:0.40},
];
const BOMB_ALIASES={daisy:'cruise', moab:'nuke'};
const BOMB_MERGE_WIN=0.30;   // s (sim time): sells landing within this window merge into one bomb
const BOMB_MIN_GAP=0.55;     // s between detonations (queue otherwise)
const BOMB_MAX_ACTIVE=2;     // live blasts on screen (puffs excluded)
const BOMB_MAX_QUEUE=2;      // overflow merges into the last queued bomb (×N)
const SHAKE_MAX=24;          // px cap on total camera offset
const SLOWMO_S=0.6, SLOWMO_SCALE=0.3;
function bombTierOf(pct,fullStack){ if(fullStack) return 5; let i=0; for(let k=0;k<BOMB_TIERS.length;k++) if(pct>=BOMB_TIERS[k].min) i=k; return i; }
/* Single seam for the future backend impact API: return |Δprice| in % for this trade.
   trade = {side, usd, prePrice, postPrice, impactPct?, mine}
   1) trade.impactPct (backend-provided) wins.
   2) Market swaps: pre/post pool price. postPrice comes from the Swap event's sqrtPriceX96 (price ∝ 1/sqrtP²);
      prePrice is the pool price after the previous swap (= state before this one). Player paper sells carry the
      same pre/post fields computed by the local v3 in-range sim (PoolV3Base.impact on current L).
   3) Fallback: v3 sim on current liquidity. */
function estimateImpactPct(trade){
  if (Number.isFinite(trade.impactPct)) return Math.abs(trade.impactPct);
  if (trade.prePrice>0 && trade.postPrice>0) return Math.abs(trade.postPrice/trade.prePrice-1)*100;
  if (source.impact && trade.usd>0 && source.L) return Math.abs(source.impact(trade.usd,trade.side==='buy'?'buy':'sell')-1)*100;
  return 0;
}
S.bombsOn=localStorage.getItem('disciple.bombs')!=='off'; S.shakeOn=localStorage.getItem('disciple.shake')!=='off';
S.bombFrame=null; S.bombQ=[]; S.bombs=[]; S.bfx=[]; S.bombLabels=[]; S.camShakes=[]; S.cloudPush=[]; S.lastBombT=-99; S.lastPuffT=-99;
S.scorch=0; S.slowmoUntil=-1; S.timeScale=1; S.screenFlash=null;
function setBombs(on){ S.bombsOn=on; try{localStorage.setItem('disciple.bombs',on?'on':'off');}catch(_){} dispatchEvent(new Event('apflightbombs')); }
function setShake(on){ S.shakeOn=on; if(!on) S.camShakes=[]; try{localStorage.setItem('disciple.shake',on?'on':'off');}catch(_){} dispatchEvent(new Event('apflightbombs')); }
/* Called from onEvent for every sell. Trades in the same frame are combined (compounded impact). */
function noteSell(t){
  const pct=estimateImpactPct(t);
  const f=S.bombFrame||(S.bombFrame={keep:1,usd:0,n:0,trader:null,topUsd:-1,fullStack:false,mine:false});
  f.keep*=Math.max(0,1-pct/100); f.usd+=t.usd||0; f.n++; f.fullStack=f.fullStack||!!t.fullStack; f.mine=f.mine||!!t.mine;
  if ((t.usd||0)>f.topUsd){ f.topUsd=t.usd||0; f.trader=t.mine?'you':t.trader?short(t.trader):null; }
}
function mergeInto(a,b){ a.keep*=b.keep; a.usd+=b.usd; a.n+=b.n; a.fullStack=a.fullStack||b.fullStack; a.mine=a.mine||b.mine; if(b.topUsd>a.topUsd){a.topUsd=b.topUsd;a.trader=b.trader;} return a; }
const bPct=b=>(1-b.keep)*100;
function tipPoint(){ return {x:(S.camX!=null?S.camX:S.x), alt:S.displayAlt}; }
function bombStep(dt){
  // 1) per-frame combine → merge window → queue
  if (S.bombFrame){ const f=S.bombFrame; S.bombFrame=null; f.t=S.t;
    const pct=bPct(f), tier=bombTierOf(pct,f.fullStack);
    if (tier===0 || !S.bombsOn){ if(S.t-S.lastPuffT>0.12){ S.lastPuffT=S.t; spawnPuff(); } }
    else { const q=S.bombQ[S.bombQ.length-1];
      if (q && S.t-q.t<BOMB_MERGE_WIN) mergeInto(q,f);
      else if (S.bombQ.length>=BOMB_MAX_QUEUE) mergeInto(q,f);
      else S.bombQ.push(f); } }
  // 2) launch respecting gap + max active (puffs don't count)
  const active=S.bombs.filter(b=>b.age<b.T.life*0.6).length;
  if (S.bombQ.length && S.t-S.bombQ[0].t>=0.05 && S.t-S.lastBombT>=BOMB_MIN_GAP && active<BOMB_MAX_ACTIVE){
    const f=S.bombQ.shift(); launchBomb(bPct(f),f); }
  for (const tm of simTimers) if(!tm.done&&S.t>=tm.at){ tm.done=true; tm.fn(); }
  // 3) advance
  for (const b of S.bombs){ b.age+=dt; if(!b.det && b.age>=(b.T.fall||0)){ b.det=true; detonate(b); } }
  S.bombs=S.bombs.filter(b=>b.age<b.T.life+(b.T.fall||0));
  for (const p of S.bfx){ p.x+=p.vx*dt; p.y+=p.vy*dt; const d=Math.exp(-dt*(p.drag||0)); p.vx*=d; p.vy*=d; p.vy+=(p.g||0)*dt; p.r+=(p.gr||0)*dt; p.life-=dt; }
  S.bfx=S.bfx.filter(p=>p.life>0); if(S.bfx.length>700) S.bfx.splice(0,S.bfx.length-700);
  for (const l of S.bombLabels) l.age+=dt; S.bombLabels=S.bombLabels.filter(l=>l.age<l.life);
  S.camShakes=S.camShakes.filter(s=>S.t-s.t0<s.tau*6);
  S.cloudPush=S.cloudPush.filter(c=>S.t-c.t0<6);
  S.scorch=Math.max(0,S.scorch-dt/7);
}
function launchBomb(pct,f){
  const tier=bombTierOf(pct,f&&f.fullStack), T=BOMB_TIERS[tier], tp=tipPoint();
  S.lastBombT=S.t;
  const b={tier,T,pct,x:tp.x,alt:tp.alt,age:0,det:!T.fall,seed:Math.random()*1000,n:(f&&f.n)||1,usd:(f&&f.usd)||0,trader:f&&f.trader,fullStack:f&&f.fullStack};
  if (T.k==='cruise'){ // diagonal inbound from upper-right; smoke trail while streaking
    b.x0=tp.x+280; b.y0=bombY(b)-220; b.x1=tp.x; b.y1=bombY(b); }
  S.bombs.push(b); if(b.det) detonate(b);
  if(tier>=1) S.bombs.length>6&&S.bombs.shift();
  return b;
}
function bombY(b){ return clamp(altToScreenY(b.alt),40,H-40); }
function addShake(amp,f,tau){ if(!S.shakeOn||amp<=0) return; S.camShakes.push({amp,f,tau,t0:S.t,ph:Math.random()*6.28,ph2:Math.random()*6.28}); }
/* Damped, smooth camera offset: Σ A·e^(−t/τ)·sin(2πft+φ) with a 40 ms attack. No per-frame randomness → never jittery. */
function camOffset(){ let x=0,y=0;
  for (const s of S.camShakes){ const t=S.t-s.t0, env=s.amp*Math.exp(-t/s.tau)*(1-Math.exp(-t/0.04));
    x+=env*(Math.sin(6.2832*s.f*t+s.ph)+0.35*Math.sin(6.2832*s.f*1.73*t+s.ph2));
    y+=env*0.8*(Math.cos(6.2832*s.f*0.87*t+s.ph2)+0.3*Math.sin(6.2832*s.f*2.1*t+s.ph)); }
  if (S.shakeOn && S.shake>0){ const a=7*S.shake; x+=a*Math.sin(S.t*47); y+=a*Math.cos(S.t*39); }   // legacy orb-hit shake, now smooth
  const m=Math.hypot(x,y); if(m>SHAKE_MAX){ x*=SHAKE_MAX/m; y*=SHAKE_MAX/m; } return {x,y}; }
function spawnPuff(){ const tp=tipPoint(), y=altToScreenY(tp.alt);
  for(let i=0;i<7;i++) S.bfx.push({k:'smoke',x:tp.x-10,y:y+(Math.random()-.5)*8,vx:-60-Math.random()*90,vy:(Math.random()-.5)*50,r:5+Math.random()*5,gr:28,life:0.6,max:0.6,drag:3,c:'225,215,190',a:0.32});
  for(let i=0;i<4;i++) S.bfx.push({k:'spark',x:tp.x,y,vx:-120-Math.random()*120,vy:(Math.random()-.5)*90,r:1.6,life:0.3,max:0.3,drag:4,c:'255,220,150',a:0.8}); }
function burst(x,y,n,spd,opt){ for(let i=0;i<n;i++){ const a=Math.random()*6.2832, v=spd*(0.35+Math.random()*0.65);
  S.bfx.push(Object.assign({x,y,vx:Math.cos(a)*v,vy:Math.sin(a)*v,r:2,life:1,max:1,drag:2,c:'255,220,140',a:1,k:'spark'},typeof opt==='function'?opt(i,a):opt)); } }
function detonate(b){
  const x=b.x, y=bombY(b), k=b.T.k; b.y0=y; b.detAge=b.age;
  addShake(b.T.shake*(k==='atom'?1:clamp(0.8+b.pct/(b.T.min*4),0.8,1.2)), b.T.sf, b.T.tau);
  const who=b.trader||'—', lbl=`${b.T.name} −${b.pct>=10?b.pct.toFixed(0):b.pct.toFixed(1)}%${b.fullStack?' · FULL STACK':''} · ${who}${b.usd>0?' '+(b.usd<10?fmtShot(b.usd):fmtUsd(b.usd)):''}${b.n>1?' ×'+b.n:''}`;
  S.bombLabels.push({txt:lbl,x,y,tier:b.tier,age:0,life:k==='atom'?3.2:k==='grenade'?1.4:2.0});
  if (k==='grenade'){
    burst(x,y,16,320,{k:'streak',r:1.6,life:0.45,max:0.45,drag:5,c:'255,236,170'});
    burst(x,y,8,60,{k:'smoke',r:7,gr:30,life:0.9,max:0.9,drag:2,c:'90,80,80',a:0.45});
  } else if (k==='bunker'){
    burst(x,y,22,360,(i,a)=>({k:'chunk',r:2.5+Math.random()*2.5,life:1.1,max:1.1,drag:1.2,g:520,vy:-Math.abs(Math.sin(a))*300-60,c:i%3?'120,95,70':'255,210,120'}));
    burst(x,y,10,90,{k:'smoke',r:10,gr:40,life:1.4,max:1.4,drag:2,c:'70,60,58',a:0.5});
    b.cracks=[...Array(7)].map((_,i)=>{ let px=0,py=0,pts=[[0,0]], a=Math.PI*(0.15+0.7*i/6)+(Math.random()-.5)*0.3, L=50+Math.random()*90;
      for(let s=0;s<6;s++){ a+=(Math.random()-.5)*0.7; px+=Math.cos(a)*L/6; py+=Math.abs(Math.sin(a))*L/6; pts.push([px,py]); } return pts; });
  } else if (k==='cruise'){ // mid-size blast = former daisy-cutter impact
    burst(x,y,40,520,{k:'ember',r:2.4,life:1.3,max:1.3,drag:1.6,g:160,c:'255,200,110'});
    burst(x,y,14,140,{k:'smoke',r:18,gr:60,life:1.8,max:1.8,drag:1.8,c:'60,48,46',a:0.5});
  } else if (k==='nuke'){
    burst(x,y,70,760,{k:'ember',r:2.8,life:1.7,max:1.7,drag:1.3,g:140,c:'255,215,130'});
    burst(x,y,22,220,{k:'smoke',r:26,gr:80,life:2.4,max:2.4,drag:1.5,c:'55,44,44',a:0.55});
    S.screenFlash={t0:S.t,dur:0.45,a:0.55,c:'255,240,200'}; S.cloudPush.push({x,y,amp:260,t0:S.t});
  } else if (k==='atom'){
    burst(x,y,110,900,{k:'ember',r:3,life:2.2,max:2.2,drag:1.1,g:90,c:'255,225,150'});
    S.screenFlash={t0:S.t,dur:0.9,a:0.95,c:'255,255,250'}; S.cloudPush.push({x,y,amp:520,t0:S.t});
    S.slowmoUntil=S.t+SLOWMO_S*SLOWMO_SCALE; S.scorch=1;
    addShake(9,1.6,1.6);   // low rumble layered under the main hit
    b.puffs=[...Array(26)].map((_,i)=>({a:Math.random()*6.2832,r:Math.random(),s:0.6+Math.random()*0.6,ph:Math.random()*6}));
  }
}
function drawBombs(){
  if (!S.bombs.length && !S.bfx.length && !S.bombLabels.length) return;
  ctx.save();
  for (const b of S.bombs){ const k=b.T.k, x=b.x, yT=bombY(b);
    if (!b.det){ // inbound: cruise streaks diagonally w/ smoke; others fall from above
      const u=b.age/b.T.fall;
      if (k==='cruise'){
        const x1=b.x1!=null?b.x1:x, y1=b.y1!=null?b.y1:yT, x0=b.x0!=null?b.x0:x+280, y0=b.y0!=null?b.y0:yT-220;
        const mx=x0+(x1-x0)*u*u, my=y0+(y1-y0)*u*u, ang=Math.atan2(y1-y0,x1-x0);
        if ((b._trail|0)<Math.floor(u*18)){ b._trail=Math.floor(u*18);
          S.bfx.push({k:'smoke',x:mx-Math.cos(ang)*12,y:my-Math.sin(ang)*12,vx:-20+Math.random()*10,vy:-10+Math.random()*20,r:6+Math.random()*8,gr:20,life:0.7,max:0.7,drag:2,c:'160,150,140',a:0.4}); }
        ctx.save(); ctx.translate(mx,my); ctx.rotate(ang);
        ctx.globalCompositeOperation='lighter';
        const tg=ctx.createLinearGradient(-90,0,0,0); tg.addColorStop(0,'rgba(255,230,160,0)'); tg.addColorStop(1,'rgba(255,220,140,.75)');
        ctx.fillStyle=tg; ctx.fillRect(-90,-2.5,90,5);
        ctx.globalCompositeOperation='source-over';
        ctx.fillStyle='#3a3540'; ctx.strokeStyle='#ffd77a'; ctx.lineWidth=1.4;
        ctx.beginPath(); ctx.moveTo(18,0); ctx.lineTo(-16,-5); ctx.lineTo(-16,5); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle='#ffd77a'; ctx.beginPath(); ctx.moveTo(-16,-5); ctx.lineTo(-28,-9); ctx.lineTo(-22,0); ctx.lineTo(-28,9); ctx.lineTo(-16,5); ctx.fill();
        ctx.restore(); continue;
      }
      const y=yT-(1-u*u)*320, s=k==='atom'?1.6:k==='nuke'?1.35:1;
      ctx.save(); ctx.translate(x,y); ctx.globalCompositeOperation='lighter';
      const g=ctx.createLinearGradient(0,-70*s,0,0); g.addColorStop(0,'rgba(255,230,160,0)'); g.addColorStop(1,'rgba(255,230,160,.7)'); ctx.fillStyle=g; ctx.fillRect(-3*s,-70*s,6*s,70*s);
      ctx.globalCompositeOperation='source-over'; ctx.fillStyle='#2a2730'; ctx.strokeStyle='#ffd77a'; ctx.lineWidth=1.5;
      ctx.beginPath(); ctx.ellipse(0,0,7*s,16*s,0,0,6.2832); ctx.fill(); ctx.stroke();
      ctx.fillStyle='#ffd77a'; ctx.beginPath(); ctx.moveTo(-7*s,-12*s); ctx.lineTo(-12*s,-22*s); ctx.lineTo(12*s,-22*s); ctx.lineTo(7*s,-12*s); ctx.fill();
      ctx.restore(); continue; }
    const t=b.age-(b.T.fall||0), L=b.T.life, y=yT, u=t/L;
    ctx.globalCompositeOperation='lighter';
    if (k==='grenade'){ const r=10+70*(1-Math.exp(-t*9)), a=Math.max(0,1-t/0.5);
      fireball(x,y,r*0.7,a); ring(x,y,r,a*0.9,2,'255,236,170'); }
    if (k==='bunker'){ const a=Math.max(0,1-u);
      ctx.globalCompositeOperation='source-over'; ctx.save(); ctx.translate(x,y);   // ground crack w/ divine glow in the seams
      for (const c of b.cracks){ ctx.beginPath(); c.forEach((p,i)=>i?ctx.lineTo(p[0]*(0.4+0.6*Math.min(1,t*5)),p[1]*(0.4+0.6*Math.min(1,t*5))):ctx.moveTo(0,0));
        ctx.strokeStyle=`rgba(20,12,10,${0.8*a})`; ctx.lineWidth=4; ctx.stroke(); ctx.strokeStyle=`rgba(255,215,120,${0.9*a})`; ctx.lineWidth=1.4; ctx.shadowColor='rgba(255,200,90,.9)'; ctx.shadowBlur=8; ctx.stroke(); ctx.shadowBlur=0; }
      ctx.restore(); ctx.globalCompositeOperation='lighter';
      fireball(x,y,60*(1-Math.exp(-t*8)),Math.max(0,1-t/0.6));
      ring(x,y,30+260*(1-Math.exp(-t*3.5)),Math.max(0,1-t/1.0)*0.8,4,'255,225,160'); }
    if (k==='cruise'){ fireball(x,y,40+140*(1-Math.exp(-t*5)),Math.max(0,1-t/1.3));
      ring(x,y,60+460*(1-Math.exp(-t*2.6)),Math.max(0,1-t/1.2),7,'255,245,215');
      godRays(x,y,240,Math.max(0,1-t/0.9)*0.5,b.seed,10); }
    if (k==='nuke'){ fireball(x,y,60+260*(1-Math.exp(-t*3.6)),Math.max(0,1-t/1.8));
      ring(x,y,80+900*(1-Math.exp(-t*2.0)),Math.max(0,1-t/1.6),10,'255,250,230');
      godRays(x,y,520,Math.max(0,1-t/1.4)*0.6,b.seed,14); }
    if (k==='atom') drawMushroom(b,x,y,t);
  }
  // particles
  for (const p of S.bfx){ const a=p.a*clamp(p.life/p.max,0,1);
    if (p.k==='smoke'){ ctx.globalCompositeOperation='source-over'; const g=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,p.r); g.addColorStop(0,`rgba(${p.c},${a})`); g.addColorStop(1,`rgba(${p.c},0)`); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,6.2832); ctx.fill(); }
    else if (p.k==='streak'){ ctx.globalCompositeOperation='lighter'; ctx.strokeStyle=`rgba(${p.c},${a})`; ctx.lineWidth=p.r; ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x-p.vx*0.06,p.y-p.vy*0.06); ctx.stroke(); }
    else if (p.k==='chunk'){ ctx.globalCompositeOperation='source-over'; ctx.fillStyle=`rgba(${p.c},${a})`; ctx.fillRect(p.x-p.r,p.y-p.r,p.r*2,p.r*2); }
    else { ctx.globalCompositeOperation='lighter'; ctx.fillStyle=`rgba(${p.c},${a})`; ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,6.2832); ctx.fill(); } }
  ctx.restore(); ctx.globalCompositeOperation='source-over'; ctx.globalAlpha=1;
}
function fireball(x,y,r,a){ if(a<=0||r<=1) return; const g=ctx.createRadialGradient(x,y,0,x,y,r);
  g.addColorStop(0,`rgba(255,255,250,${a})`); g.addColorStop(0.25,`rgba(255,240,180,${a})`); g.addColorStop(0.55,`rgba(255,170,60,${0.8*a})`); g.addColorStop(0.8,`rgba(220,70,30,${0.45*a})`); g.addColorStop(1,'rgba(120,20,10,0)');
  ctx.fillStyle=g; ctx.beginPath(); ctx.arc(x,y,r,0,6.2832); ctx.fill(); }
function ring(x,y,r,a,w,c){ if(a<=0) return; ctx.strokeStyle=`rgba(${c},${a})`; ctx.lineWidth=w; ctx.shadowColor=`rgba(${c},${a})`; ctx.shadowBlur=w*3; ctx.beginPath(); ctx.arc(x,y,r,0,6.2832); ctx.stroke(); ctx.shadowBlur=0; }
function godRays(x,y,R,a,seed,n){ if(a<=0) return; for(let i=0;i<n;i++){ const ang=hash(seed+i)*6.2832, w=0.04+0.05*hash(seed+i*3);
  const g=ctx.createRadialGradient(x,y,0,x,y,R); g.addColorStop(0,`rgba(255,248,215,${a})`); g.addColorStop(1,'rgba(255,230,160,0)'); ctx.fillStyle=g;
  ctx.beginPath(); ctx.moveTo(x,y); ctx.arc(x,y,R,ang-w,ang+w); ctx.closePath(); ctx.fill(); } }
function drawMushroom(b,x,y,t){
  const grow=1-Math.exp(-t*1.4), fade=clamp((b.T.life-t)/1.4,0,1), H0=300*grow, capR=60+120*grow, cy=y-H0;
  ctx.globalCompositeOperation='lighter';
  fireball(x,y,80+180*(1-Math.exp(-t*4)),Math.max(0,1-t/1.2));
  ring(x,y,60+1700*(1-Math.exp(-t*1.3)),Math.max(0,1-t/2.2),14,'255,255,240');      // shockwave crosses the screen
  ring(x,y+4,40+420*(1-Math.exp(-t*1.8)),Math.max(0,1-t/2.6)*0.7,6,'255,215,140');    // base surge
  godRays(x,cy,700,Math.max(0,1-t/1.6)*0.3,b.seed,18);
  // stem
  ctx.globalCompositeOperation='source-over';
  const sg=ctx.createLinearGradient(0,cy,0,y); sg.addColorStop(0,`rgba(255,190,90,${0.85*fade})`); sg.addColorStop(0.5,`rgba(170,90,50,${0.75*fade})`); sg.addColorStop(1,`rgba(90,60,55,${0.6*fade})`);
  ctx.fillStyle=sg; const sw=18+26*grow; ctx.beginPath(); ctx.moveTo(x-sw*1.8,y); ctx.quadraticCurveTo(x-sw*0.6,(y+cy)/2,x-sw,cy); ctx.lineTo(x+sw,cy); ctx.quadraticCurveTo(x+sw*0.6,(y+cy)/2,x+sw*1.8,y); ctx.fill();
  for(let i=0;i<9;i++){ const v=i/8, py=lerp(y,cy,v), rr=sw*(1.6-0.6*v)+6, g=ctx.createRadialGradient(x,py,0,x,py,rr); g.addColorStop(0,`rgba(${Math.round(lerp(120,240,v))},${Math.round(lerp(80,150,v))},60,${0.6*fade})`); g.addColorStop(1,'rgba(80,55,50,0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(x+Math.sin(t*2+i)*3,py,rr,0,6.2832); ctx.fill(); }
  // cap: rolling toroid of puffs, hot gold core cooling to smoke at the rim
  for (const p of b.puffs){ const ang=p.a+t*0.35*p.s, rx=Math.cos(ang)*capR*(0.35+0.7*p.r), ry=Math.sin(ang)*capR*0.42*(0.4+0.6*p.r)-capR*0.12;
    const rr=capR*0.42*p.s, px=x+rx, py=cy+ry, hot=clamp(1-p.r*0.8-t*0.18,0,1);
    const g=ctx.createRadialGradient(px,py,0,px,py,rr);
    g.addColorStop(0,`rgba(${Math.round(lerp(120,255,hot))},${Math.round(lerp(70,170,hot))},${Math.round(lerp(55,70,hot))},${fade})`); g.addColorStop(0.65,`rgba(${Math.round(lerp(80,200,hot))},${Math.round(lerp(55,90,hot))},45,${0.75*fade})`); g.addColorStop(1,`rgba(60,45,45,0)`);
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(px,py,rr,0,6.2832); ctx.fill(); }
  ctx.globalCompositeOperation='lighter'; fireball(x,cy-capR*0.1,capR*0.45,0.35*fade*clamp(1.4-t*0.35,0,1));
  ctx.globalCompositeOperation='source-over';
}
function drawBombScreen(){ // un-shaken overlays: flash + label pops
  if (S.screenFlash){ const f=S.screenFlash, u=(S.t-f.t0)/f.dur; if(u>=1) S.screenFlash=null; else { ctx.fillStyle=`rgba(${f.c},${f.a*Math.pow(1-u,1.6)})`; ctx.fillRect(0,0,W,H); } }
  for (const l of S.bombLabels){ const pop=l.age<0.18?0.6+0.55*(l.age/0.18):1.15-0.15*Math.min(1,(l.age-0.18)/0.15), a=clamp((l.life-l.age)/0.5,0,1);
    const fs=[13,15,18,21,25,30][l.tier]; ctx.save(); ctx.globalAlpha=a; ctx.font=`bold ${fs}px Georgia,serif`; ctx.textAlign='center';
    const w=ctx.measureText(l.txt).width, lx=clamp(l.x,w/2+20,W-w/2-20), ly=clamp(l.y-90-l.age*18-(l.tier>=5?120:0),BANNER_Y+50,H-30);
    ctx.translate(lx,ly); ctx.scale(pop,pop);
    ctx.fillStyle='rgba(10,8,20,.62)'; ctx.beginPath(); ctx.roundRect?ctx.roundRect(-w/2-12,-fs*0.95,w+24,fs*1.45,8):ctx.rect(-w/2-12,-fs*0.95,w+24,fs*1.45); ctx.fill();
    ctx.lineWidth=3; ctx.strokeStyle='rgba(60,20,0,.9)'; ctx.strokeText(l.txt,0,0);
    ctx.shadowColor='rgba(255,210,120,.9)'; ctx.shadowBlur=12; ctx.fillStyle=l.tier>=5?'#fffdf2':'#ffd77a'; ctx.fillText(l.txt,0,0); ctx.restore(); }
}
/* Debug hooks: ?debugBomb=puff|grenade|bunker|cruise|nuke|atom|cycle  [&debugBombAt=1.2]
   Aliases: daisy→cruise, moab→nuke. window.__flight.bomb('nuke') or bomb(7.5) (impact %). */
function debugBomb(spec,opt){ opt=opt||{};
  if (typeof spec==='string' && BOMB_ALIASES[spec]) spec=BOMB_ALIASES[spec];
  const i=typeof spec==='number'?null:BOMB_TIERS.findIndex(t=>t.k===spec);
  const pct=typeof spec==='number'?spec:[0.8,3.2,8,18,35,55][Math.max(0,i)];
  noteSell({side:'sell',usd:opt.usd??[40,600,8900,31e3,120e3,480e3][Math.max(0,bombTierOf(pct))],impactPct:pct,trader:opt.trader||'0xabc1230000000000000000000000000000def456',fullStack:!!opt.fullStack}); }

/* =====================================================================
   UPDATE LOOP — render at rAF, state only from confirmed events
   ===================================================================== */
let last=performance.now();
const FIXED_DT=+Q.get('fixedDt')>0?1/+Q.get('fixedDt'):0, CAPTURE=Q.get('capture')==='1';   // ?fixedDt=30 deterministic step; ?capture=1 = manual __flight.step(n)
const RAF=f=>{ if(!CAPTURE) requestAnimationFrame(f); };
function frame(now){
  // Clamp dt hard so headless rAF stalls cannot blow the heading/alt springs.
  const rawDt=FIXED_DT||Math.min(1/20,Math.max(1/240,(now-last)/1000)); last=now;
  // ATOM slow-mo: eased time scale (uniform dt scaling keeps every spring smooth)
  const tsT=S.t<S.slowmoUntil?SLOWMO_SCALE:1; S.timeScale=lerp(S.timeScale,tsT,1-Math.exp(-rawDt*(tsT<1?30:5)));
  const dt=rawDt*S.timeScale; S.t+=dt;
  if (S.confirmed.mcap===null || loaded<names.length){ drawLoading(); RAF(frame); return; }
  if (DEBUG_BOMB && !S._dbgFired && S.t>=DEBUG_BOMB_AT){ S._dbgFired=true; runDebugBomb(); }
  /* SPRING — altitude tracks price. ω≈22 rad/s, ζ≈0.72 → ~150 ms rise with a little overshoot.
     Tunables: SPRING_W (stiffness), SPRING_Z (damping; <1 overshoots). */
  const SPRING_W=22, SPRING_Z=0.72;
  const target=mcapToAlt(S.confirmed.mcap);
  const altErr=target-S.displayAlt;
  S.altVel=(S.altVel||0)+ (SPRING_W*SPRING_W*altErr - 2*SPRING_Z*SPRING_W*(S.altVel||0))*dt;
  S.displayAlt+=(S.altVel||0)*dt;
  if (Math.abs(altErr)<2e-5 && Math.abs(S.altVel)<2e-4){ S.displayAlt=target; S.altVel=0; }
  // volume EMAs decay (τ≈6s) → exhaust intensity
  const dec=Math.exp(-dt/6); S.volEma*=dec; S.buyEma*=dec; S.sellEma*=dec;
  // lateral steering — cosmetic only. Laggy follow so A/D banks instead of teleporting.
  const steer=performance.now()<S.slowUntil?3:7;           // VOID orb penalty: sluggish steering
  const nx=lerp(S.x,LANES[S.lane],1-Math.exp(-dt*steer)); S.vx=(nx-S.x)/Math.max(dt,1e-3); S.x=nx;
  const bankTarget=clamp(-S.vx/900,-0.38,0.38);
  S.bank=lerp(S.bank||0,bankTarget,1-Math.exp(-dt*6));
  // price velocity in px/s (unsmoothed, for clouds / speed lines) then a short visual smoother
  const vUpRaw=(S.displayAlt-(S.prevAlt??S.displayAlt))/Math.max(dt,1e-3)*PX_PER_ALT; S.prevAlt=S.displayAlt;
  S.vUp=vUpRaw;
  S.vxS=lerp(S.vxS||0,S.vx*0.55,1-Math.exp(-dt*8));
  // Flush coalesced thrusts once per frame (many swaps → one net size-based angle).
  flushThrustQueue();
  // THRUST ANGLE — sized climb, ease to horizontal. One smoothed heading target.
  // Heading: 0=nose up, π/2=right (flat), π=down. aimDeg = deg from horizontal (+buy/−sell).
  const FLAT_EPS=8; // px/s considered "no price move"
  const EASE_S=1.0; // ~1s ease from thrust angle → flat after last trade
  const sinceThrust=S.t-(S.thrustT||-99);
  const flat=Math.abs(vUpRaw)<FLAT_EPS && Math.abs(altErr)*PX_PER_ALT<12 && sinceThrust>0.35;
  if (flat){ if(!S.flatSince) S.flatSince=S.t; } else if (sinceThrust<0.35) S.flatSince=0;
  const wantCruise=sinceThrust>EASE_S && flat ? 1 : 0;
  S.cruise=lerp(S.cruise||0, wantCruise, 1-Math.exp(-dt*(wantCruise?5:12)));
  // decay displayed aim toward 0 once thrust window ends (smoothstep over EASE_S)
  let showAim=S.aimDeg||0;
  if (sinceThrust>0.12){
    const u=clamp((sinceThrust-0.12)/EASE_S,0,1);
    const s=u*u*(3-2*u);
    showAim=showAim*(1-s);
    if (u>=1) S.aimDeg=0;
  }
  // atan2(priceΔ,timeΔ) blend removed — tiny noisy deltas were flipping the heading target every frame.
  // Single heading target: rate-limit aim (max deg/s), then critically-damped spring.
  const MAX_AIM_RATE=110; // deg/s
  let wantAim=showAim;
  const curAimFromTarget=((Math.PI/2)-(S.headTarget??Math.PI/2))*180/Math.PI;
  const dAim=wantAim-curAimFromTarget;
  const maxStep=MAX_AIM_RATE*dt;
  if (Math.abs(dAim)>maxStep) wantAim=curAimFromTarget+Math.sign(dAim)*maxStep;
  const bankAmt=(S.bank||0)*(sinceThrust>EASE_S?1:0.15);
  S.headTarget=Math.PI/2 - wantAim*Math.PI/180 + bankAmt;
  // Critically damped (ζ=1) heading spring — no overshoot. Shortest-angle error.
  const HEAD_W=9; // rad/s natural freq (~settles ~0.45s)
  let d=S.headTarget-S.heading; d=Math.atan2(Math.sin(d),Math.cos(d));
  S.headVel=(S.headVel||0)+(HEAD_W*HEAD_W*d - 2*1.0*HEAD_W*(S.headVel||0))*dt;
  // also rate-limit angular velocity (~180 deg/s)
  const MAX_OMEGA=Math.PI; // rad/s
  S.headVel=clamp(S.headVel,-MAX_OMEGA,MAX_OMEGA);
  S.heading+=S.headVel*dt;
  S.heading=Math.atan2(Math.sin(S.heading),Math.cos(S.heading)); S.tilt=S.heading;
  // Camera follows smoothed rocket / altitude (kills spring overshoot jitter at 10× zoom).
  if (S.camAlt==null) S.camAlt=S.displayAlt;
  if (S.camX==null) S.camX=S.x;
  S.camAlt=lerp(S.camAlt, S.displayAlt, 1-Math.exp(-dt*6));
  S.camX=lerp(S.camX, S.x, 1-Math.exp(-dt*8));
  // idle bob / sway / micro-rot — attenuated during thrust so they don't fight heading
  const thrustHold=sinceThrust<1.2? clamp(1-sinceThrust/1.2,0,1) : 0;
  const amp=(1+(Math.abs(vUpRaw)/500))*(1-0.7*thrustHold);
  S.bob=(Math.sin(S.t*1.7)*3.2*amp + Math.sin(S.t*3.1+1.2)*1.4)*(1-0.55*thrustHold);
  S.sway=(Math.sin(S.t*1.15+0.4)*4.5 + Math.sin(S.t*2.4)*1.6)*(1-0.55*thrustHold) + (S.bank||0)*-12;
  S.microRot=(Math.sin(S.t*1.35)*0.012 + Math.sin(S.t*2.8+0.7)*0.006)*(1-0.8*thrustHold) + (S.bank||0)*0.05;
  S.roll=1; // kept for compat; draw path no longer scaleX-wobbles
  S.glint=Math.sin(S.t*1.8);
  // parallax scroll: clouds/bg move with price velocity; sideways adds horizontal drift
  S.cloudY=(S.cloudY||0)+vUpRaw*dt*0.85;
  const drift=(S.cruise||0)*(140+Math.abs(vUpRaw)*0.2);
  S.bgScrollX=(S.bgScrollX||0)+drift*dt;
  // speed streaks on strong moves
  if (Math.abs(vUpRaw)>160 && Math.random()<dt*18){
    S.speedBits.push({x:Math.random()*W,y:Math.random()*H,len:40+Math.random()*90,w:1+Math.random()*1.5,life:0.45,up:vUpRaw>0,dx:(Math.random()-.5)*12});
  }
  for (const b of S.speedBits){ b.life-=dt*1.8; b.y+= (b.up?1:-1)*vUpRaw*dt*0.15; }
  S.speedBits=S.speedBits.filter(b=>b.life>0).slice(-40);
  // trailing tick polyline: tip at nozzle, scrolls left. Flat crawl + angled thrust segments.
  // Use stable S.x (no sway) so flat segments stay steady frame-to-frame.
  const tipX=S.x;
  const scroll=(110+drift)*dt; // base time-advance so flats read as horizontal crawl
  for (const p of S.trail) p.x-=scroll;
  for (const b of S.bombs) b.x-=scroll*(b.tier>=4?0.3:1);   // big blasts hang on screen longer for (const p of S.bfx) p.x-=scroll; for (const l of S.bombLabels) l.x-=scroll;
  if (!S._trailAcc) S._trailAcc=0; S._trailAcc+=dt;
  const moved=S.lastTrailAlt==null || Math.abs(S.displayAlt-S.lastTrailAlt)*PX_PER_ALT>1.5;
  if (S._trailAcc>0.07 || moved){ S._trailAcc=0;
    const tick=moved && Math.abs(vUpRaw)>10;
    S.trail.push({x:tipX, alt:S.displayAlt, tick, thrust:tick && sinceThrust<0.25});
    S.lastTrailAlt=S.displayAlt;
    if (S.trail.length>64) S.trail.shift();
  }
  S.trail=S.trail.filter(p=>p.x>-40);
  S.shake=Math.max(0,S.shake-dt*2); if(performance.now()>S.multUntil) S.mult=1;
  for (const f of S.floaters){ f.y-=40*dt; f.life-=dt*0.9; } S.floaters=S.floaters.filter(f=>f.life>0);
  // tier change banner
  const ti=clamp(Math.floor(target),0,TIERS.length-1); if (ti!==S.tierShown){ if(S.tierShown>=0){ S.tierBanner=2.2; award('tier'+ti,'TIER WITNESS','crossed into '+TIERS[ti].name); } S.tierShown=ti; }
  S.tierBanner=Math.max(0,S.tierBanner-dt);
  // particles
  for (const p of S.particles){ p.x+=p.vx*dt; p.y+=p.vy*dt; p.life-=dt*2.2; } S.particles=S.particles.filter(p=>p.life>0);
  for (const s of S.shards){ s.x+=s.vx*dt; s.y+=s.vy*dt; s.vy+=500*dt; s.life-=dt*0.9; } S.shards=S.shards.filter(s=>s.life>0);
  S.flashes.forEach(f=>f.life-=dt*0.8); S.flashes=S.flashes.filter(f=>f.life>0);
  // motes drift down (speed ∝ trade flow), collect by steering
  const flow=1+Math.log10(1+S.buyEma)*0.5;
  // OFF-CHAIN ORB LAYER: reward spawn ∝ buy flow, penalty spawn ∝ sell flow (server-seeded in prod)
  const lane=()=>LANES[Math.floor(Math.random()*3)];
  const P=ORB_SPAWN, room=S.orbsOn&&S.motes.length+S.obstacles.length<P.maxOnScreen&&S.t-S.lastOrbT>=P.minGap;
  if (room&&Math.random()<dt*Math.min(P.rewardMax,P.rewardBase+P.rewardFlow*Math.log10(1+S.buyEma))){ const r=Math.random(); S.motes.push({k:r<0.80?'halo':r<0.95?'mult':'rhalo',x:lane(),y:-20,v:90+Math.random()*40}); S.lastOrbT=S.t; }
  else if (room&&Math.random()<dt*Math.min(P.penaltyMax,P.penaltyBase+P.penaltyFlow*Math.log10(1+S.sellEma))){ S.obstacles.push({k:Math.random()<0.7?'storm':'void',x:lane(),y:-40,v:100}); S.lastOrbT=S.t; }
  for (const m of S.motes){ m.y+=m.v*dt*flow; if (Math.abs(m.x-S.x)<50&&Math.abs(m.y-ROCKET_Y)<40){ m.dead=true; const T=ORB[m.k];
      if (m.k==='mult'){ S.mult=2; S.multUntil=performance.now()+10000; }
      if (m.k==='rhalo') S.rhalo++;
      const pts=T.pts*S.mult*(1+Math.floor(S.streak/10)); S.score+=pts; S.streak++; S.collected++;
      S.floaters.push({x:m.x,y:m.y-20,txt:m.k==='mult'?'×2 POINTS 10s':m.k==='rhalo'?'+1 rHALO claim':'+'+pts,c:T.rim||'#ffe7a3',life:1.2});
      if(S.streak===10) award('streak10','PERFECT LANE ×10','10 reward orbs in a row'); if(S.collected===25) award('c25','HALO HOARDER','25 reward orbs collected'); } }
  for (const o of S.obstacles){ o.y+=o.v*dt*flow; if (!o.hit&&Math.abs(o.x-S.x)<50&&Math.abs(o.y-ROCKET_Y)<40){ o.hit=true; o.dead=true; const T=ORB[o.k];
      const loss=Math.min(S.score,T.pts); S.score-=loss; S.streak=0; S.shake=1; if(o.k==='void') S.slowUntil=performance.now()+3000;
      S.floaters.push({x:o.x,y:o.y-20,txt:'−'+loss+(o.k==='void'?' · SLOWED 3s':' · streak lost'),c:'#ff5a6a',life:1.4});
      S.flashes.push({txt:o.k==='void'?'VOID ORB · steering slowed':'STORM ORB · −'+loss+' pts',life:1.2,c:'#ff7a85'});
      for(let i=0;i<30;i++) S.shards.push({x:o.x,y:o.y,vx:(Math.random()-.5)*320,vy:(Math.random()-.5)*320,life:1,c:'#ff3344'}); } }
  S.motes=S.motes.filter(m=>!m.dead&&m.y<H+30); S.obstacles=S.obstacles.filter(o=>!o.dead&&o.y<H+50);
  bombStep(dt);
  S.toasts.forEach(t=>t.life-=dt*0.6); S.toasts=S.toasts.filter(t=>t.life>0);
  if (Object.entries(S.fuelers).sort((a,b)=>b[1]-a[1])[0][0]==='you') award('koth','KING OF THE HILL','top fueler on this coin');

  const co=camOffset(); ctx.save(); ctx.translate(co.x,co.y);   // damped smooth shake (bombs + legacy orb hit)
  drawBg(); drawClouds(); drawSpeedLines(); drawLanes(); drawLevels(); drawEntryLine(); drawTickTrail(); drawFx(dt); drawBombs(); drawRocket(dt); ctx.restore(); drawPost(); drawBombScreen(); drawHud();
  if (window.__flightLog){ const h=S.heading, prev=window.__flightLogPrevH; const dh=prev==null?0:Math.atan2(Math.sin(h-prev),Math.cos(h-prev)); window.__flightLogPrevH=h;
    window.__flightLog.push({t:S.t,dt,heading:h,headingDeg:h*180/Math.PI,dHeadingDeg:dh*180/Math.PI,aimDeg:S.aimDeg||0,x:S.x,camX:S.camX,bob:S.bob||0,sway:S.sway||0,displayAlt:S.displayAlt,camAlt:S.camAlt,altVel:S.altVel||0,cruise:S.cruise||0}); }
  RAF(frame);
}
RAF(frame);
if (Q.get('launched')==='1'){ const f=document.getElementById('launchFade'); f.style.transition='none'; f.style.opacity=1; S.altVel=-0.25; requestAnimationFrame(()=>requestAnimationFrame(()=>{ f.style.transition='opacity .9s ease'; f.style.opacity=0; })); }
const DEBUG_BOMB=Q.get('debugBomb'), DEBUG_BOMB_AT=+(Q.get('debugBombAt')||1.2);
function runDebugBomb(){ if(DEBUG_BOMB==='cycle'){ ['puff','grenade','bunker','cruise','nuke','atom'].forEach((k,i)=>setTimeoutSim(()=>debugBomb(k),i*2.4)); } else debugBomb(isNaN(+DEBUG_BOMB)?DEBUG_BOMB:+DEBUG_BOMB,{fullStack:Q.get('fullStack')==='1'}); }
const simTimers=[]; function setTimeoutSim(fn,d){ simTimers.push({at:S.t+d,fn}); }
window.__flight={bomb:(k,o)=>debugBomb(k,o),estimateImpactPct,BOMB_PCT,BOMB_TIERS,setBombs,setShake,step:n=>{ for(let i=0;i<(n||1);i++) frame(performance.now()); },ORB_SPAWN,setOrbs,MODES,MIN_SHOT,GAS_USD,ORB,trade,autoMode,S,source,mcapToAlt,altToMcap,TIERS,CLOUDS,climbAngleDeg,applyThrust,queueThrust,flushThrustQueue};   // for tests / console

})();
