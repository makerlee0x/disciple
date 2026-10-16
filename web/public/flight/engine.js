/* DISCIPLE flight engine — ported from prototype/game.html (faithful port).
 * Prerequisites on the page: #c canvas, #orbBtn, #launchFade, optional #exitX.
 * Set window.REPLAY before running, or fetch /replay.json.
 * Query string: ?replay=1&speed=&zoom=&source=&coin=&launched=1&debugBomb=
 */
(function(){
/* Hidden tab: interval ticks are skipped (sources, polls, paper decay) and the rAF loop stops; both resume on
   visibilitychange. Shadowing setInterval here covers every source class below without touching each one. */
const _setInterval=window.setInterval.bind(window);
function setInterval(fn,ms){ return _setInterval(()=>{ if(!document.hidden) fn(); }, ms); }
'use strict';
/* =====================================================================
   DISCIPLE flight prototype — single file, no build step, runs offline.
   Data source: default = LIVE real pool (AI/WETH Uniswap v3 on Robinhood Chain, RPC getLogs)
   ?replay=1[&speed=4]  replay of 30 min of real swaps (replay.js)   ?source=mock | dexscreener | rpc
   ?zoom=N altitude zoom (default 10 for the real pool)
   ===================================================================== */
let W = 1280, H = 720;                         // logical size = the wrap's CSS size (set in resize); no letterbox
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
const PX_PER_ALT = 1.5*H*(+new URLSearchParams(location.search).get('zoom') || (['mock','dexscreener','rpc'].includes(new URLSearchParams(location.search).get('source'))?3:10));   // real pool: ×10 so a ~1% move ≈ 150 px; mock/coarse feeds ×3 (was ×1: climbs/drops were barely visible)
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
/* AMMO TIERS — preset $ sizes scale with the rocket's mcap tier so each preset is a similar % impact.
   Single source of truth: web/lib/flight/ammoTiers.ts (documented in docs/ammo-tiers.md), handed to the engine as
   window.__AMMO_TIERS by FlightCanvas before this script loads. Without it, MODES keep their fixed defaults.
   S.ammoTier = the player's chosen preset tier; S.rocketAmmoTier = the tier the rocket's mcap is in (5% hysteresis).
   Tier-up → 'disciple:ammotier' (UI shows Upgrade / Keep). Keeping is always allowed. */
const AMMO_TIERS=Array.isArray(window.__AMMO_TIERS)&&window.__AMMO_TIERS.length?window.__AMMO_TIERS:null, AMMO_HYST=1.05;
function ammoTierOf(m){ if(!AMMO_TIERS||!(m>0)) return 0; for(let k=0;k<AMMO_TIERS.length;k++){ const x=AMMO_TIERS[k].maxMcap; if(x==null||m<x) return k; } return AMMO_TIERS.length-1; }
function autoMode(m){ const x=m<=50e3?Math.sqrt(Math.max(m,2e3)*5000):0.09*m, t=0.001*x;
  let b=0; MODES.forEach((md,i)=>{ if(Math.abs(Math.log(md.usd/t))<Math.abs(Math.log(MODES[b].usd/t))) b=i; }); return b; }
const LANES=[W/2-260,W/2,W/2+260];   // recomputed in relayout()
// [PARAM] orb table (off-chain points layer; see game-modes-and-progression.md §6)
const ORB={
  halo: {pts:5,  r:14, c0:'rgba(255,245,200,.95)', c1:'rgba(255,220,140,0)', rim:'#ffe7a3'},
  mult: {pts:5,  r:16, c0:'rgba(200,235,255,.95)', c1:'rgba(120,180,255,0)', rim:'#9fd8ff'},
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
  realMcap(){ return this.real!=null&&this.supply?this.real*this.supply:null; }
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
    this.iv=setInterval(()=>{ const now=performance.now(), dt=Math.min(0.25,(now-lastT)/1000); lastT=now; this.clock+=dt*this.speed;   // clamp: no swap burst after a hidden tab
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

/* DISCIPLE bonding-curve coins: events arrive from lib/events.ts via window 'disciple:event'
   (Trade carries impactPct for bombs). Paper shots supported like the pool sources. */
class DiscipleSource {
  constructor(){ this.name='DISCIPLE'; this.supply=+(Q.get('supply')||7e9); this.mcap=null; this.block=0; }
  start(emit){ this.emit=emit; emit({t:'status',source:this.name,ok:true,msg:'curve events'});
    this.h=(ev)=>{ const e=ev.detail; if(!e) return;
      if(e.type==='Trade'){ const pre=this.mcap; this.mcap=e.mcapUsd; this.block=+e.block||this.block;
        emit({t:'block',block:this.block,ts:Date.now()});
        emit({t:'swap',block:this.block,ts:Date.now(),txHash:e.txHash,side:e.side,usd:e.usd,mcap:e.mcapUsd,price:e.mcapUsd/this.supply,
              prePrice:(pre||e.mcapUsd)/this.supply,postPrice:e.mcapUsd/this.supply,impactPct:e.impactPct,trader:e.trader}); }
      else if(e.type==='Graduate') emit({t:'status',source:this.name,ok:true,msg:'GRADUATED → v4'});
      else if(e.type==='State'){ this.mcap=e.mcapUsd; emit({t:'swap',block:this.block,ts:Date.now(),txHash:'(state)',side:'buy',usd:0,mcap:e.mcapUsd,price:e.mcapUsd/this.supply}); } };
    addEventListener('disciple:event',this.h); }
  stop(){ removeEventListener('disciple:event',this.h); }
  impact(usd,side){ const m=this.mcap||1; const f=usd/(m*0.25); return side==='buy'?1+f:Math.max(0.01,1-f); }
  // Real on-chain shot when the page registered a wallet bridge (components/TradeBridge.tsx: the user's wallet signs,
  // curve pre-grad / DiscipleRouter post-grad). No wallet → paper fill, as before.
  async submitTrade(side,usd,o){ const b=window.__discipleTrade; if(!b) return {ok:true,paper:true};
    try{ const r=await (o?b(side,usd,o):b(side,usd)); return r||{ok:false,reason:'no result'}; }catch(err){ return {ok:false,reason:String((err&&err.message)||err).slice(0,80)}; } }
}
const IS_POOL=!['mock','dexscreener','rpc','disciple'].includes(Q.get('source')||'pool');
function makeSource(){
  const s=Q.get('source')||'pool';
  if (Q.get('replay')==='1'||s==='replay'){ if(window.REPLAY) return new ReplaySource(REPLAY); }
  if (s==='disciple') return new DiscipleSource();
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
  x:W/2, vx:0, tilt:0, tradeUsd:5, mode:2, lane:1, balance:250, promoLeft:50, slowUntil:0, mult:1, multUntil:0, simF:1, simT:1, simV:0, fwd:60, fwdV:0, fwdN:0, vyS:0, ry:H*0.58, anch:null, ammoHover:-1, floaters:[], heading:Math.PI/2, toasts:[], ach:{}, streak:0, collected:0, obstacles:[], fuelers:{'you':0,'0xA11…ce':6,'0xB0b…42':4,'0xC4t…77':2}, cooldownUntil:0,
  status:{source:'',ok:true,msg:''}, score:0, motes:[], particles:[], shards:[], flashes:[],
  orbsOn:localStorage.getItem('disciple.orbs')!=='off', lastOrbT:-99,
  tierShown:-1, tierBanner:0, keys:{}, t:0, turbo:false,
  altVel:0, flatSince:0, cruise:0, bank:0, bob:0, sway:0, roll:1, glint:0,
  trail:[], bgScrollX:0, speedBits:[],
  aimDeg:0, thrustT:-99, lastTrailAlt:null,
  headTarget:Math.PI/2, headSmooth:Math.PI/2, aimDisp:0, aimVel:0, aimTgt:0, camAlt:null, camX:null,
  thrustNet:0, thrustPend:null, trailAimLP:0,
};
/* =====================================================================
   POOLED PARTICLES — fixed capacity, preallocated objects, swap-remove on death.
   No per-frame allocation. Hard caps: when full, a live slot is recycled (round-robin)
   so a fresh blast always shows instead of being silently dropped.
   ===================================================================== */
function Pool(cap){ this.a=new Array(cap); for(let i=0;i<cap;i++) this.a[i]={k:'',x:0,y:0,vx:0,vy:0,r:0,r0:0,gr:0,life:0,max:1,drag:0,g:0,c:'',a:1,s:0,hot:false};
  this.n=0; this.cap=cap; this.rr=0; this.recycled=0; }
Pool.prototype.spawn=function(){ let p; if(this.n<this.cap) p=this.a[this.n++]; else { this.recycled++; this.rr=(this.rr+1)%this.cap; p=this.a[this.rr]; } p.fresh=true; return p; };
/* render interpolation for 120 Hz+: snapshot before each sim step, lerp positions for the draw, restore after.
   Particles spawned during the latest step (fresh) draw at their sim position. */
Pool.prototype.snap=function(){ const a=this.a; for(let i=0;i<this.n;i++){ const p=a[i]; p.px=p.x; p.py=p.y; p.fresh=false; } };
Pool.prototype.lerpIn=function(al){ const a=this.a; for(let i=0;i<this.n;i++){ const p=a[i]; p.cx=p.x; p.cy=p.y; if(!p.fresh){ p.x=p.px+(p.x-p.px)*al; p.y=p.py+(p.y-p.py)*al; } } };
Pool.prototype.lerpOut=function(){ const a=this.a; for(let i=0;i<this.n;i++){ const p=a[i]; p.x=p.cx; p.y=p.cy; } };
Pool.prototype.kill=function(i){ const a=this.a, j=--this.n, t=a[i]; a[i]=a[j]; a[j]=t; };   // caller iterates backwards
Pool.prototype.clear=function(){ this.n=0; };
Object.defineProperty(Pool.prototype,'length',{get(){ return this.n; }});
const CAP={exhaust:360, shards:220, bfx:600};
S.particles=new Pool(CAP.exhaust); S.shards=new Pool(CAP.shards);
function spawnShard(x,y,vx,vy,c){ const p=S.shards.spawn(); p.x=x; p.y=y; p.vx=vx; p.vy=vy; p.life=1; p.c=c; }
/* in-place filter (no new array): keeps elements where pred(e) is truthy */
function keepIf(arr,pred){ let j=0; for(let i=0;i<arr.length;i++){ const e=arr[i]; if(pred(e)) arr[j++]=e; } arr.length=j; return arr; }
const ALIVE=e=>e.life>0, NOT_DEAD_MOTE=m=>!m.dead&&m.y<H+30, NOT_DEAD_OBS=o=>!o.dead&&o.y<H+50, TRAIL_ON=p=>p.x>-40;

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
    if (e.usd>0&&!e.mine) SIM.realRate+=1/30;   // real flow → simulated flow backs off
    if (e.usd>0){ if(!e.mine) queueThrust(e.side, e.usd, estimateImpactPct(e)); else momNote(e.side,e.usd);
      S.feed.unshift({txt:`${e.side==='buy'?'▲ FUEL':'▼ BOMB'} ${(e.usd<10?fmtShot(e.usd):fmtUsd(e.usd)).padStart(7)}  ${e.mine?'(you·paper)':e.trader?short(e.trader):'#'+e.block}`, c:e.side==='buy'?'#9ff3c8':'#ffb0c8'}); }
    if (e.usd>0 && !e.mine && e.trader){ const up=e.side==='buy'; S.floaters.push({x:S.x+(up?120:-120)+(Math.random()-.5)*40,y:S.ry+(up?30:-30),txt:`${up?'▲':'▼'} ${short(e.trader)} ${e.usd<10?fmtShot(e.usd):fmtUsd(e.usd)}`,c:up?'#9ff3c8':'#ffb0c8',life:2.2,small:true}); }
    S.feed.length=Math.min(S.feed.length,7);
  }
  else if (e.t==='depth'){ S.levels=e.levels; }
  else if (e.t==='mark'){ S.confirmed.mcap=e.mcap; }
  else if (e.t==='replayRestart'){ S.feed.unshift({txt:'⟲ replay restarted',c:'#ffe7a3'}); /* keep altitude + camera: the springs glide to the restart price (no snap / loading flash) */ }
  else if (e.t==='levelFilled'){ const l=e.level; const y=altToScreenY(mcapToAlt(l.mcap));
    for(let i=0;i<40;i++) spawnShard(laneX(l)+(Math.random()-.5)*laneW(l), y, (Math.random()-.5)*300, (Math.random()-.8)*260, l.side==='ask'?'#dfe8ff':'#ffd98a');
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
/* Thrust intensity comes from PRICE IMPACT, not dollars: kn = 0..1 over 0.05% → 10% impact (log). */
/* CANDLE WINDOW (1s / 10s / 1m): the rocket's direction + speed come from the price change and volume
   inside this window, so it shows that candle's trend. Ring buffer of the displayed altitude target @20 Hz. */
const TF={sec:10};   // fixed rolling momentum window (s): direction/speed follow the ~10 s candle trend, filling gaps between trades
const MOM={hist:new Float64Array(1201), head:0, n:0, acc:0, trades:[], buy:0, sell:0, vol:0, pct:0, press:0.5};
function momNote(side,usd,pct){ if(!(usd>0)) return; MOM.trades.push({t:S.t,side,usd}); if(MOM.trades.length>800) MOM.trades.splice(0,200); }
function momentumStep(dt){
  const tgt=S.displayAlt; if(tgt==null) return;
  MOM.acc+=dt; while(MOM.acc>=0.05){ MOM.acc-=0.05; MOM.head=(MOM.head+1)%MOM.hist.length; MOM.hist[MOM.head]=tgt; MOM.n=Math.min(MOM.n+1,MOM.hist.length); }
  const back=Math.min(MOM.n-1, Math.round(TF.sec*20)); if(back<1){ S.momV=0; return; }
  const then=MOM.hist[(MOM.head-back+MOM.hist.length)%MOM.hist.length], span=back*0.05;
  const raw=(tgt-then)/span*PX_PER_ALT;                        // px/s over the candle
  MOM.pct=(altToMcap(tgt)/altToMcap(then)-1)*100;
  // critically damped follow (ω 4): no jerk when a candle closes or the window changes
  const w=4; S.momVV=(S.momVV||0)+(w*w*(raw-(S.momV||0))-2*w*(S.momVV||0))*dt; S.momV=(S.momV||0)+S.momVV*dt;
  // buy vs sell pressure inside the window
  const t0=S.t-TF.sec; let i=0; while(i<MOM.trades.length&&MOM.trades[i].t<S.t-60) i++; if(i) MOM.trades.splice(0,i);
  let b=0,se=0; for(const q of MOM.trades) if(q.t>=t0){ if(q.side==='buy') b+=q.usd; else se+=q.usd; }
  MOM.buy=b; MOM.sell=se; MOM.vol=b+se; const pr=b+se>0?b/(b+se):0.5; MOM.press+=(pr-MOM.press)*(1-Math.exp(-dt*3));
  S.fight=(S.fight||0)*Math.exp(-dt/1.6); S.flare=(S.flare||0)*Math.exp(-dt/0.6);
}
function impactNorm(pct){ pct=Math.abs(+pct||0); return clamp(Math.log10(1+pct/0.05)/Math.log10(1+10/0.05),0,1); }
function queueThrust(side, usd, pct){
  momNote(side, usd, pct);
  if (Number.isFinite(pct)) S.thrustImp=Math.max(S.thrustImp||0, Math.abs(pct));
  const signed = (side==='buy'?1:-1)*Math.max(0,usd);
  S.thrustNet = (S.thrustNet||0) + signed;
  if (!S.thrustPend) S.thrustPend = {side, usd};
  else { S.thrustPend.usd = Math.abs(S.thrustNet); S.thrustPend.side = S.thrustNet>=0?'buy':'sell'; }
}
function applyThrust(side, usd, pct){
  // Immediate path (player shots); also used when flushing the per-frame queue.
  const deg = climbAngleDeg(usd);
  S.aimDeg = side==='buy' ? deg : -Math.min(15, deg*0.25);
  // MOMENTUM BATTLE: impact-sized push-back. Buys into a dive pull the nose up (stronger while diving),
  // sells into a pump push it over. Decays τ1.6 s; the heading spring + rate cap make it a gradual turn.
  const kn=impactNorm(Number.isFinite(pct)?pct:(source.impact&&S.confirmed.mcap?Math.abs(source.impact(usd,side)-1)*100:0.1));
  if (side==='buy'){ const diving=(S.aimDisp||AIM_REST)<30; S.fight=clamp((S.fight||0)+(10+28*kn)*(diving?1.6:1),-60,60); S.flare=Math.min(2.2,(S.flare||0)+(0.35+0.9*kn)*(diving?1.7:1)); }
  else { const pumping=(S.aimDisp||AIM_REST)>82; S.fight=clamp((S.fight||0)-(8+24*kn)*(pumping?1.5:1),-60,60); }
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
  const usd = Math.abs(S.thrustNet), pct=S.thrustImp;
  S.thrustNet=0; S.thrustPend=null; S.thrustImp=0;
  applyThrust(side, usd, pct||undefined);
}
/* =====================================================================
   SIMULATED MARKET — visual-only order flow for quiet / testnet pools.
   Regimes (lull / flow / burst) switch every few seconds; sizes are lognormal around the current
   tier's FLARE preset with rare whales; a drifting side bias makes runs and dips. It only moves
   S.simF (a display multiplier on the altitude target, clamped and mean-reverting to the real price),
   thrust, bombs and the feed. S.confirmed.mcap, disciple:mark, paper fills, balances and PnL stay real.
   ===================================================================== */
const SIM_REG=[{n:'lull',rate:0.2},{n:'flow',rate:0.9},{n:'burst',rate:3.2}];
const SIM={on:false, mode:(()=>{ try{ const v=localStorage.getItem('disciple.sim'); return v==='on'||v==='off'?v:'auto'; }catch(_){ return 'auto'; } })(),
  regime:1, regT:4, bias:0, realRate:0};
function simActive(){ if(SIM.mode==='off') return false; if(SIM.mode==='on') return true; return !!window.__DISCIPLE_TESTNET || SIM.realRate<0.05; }
function pushSim(){ try{ dispatchEvent(new CustomEvent('disciple:simstate',{detail:{on:SIM.on,mode:SIM.mode}})); }catch(_){} }
addEventListener('disciple:sim',e=>{ const m=e.detail&&e.detail.mode; if(m==='on'||m==='off'||m==='auto'){ SIM.mode=m; try{ m==='auto'?localStorage.removeItem('disciple.sim'):localStorage.setItem('disciple.sim',m); }catch(_){} }
  SIM.on=simActive(); pushSim(); });
function simMarketStep(dt){
  SIM.realRate*=Math.exp(-dt/30); const was=SIM.on; SIM.on=simActive(); if(was!==SIM.on) pushSim();
  S.simT=Math.exp(Math.log(S.simT||1)*Math.exp(-dt/(SIM.on?90:3)));         // target drifts back toward the real price
  // displayed factor follows the target with a critically damped spring in log space (ω=2.5 → ~1 s, no jumps)
  { const e=Math.log(S.simT)-Math.log(S.simF), w=2.5; S.simV=(S.simV||0)+(w*w*e-2*w*(S.simV||0))*dt; S.simF=Math.exp(Math.log(S.simF)+S.simV*dt); }
  if(!SIM.on||S.confirmed.mcap==null) return;
  if((SIM.regT-=dt)<=0){ const r=Math.random(); SIM.regime=r<0.3?0:r<0.78?1:2; SIM.regT=SIM.regime===2?2+Math.random()*4:4+Math.random()*9; }
  SIM.bias=clamp(SIM.bias+(Math.random()-0.5)*0.8*dt-SIM.bias*0.04*dt,-0.35,0.35);
  const rate=SIM_REG[SIM.regime].rate/(1+SIM.realRate*4);                    // real trades blend in, sim thins out
  if(Math.random()<rate*dt) simTrade();
}
function simTrade(){
  const buy=Math.random()<0.5+SIM.bias-Math.log(S.simT||1)*2, base=Math.max(MIN_SHOT,MODES[2].usd);
  let usd=base*Math.exp((Math.random()+Math.random()+Math.random()-1.5)*1.6), whale=false;
  if(Math.random()<0.025){ usd*=20+Math.random()*40; whale=true; }
  usd=+Math.max(MIN_SHOT,usd).toPrecision(3);
  const pct=clamp(0.3*usd/base,0.03,whale?9:2.5);
  S.simT=clamp((S.simT||1)*(buy?1+pct/100:1/(1+pct/100)),0.75,1.3);
  S.volEma+=usd; if(buy) S.buyEma+=usd; else S.sellEma+=usd;
  queueThrust(buy?'buy':'sell',usd,pct);
  if(!buy) noteSell({side:'sell',usd,impactPct:pct,trader:null,mine:false});
  S.feed.unshift({txt:`${buy?'▲ FUEL':'▼ BOMB'} ${(usd<10?fmtShot(usd):fmtUsd(usd)).padStart(7)}  sim${whale?' WHALE':''}`,c:buy?'rgba(159,243,200,.65)':'rgba(255,176,200,.65)'});
  S.feed.length=Math.min(S.feed.length,7);
}
setTimeout(pushSim,0);
const AMMO_HIT=[0,1,2,3,4,5].map(()=>({x:-1,y:-1,w:0,h:0}));
function pushAmmo(){ try{ dispatchEvent(new CustomEvent('disciple:ammo',{detail:{tier:S.ammoTier, rocketTier:S.rocketAmmoTier,
  name:AMMO_TIERS&&S.ammoTier!=null?AMMO_TIERS[S.ammoTier].name:null, usd:MODES.map(m=>m.usd), names:MODES.map(m=>m.name), mode:S.mode}})); }catch(_){} }
function setAmmoTier(t){ if(!AMMO_TIERS) return; t=clamp(t|0,0,AMMO_TIERS.length-1); S.ammoTier=t;
  const u=AMMO_TIERS[t].usd; for(let i=0;i<MODES.length&&i<u.length;i++) MODES[i].usd=u[i]; pushAmmo(); }
function ammoTierStep(){ if(!AMMO_TIERS) return; const m=S.confirmed.mcap; if(!(m>0)) return; const T=AMMO_TIERS;
  if (S.rocketAmmoTier==null){ S.rocketAmmoTier=ammoTierOf(m); if(S.ammoTier==null) setAmmoTier(S.rocketAmmoTier); return; }
  let t=S.rocketAmmoTier;
  if (t<T.length-1 && T[t].maxMcap!=null && m>=T[t].maxMcap*AMMO_HYST) t++;
  else if (t>0 && m<T[t-1].maxMcap/AMMO_HYST) t--;
  if (t===S.rocketAmmoTier) return;
  const up=t>S.rocketAmmoTier; S.rocketAmmoTier=t;
  if (up && t>S.ammoTier && !S.ammoKept[t]) try{ dispatchEvent(new CustomEvent('disciple:ammotier',{detail:{from:S.ammoTier,to:t,
    fromName:T[S.ammoTier].name,toName:T[t].name,usd:T[t].usd.slice(),current:MODES.map(q=>q.usd),mode:S.mode,mcap:m}})); }catch(_){}
  pushAmmo(); }
S.ammoTier=null; S.rocketAmmoTier=null; S.ammoKept={};
addEventListener('disciple:ammo-upgrade',e=>{ const d=e.detail||{}; setAmmoTier(d.tier!=null?d.tier:S.rocketAmmoTier); });
addEventListener('disciple:ammo-keep',e=>{ const d=e.detail||{}; if(d.tier!=null) S.ammoKept[d.tier]=1; });
addEventListener('disciple:ammo-tier',e=>{ const d=e.detail||{}; if(d.tier!=null) setAmmoTier(d.tier); });
addEventListener('disciple:ammo-query',()=>pushAmmo());
/* mcap push for the React HUD (replaces its 500 ms poll): on change, at most 10×/s */
/* PnL MARK — the REAL market price. Pool sources apply the player's paper impact as a decaying offset
   (source.paper, τ20 s) on top of the real price; that offset drives the rocket but must never reach PnL,
   otherwise every paper buy is booked at the bumped price and then bleeds as the offset decays. */
function markMcap(){ const r=source&&source.realMcap?source.realMcap():null; return r>0?r:S.confirmed.mcap; }
function pushMark(){ const m=markMcap(); if(!(m>0)||m===S._pm||S.t-(S._pmT??-1)<0.1) return; S._pm=m; S._pmT=S.t;
  try{ dispatchEvent(new CustomEvent('disciple:mark',{detail:{mcap:m,supply:source.supply||1e9}})); }catch(_){} }
function award(id,title,sub){ if(S.ach[id]) return; S.ach[id]=1; S.toasts.push({title,sub,life:4}); }
function trade(side,opt){
  let md=MODES[S.mode]; const stack=S.fuelers.you||0;
  if (opt&&opt.usd>0) md={...md,usd:+opt.usd};   // custom amount / % sells from the ammo bar
  if (side==='sell'&&opt&&opt.all){ if(stack<MIN_SHOT){ S.flashes.push({txt:'NO PAPER STACK TO DUMP',life:1.4}); return; } md={...md,usd:stack}; }
  if (side==='sell') S.fullStackNext = stack>=MIN_SHOT && md.usd>=stack*0.98;
  if (md.usd<MIN_SHOT){                                   // below net-buy minimum: blocked (no gas sponsorship)
    if (!PROMO_GAS || S.promoLeft<=0){ S.flashes.push({txt:`BELOW MIN SHOT ${fmtShot(MIN_SHOT)} · gas would eat ${(GAS_USD/md.usd*100).toFixed(0)}%`,life:1.6}); return; }
    S.promoLeft--; }
  if (side==='buy' && !window.__discipleTrade && S.balance<md.usd){ S.flashes.push({txt:'INSUFFICIENT DEPOSITED BALANCE',life:1.5}); return; }
  // Immediate local aim for the player's shot; mine swaps skip queue to avoid double-apply.
  applyThrust(side, md.usd, source.impact&&S.confirmed.mcap?Math.abs(source.impact(md.usd,side)-1)*100:undefined);
  submit(side, md.usd, false, opt);
}
function submit(side,usd,force,opt){
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
  const fillMark=markMcap();   // PnL ledger: paper fills execute at the REAL market price (own paper impact excluded)
  source.submitTrade(side,S.tradeUsd,opt&&opt.frac?{frac:opt.frac}:undefined).then(r=>{
    p.state=r.ok?'confirmed':'failed';
    if(r.ok) S.balance+= (side==='buy' ? -p.usd : p.usd*0.99) - GAS_USD;
    if(r.ok) dispatchEvent(new CustomEvent('disciple:paperfill',{detail:{side,usd:p.usd,mcap:fillMark,supply:source.supply||1e9,gas:GAS_USD}}));   // → PnL HUD ledger   // mock ledger (sell proceeds net of 1% fee) p.t1=performance.now(); p.reason=r.reason;
    if(!r.ok){ const why=String(r.reason||'failed'), pre=isOnchainRevert(why);   // only real on-chain reverts say "reverted"
      S.feed.unshift({txt:(pre?'✕ tx reverted: ':'✕ ')+why,c:'#ff8f8f'}); S.flashes.push({txt:(pre?'TX REVERTED · ':'TRADE FAILED · ')+why,life:1.6}); }
    setTimeout(()=>{ S.pending=S.pending.filter(q=>q!==p); }, 450);
  });
}
// Pre-flight failures (gas estimate / simulation / balance) are not reverts — show the reason as-is.
function isOnchainRevert(reason){ return !/^\s*(simulation|estimate|not enough|insufficient)/i.test(reason); }
// DOM ammo buttons (TradeBridge) → same path as keyboard shots.
addEventListener('disciple:shoot',e=>{ const d=e.detail||{}; if(typeof d.mode==='number') S.mode=Math.max(0,Math.min(MODES.length-1,d.mode));
  if(d.side==='buy'||d.side==='sell') trade(d.side, d.usd>0||d.frac>0?{usd:d.usd,frac:d.frac}:undefined); });
addEventListener('keydown',e=>{
  S.keys[e.code]=true;
  if (e.code==='Space'){ e.preventDefault(); if(!e.repeat) trade('buy'); }
  if (e.code==='ShiftLeft'||e.code==='ShiftRight'){ if(!e.repeat) trade('sell',{all:e.ctrlKey||e.metaKey}); }
  const dm=/^Digit([1-6])$/.exec(e.code); if(dm){ S.mode=+dm[1]-1;  pushAmmo(); }
  if (e.code==='Equal'||e.code==='BracketRight'){ S.mode=Math.min(MODES.length-1,S.mode+1);  pushAmmo(); }
  if (e.code==='Minus'||e.code==='BracketLeft'){ S.mode=Math.max(0,S.mode-1);  pushAmmo(); }
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
// alpha:false — the frame is always fully painted, so the compositor can skip blending the canvas;
// desynchronized — low-latency path (Chromium: bypasses one compositor frame of latency where supported).
const cv=document.getElementById('c'), ctx=cv.getContext('2d',{alpha:false,desynchronized:true});
/* Adaptive resolution governor: if frames run slow for ~2 s, step the backing-store DPR down
   (2 → 1.5 → 1.25 → 1); if they run fast for ~6 s, step back up. ≥4 s between changes, logical
   coordinates never change (only sharpness), so it can't move anything on screen. ?dpr=N pins it. */
const DPR_STEPS=[1,1.25,1.5,2], DPR_PIN=+Q.get('dpr')||0; let dprIx=3;
const GOV={slow:0,fast:0,lastChange:-1e9,ema:16.7};
function governor(rawDt){ if(DPR_PIN||FIXED_DT) return; const ms=rawDt*1000; if(ms>100) return; GOV.ema+= (ms-GOV.ema)*0.05;
  const now=performance.now(); if(now-GOV.lastChange<4000) return;
  if(GOV.ema>19.5){ GOV.slow+=rawDt; GOV.fast=0; } else if(GOV.ema<14.5){ GOV.fast+=rawDt; GOV.slow=0; } else { GOV.slow=GOV.fast=0; }
  if(GOV.slow>2&&dprIx>0){ dprIx--; GOV.lastChange=now; GOV.slow=0; resize(); }
  else if(GOV.fast>6&&dprIx<DPR_STEPS.length-1&&DPR_STEPS[dprIx+1]<=(devicePixelRatio||1)){ dprIx++; GOV.lastChange=now; GOV.fast=0; resize(); } }
let scale=1;
// Fill the whole wrap (no black bars): logical units = CSS px, backing store = CSS px × DPR (≤2).
function resize(){ const dpr=Math.min(DPR_PIN||DPR_STEPS[dprIx],devicePixelRatio||1); const wr=document.getElementById('wrap');
  const cw=Math.max(320,Math.round(wr.clientWidth||innerWidth)), ch=Math.max(240,Math.round(wr.clientHeight||innerHeight));
  relayout(cw,ch); scale=1;
  cv.style.width=cw+'px'; cv.style.height=ch+'px'; cv.width=Math.round(cw*dpr); cv.height=Math.round(ch*dpr);
  ctx.setTransform(cv.width/W,0,0,cv.height/H,0,0); }
function relayout(w,h){ if(w===W&&h===H&&typeof ROCKET_Y!=='undefined') return; const ow=W;
  W=w; H=h; LANES[0]=W/2-260; LANES[1]=W/2; LANES[2]=W/2+260; ROCKET_Y=H*0.58;
  if(typeof S!=='undefined'&&S){ S.x=S.x*(W/ow); } }
// ammo tiles are mouse targets: whole tile = hit area, hover highlight, click selects (same as 1-6)
function ammoAt(e){ const r=cv.getBoundingClientRect(), x=(e.clientX-r.left)*W/r.width, y=(e.clientY-r.top)*H/r.height;
  for(let i=0;i<AMMO_HIT.length;i++){ const R=AMMO_HIT[i]; if(x>=R.x&&x<=R.x+R.w&&y>=R.y&&y<=R.y+R.h) return i; } return -1; }
cv.addEventListener('pointermove',e=>{ const i=ammoAt(e); if(i!==S.ammoHover){ S.ammoHover=i; cv.style.cursor=i>=0?'pointer':''; } });
cv.addEventListener('pointerleave',()=>{ S.ammoHover=-1; cv.style.cursor=''; });
cv.addEventListener('pointerdown',e=>{ const i=ammoAt(e); if(i<0) return; e.preventDefault(); S.mode=i; pushAmmo(); });
addEventListener('resize',resize); addEventListener('apsidebar',()=>requestAnimationFrame(resize)); resize();

const IMG={}; let loaded=0; const names=[...new Set(TIERS.map(t=>t.bg).concat(['rocket']))];
names.forEach(n=>{ const im=new Image(); im.onload=()=>{ if(im.bitmap) IMG[n]=im.bitmap; loaded++; };   // worker: shim decodes via createImageBitmap
  im.onerror=()=>{loaded++; im.bad=true; console.warn('asset failed',n);}; im.src=(window.__DISCIPLE_BASE_PATH__||'')+'/assets/'+n+'.png'; IMG[n]=im; });

// film grain: pre-rendered noise tiles
const grain=[...Array(4)].map(()=>{ const g=document.createElement('canvas'); g.width=g.height=256; const gx=g.getContext('2d'), id=gx.createImageData(256,256);
  for(let i=0;i<id.data.length;i+=4){ const v=Math.random()*255; id.data[i]=id.data[i+1]=id.data[i+2]=v; id.data[i+3]=22; } gx.putImageData(id,0,0); return g; });

/* SPRITE CACHE — every soft radial disc (exhaust, smoke, clouds, orbs, fireballs, mushroom puffs) is
   pre-rendered once and stamped with drawImage + globalAlpha. No per-frame gradient objects. */
const SPR=new Map();
function radialSprite(key,stops,size){ let c=SPR.get(key); if(c) return c; size=size||64;
  c=document.createElement('canvas'); c.width=c.height=size; const g=c.getContext('2d'), h=size/2, gr=g.createRadialGradient(h,h,0,h,h,h);
  for(const st of stops) gr.addColorStop(st[0],st[1]); g.fillStyle=gr; g.fillRect(0,0,size,size); SPR.set(key,c); return c; }
function blit(spr,x,y,r){ if(r>0.5) ctx.drawImage(spr,x-r,y-r,2*r,2*r); }
const softDot=rgb=>radialSprite('d'+rgb,[[0,`rgba(${rgb},1)`],[1,`rgba(${rgb},0)`]]);
const CLOUD_SPR=radialSprite('cloud',[[0,'rgba(255,253,250,1)'],[0.15,'rgba(255,253,250,1)'],[0.49,'rgba(236,242,255,0.72)'],[1,'rgba(200,214,255,0)']],128);
const FIRE_SPR=radialSprite('fire',[[0,'rgba(255,255,250,1)'],[0.25,'rgba(255,240,180,1)'],[0.55,'rgba(255,170,60,.8)'],[0.8,'rgba(220,70,30,.45)'],[1,'rgba(120,20,10,0)']],128);
const CORE_SPR=radialSprite('core',[[0,'rgba(255,250,230,1)'],[1,'rgba(120,170,255,0)']],128);
// cached vignette (was a new full-screen radial gradient every frame)
const VIGNETTE=(()=>{ const c=document.createElement('canvas'); c.width=W/2; c.height=H/2; const g=c.getContext('2d');
  const v=g.createRadialGradient(W/4,H/4,H*0.175,W/4,H/4,H*0.475); v.addColorStop(0,'rgba(0,0,0,0)'); v.addColorStop(1,'rgba(4,4,16,.6)'); g.fillStyle=v; g.fillRect(0,0,W/2,H/2); return c; })();

var ROCKET_Y = H*0.58;
const HUD_BOTTOM=140, BANNER_Y=HUD_BOTTOM+70, SAFE_LEFT=24;   // tier banner below the top HUD row; canvas is pushed right of the sidebar so no rail clearance needed
function altToScreenY(a){ const base=(S.camAlt!=null?S.camAlt:S.displayAlt); return (S.anch??ROCKET_Y) - (a - base)*PX_PER_ALT; }
function laneW(l){ return clamp(90+Math.log10(1+l.usd)*55, 110, 420); }
function laneX(l){ return 140 + hash(Math.round(l.mcap*7)%9973 + (l.side==='ask'?3:0))*(W-280); }

/* Background plates by altitude BAND, not by whole tier. Tiers are 1.5–3× wide in mcap and the 18 tiers shared 10
   plates, so a coin living between $7K and $12K (the whole mock/sim range) sat on tier0 forever. Bands: half a tier
   up to FIRMAMENT (alt 5 ≈ $100K) so all 10 plates appear across $7K→$100K, then one band per tier (cycling). */
const PLATES=['tier0','tier1','tier2','tier3','tier4','tier5','tier6','tier7','tier8','tier9'];
const BAND_SPLIT=5;
function bandOf(alt){ alt=Math.max(0,alt||0); return alt<BAND_SPLIT ? alt*2 : BAND_SPLIT*2+(alt-BAND_SPLIT); }
const plateOf=b=>PLATES[((Math.floor(b)%PLATES.length)+PLATES.length)%PLATES.length];
let bgT=0;
function drawBg(){
  // displayed band is rate-limited (≤1.5 bands/s) so a fast altitude swing crossfades plate by plate instead of strobing;
  // a jump of >4 bands (first frame, coin switch) snaps
  const a=S.displayAlt, tgt=bandOf(a), now=performance.now(), dt=Math.min(0.1,(now-(bgT||now))/1000); bgT=now;
  if(S.bgU==null||Math.abs(tgt-S.bgU)>4) S.bgU=tgt; else S.bgU+=clamp(tgt-S.bgU,-1.5*dt,1.5*dt);
  const u=S.bgU, i=Math.floor(u), f=u-i;
  const s=1.12, w=W*s, h=H*s, scrollX=((S.bgScrollX||0)*0.05)%(2*w);
  const draw=(idx,alpha)=>{ if(idx<0||alpha<=0.003) return; const im=IMG[plateOf(idx)]; if(!im||!im.complete||im.bad) return;
    ctx.globalAlpha=alpha;
    // vertical offset is a continuous function of altitude for EVERY plate (no wrap at tier boundaries)
    const off=clamp((u-(idx+0.5))*H*0.08,-H*0.06,H*0.06), y0=(H-h)/2+off;
    const x0=(W-w)/2+(S.x-W/2)*-0.03-scrollX;
    // mirrored tiling (period 2w) so neighbouring edges always match
    for (let k=-1;k<=3;k++){ const tx=x0+k*w; if(tx>W||tx+w<0) continue;
      const odd=((k%2)+2)%2===1, sx=im.naturalWidth*0.1, sw=im.naturalWidth*0.8, ih=im.naturalHeight;
      if(!odd) ctx.drawImage(im,sx,0,sw,ih,tx,y0,w,h); else { ctx.save(); ctx.translate(tx+w,y0); ctx.scale(-1,1); ctx.drawImage(im,sx,0,sw,ih,0,0,w,h); ctx.restore(); } }
  };
  ctx.fillStyle='#0b0f22'; ctx.fillRect(0,0,W,H);
  // crossfade over the last 45% of each band: next plate reaches alpha 1 exactly at the boundary → no pop when i changes
  const edge=0.45, sm=x=>{ x=clamp(x,0,1); return x*x*(3-2*x); };
  draw(i,1);
  if (f>1-edge) draw(i+1, sm((f-(1-edge))/edge));
  ctx.globalAlpha=1;
  ctx.fillStyle='rgba(8,10,34,.30)'; ctx.fillRect(0,0,W,H);
}
/* Sky tint per tier plate (average colour, sampled once per image) → rocket rim light + cloud shading */
const SKY_RGB=new Map();
function skyRGB(idx){ const key=plateOf(idx); let c=SKY_RGB.get(key); if(c) return c;
  const im=IMG[key]; c=[200,205,255]; if(im&&im.complete&&!im.bad){ try{ const t=document.createElement('canvas'); t.width=t.height=4; const g=t.getContext('2d');
    g.drawImage(im,0,0,4,4); const d=g.getImageData(0,0,4,2).data; let r=0,gg=0,b=0; for(let k=0;k<d.length;k+=4){ r+=d[k]; gg+=d[k+1]; b+=d[k+2]; } const n=d.length/4;
    // lift toward pastel so the rim reads as light, not as paint
    c=[Math.round(r/n*0.5+128),Math.round(gg/n*0.5+124),Math.round(b/n*0.5+128)]; SKY_RGB.set(key,c); }catch(_){ } }
  return c; }
function skyNow(){ const a=S.bgU!=null?S.bgU:bandOf(S.displayAlt), i=Math.floor(a), f=clamp(a-i,0,1), c0=skyRGB(i), c1=skyRGB(i+1);
  return [Math.round(lerp(c0[0],c1[0],f)),Math.round(lerp(c0[1],c1[1],f)),Math.round(lerp(c0[2],c1[2],f))]; }

/* LIMINAL CLOUDS — crisp, stylised cumulus silhouettes pre-rendered once (2× res): union of circles with a
   flat-ish base, pastel vertical gradient, a cel-shaded highlight and a soft lavender underside. Sparse and
   deliberate: 5 far, 4 mid, 2 near. Near clouds are drawn after the rocket, so the rocket flies between layers. */
const CLOUD_SS=2;
function makeCloudSprite(seed, r, pal){
  const n=5+(seed%3), w=Math.ceil(r*3.8), h=Math.ceil(r*2.1), base=h*0.86;
  const c=document.createElement('canvas'); c.width=w*CLOUD_SS; c.height=h*CLOUD_SS; const g=c.getContext('2d'); g.scale(CLOUD_SS,CLOUD_SS);
  const circ=[]; for(let k=0;k<n;k++){ const t=k/(n-1)-0.5, hh=hash(seed*31+k*7);
    const rr=r*(0.36+0.42*(1-Math.abs(t)*1.5))*(0.85+0.3*hh);
    circ.push([w/2+t*r*2.5+(hash(seed+k*13)-0.5)*r*0.25, base-rr*0.62-(1-Math.abs(t)*1.6)*r*0.22*hh, rr]); }
  const path=(dx,dy,sc)=>{ g.beginPath(); for(const [x,y,rr] of circ){ g.moveTo(x+dx+rr*sc,y+dy); g.arc(x+dx,y+dy,rr*sc,0,Math.PI*2); } };
  g.save(); g.beginPath(); g.rect(0,0,w,base+r*0.04); g.clip();
  const gr=g.createLinearGradient(0,base-r*1.5,0,base); gr.addColorStop(0,pal[0]); gr.addColorStop(0.55,pal[1]); gr.addColorStop(1,pal[2]);
  path(0,0,1); g.fillStyle=gr; g.fill();
  g.globalCompositeOperation='source-atop';
  path(-r*0.07,-r*0.09,0.84); g.fillStyle='rgba(255,255,255,.42)'; g.fill();            // cel highlight (hard edge)
  const ug=g.createLinearGradient(0,base-r*0.35,0,base); ug.addColorStop(0,'rgba(150,140,220,0)'); ug.addColorStop(1,pal[3]);
  g.fillStyle=ug; g.fillRect(0,base-r*0.35,w,r*0.4);                                    // underside
  g.restore();
  // lit version (exhaust glow): same silhouette, warm
  const l=document.createElement('canvas'); l.width=c.width; l.height=c.height; const lg=l.getContext('2d');
  lg.drawImage(c,0,0); lg.globalCompositeOperation='source-in'; lg.fillStyle='rgb(255,190,120)'; lg.fillRect(0,0,l.width,l.height);
  return {spr:c, lit:l, w, h}; }
const CLOUD_PAL=[
  ['#f4eefe','#e3d7f6','#bfc3ee','rgba(150,140,215,.55)'],     // far: cooler, bluer (atmospheric)
  ['#fff8fb','#f8deee','#c8c6f4','rgba(160,140,220,.5)'],     // mid: pastel pink → lavender
  ['#fffdf8','#fde6ef','#d3cdf7','rgba(170,150,225,.45)']];   // near: warm white
const CLOUDS=(()=>{
  const layers=[];
  const spec=[{n:5,r:46,a:0.55,spd:0.18},{n:4,r:82,a:0.85,spd:0.42},{n:2,r:140,a:0.92,spd:1.05}];
  spec.forEach((L,li)=>{
    for(let i=0;i<L.n;i++){ const seed=i*7+li*29+3, r=L.r*(0.8+hash(i+li*3)*0.4);
      layers.push({li, x:hash(i*13+li*7)*1600, y:hash(i*29+li)*900, r, a:L.a, spd:L.spd, sp:makeCloudSprite(seed,r,CLOUD_PAL[li]), phase:hash(i+li)*6.28,
        ox:0, oy:0, vx:0, vy:0, dens:1}); }
  });
  return layers;
})();
const CB={x:0,y:0};
function cloudBase(c){   // parallax position (no blast offset) → CB. Wrap span includes the sprite size → no edge pop.
  const m=c.sp.w, sw=W+2*m, sh=H+2*c.sp.h;
  const xOff=(S.bgScrollX||0)*c.spd*0.6, yOff=(S.cloudY||0)*c.spd*0.65;   // climb → clouds fall past, drop → they rise
  let x=c.x-xOff; x=((x%sw)+sw)%sw-m;
  let y=c.y+yOff; y=((y%sh)+sh)%sh-c.sp.h; CB.x=x; CB.y=y; return CB; }
function cloudStep(dt){ const k=1-Math.exp(-dt/6);
  for (const c of CLOUDS){ c.vx+=(-1.1*c.ox-1.9*c.vx)*dt; c.vy+=(-1.1*c.oy-1.9*c.vy)*dt; c.ox+=c.vx*dt; c.oy+=c.vy*dt; c.dens+=(1-c.dens)*k; } }
function cloudBlast(x,y,amp,R){
  for (const c of CLOUDS){ cloudBase(c); const dx=CB.x+c.ox-x, dy=CB.y+c.oy-y, d=Math.hypot(dx,dy)+1, f=1/(1+(d/R)*(d/R));
    c.vx+=dx/d*amp*f*(0.6+c.spd); c.vy+=dy/d*amp*f*(0.6+c.spd)-amp*0.15*f;   // pushed out and slightly lofted
    c.dens=Math.max(0.08,c.dens-f*Math.min(0.9,amp/500)); } }
function drawClouds(front){
  const ex=(S.camX!=null?S.camX:S.x), ey=S.ry, fl=exhaustParams().flame;
  for (const c of CLOUDS){ if((c.li===2)!==!!front) continue;
    cloudBase(c); const x=CB.x+c.ox, y=CB.y+c.oy, sp=c.sp, d=1-c.dens;
    if (x>W+sp.w||x+sp.w<-sp.w||y>H+sp.h||y+sp.h<-sp.h) continue;
    const bob=Math.sin(S.t*0.35+c.phase)*3, cx=x+sp.w/2, cy=y+sp.h/2+bob;
    const dd=Math.hypot(cx-ex,cy-ey), lit=clamp(fl*0.9/(1+(dd/(220+sp.w*0.4))**2),0,0.9);
    if (d<0.03){ ctx.globalAlpha=c.a; ctx.drawImage(sp.spr,x,y+bob,sp.w,sp.h);
      if(lit>0.03){ ctx.globalCompositeOperation='lighter'; ctx.globalAlpha=lit*0.38; ctx.drawImage(sp.lit,x,y+bob,sp.w,sp.h); ctx.globalCompositeOperation='source-over'; } }
    else {
      // clean shape breakup: the silhouette splits into 3 slabs that drift apart, shrink and fade — no fog
      const sw=sp.spr.width/3, k=1-d*0.3;
      for (let j=0;j<3;j++){ const dx=(j-1)*d*sp.w*0.45, dy=-d*sp.h*(j===1?0.35:0.12), pw=sp.w/3*k, ph=sp.h*k;
        ctx.globalAlpha=c.a*(0.25+0.75*c.dens); ctx.drawImage(sp.spr,j*sw,0,sw,sp.spr.height,x+j*sp.w/3+dx+(sp.w/3-pw)/2,y+bob+dy+(sp.h-ph),pw,ph); }
    }
  }
  ctx.globalAlpha=1;
}
function drawSpeedLines(){
  if (!S.speedBits.length) return;
  ctx.save(); ctx.lineCap='round';
  const vx=S.fwd||0, vy=S.vyS||0;
  for (const b of S.speedBits){
    ctx.globalAlpha=clamp(b.life,0,1)*0.5; ctx.strokeStyle=b.up?'rgba(235,240,255,.9)':'rgba(255,220,235,.85)'; ctx.lineWidth=b.w;
    ctx.beginPath(); ctx.moveTo(b.x,b.y); ctx.lineTo(b.x+vx*0.14*b.k,b.y-vy*0.14*b.k); ctx.stroke();
  }
  ctx.restore(); ctx.globalAlpha=1;
}
const TRAIL_PTS=Array.from({length:96},()=>({x:0,y:0,tick:false,thrust:false}));
function drawTickTrail(){
  if (S.trail.length<2) return;
  // JET TRAIL → TICK LINE: thick/hot at the nozzle (pivot), thins into historical tick path (left=past).
  // Stair language: flat segments when sideways, angled segments on thrust (variable slope).
  // Tip = nozzle/aft pivot (rocket nose leads ahead of this point).
  const tailX=(S.camX!=null?S.camX:S.x)+(S.sway||0)*0.35, tailY=S.ry+(S.bob||0)*0.5;
  const pts=TRAIL_PTS; let n=0;   // reused scratch points (no per-frame map/filter arrays)
  for (const p of S.trail){ if(!(p.x<tailX-2)||n>=TRAIL_PTS.length-1) continue; const q=pts[n++]; q.x=p.x; q.y=clamp(altToScreenY(p.alt),20,H-20); q.tick=p.tick; q.thrust=p.thrust; }
  { const q=pts[n++]; q.x=tailX; q.y=tailY; q.tick=false; q.thrust=false; }
  if(n<2) return;
  const vis=Math.max(0.35, S.cruise||0); // always visible; brighter in cruise
  ctx.save(); ctx.lineCap='round'; ctx.lineJoin='round'; ctx.globalCompositeOperation='lighter';
  for (let i=1;i<n;i++){ const u=i/(n-1);               // 0 = oldest (far left), 1 = at the nozzle
    const a=vis*Math.pow(u,1.25);
    const hot=pts[i].thrust||pts[i-1].thrust ? 1 : u;
    const sc=S.scorch||0; // ATOM: trail scorched to charcoal with ember edges, cools back over ~7 s
    ctx.strokeStyle=`rgba(${Math.round(lerp(255,70,sc))},${Math.round(lerp(190+55*hot,40,sc))},${Math.round(lerp(140+90*u,30,sc))},${0.18+0.72*a})`;
    const lw=1.2+16*Math.pow(u,2.6);                    // thickest at nozzle, hairline far back
    ctx.beginPath(); ctx.moveTo(pts[i-1].x,pts[i-1].y); ctx.lineTo(pts[i].x,pts[i].y);
    // glow underlay (replaces per-segment shadowBlur): wide faint stroke in the glow colour
    const gw=(12*u+10*sc)*1.6; if(gw>1){ ctx.lineWidth=lw+gw; ctx.save(); ctx.globalAlpha=0.16;
      ctx.strokeStyle=sc>0.05?`rgb(255,${Math.round(lerp(230,90,sc))},40)`:'rgb(255,230,180)'; ctx.stroke(); ctx.restore(); }
    ctx.lineWidth=lw; ctx.stroke(); }
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
  // order-book levels are no longer drawn; only tramp/wall positions render (drawTrampWalls).
}

function drawRocket(dt){
  const im=IMG.rocket, h=150, w=im.naturalWidth? h*im.naturalWidth/im.naturalHeight : 55;
  // (x,y) = nozzle / aft pivot — trail tip + rotation origin. Nose leads ahead of this point.
  const y=S.ry+(S.bob||0)*0.55, x=(S.camX!=null?S.camX:S.x)+(S.sway||0)*0.45;
  const NOZZLE_FROM_TOP = 0.96; // fraction of sprite height: engine sits just above the bottom edge
  const pivotY = h * NOZZLE_FROM_TOP; // draw offset so nozzle lands on (0,0) after rotate
  // ghost thrust for pending txs (projected, never applied to confirmed altitude)
  for (const p of S.pending){
    const gy=altToScreenY(mcapToAlt(p.proj*S.simF)), a=p.state==='pending'? 0.28+0.12*Math.sin(S.t*14) : p.state==='confirmed'?0.5:0.2;
    ctx.save(); ctx.globalAlpha=a; ctx.translate(x,gy); ctx.rotate(S.heading);
    if(im.complete&&!im.bad) ctx.drawImage(im,-w/2,-pivotY,w,h);
    ctx.restore(); ctx.save(); ctx.strokeStyle=p.side==='buy'?'rgba(140,255,200,.6)':'rgba(255,150,190,.6)'; ctx.setLineDash([4,6]);
    ctx.beginPath(); ctx.moveTo(x+w/2+8,y); ctx.lineTo(x+w/2+8,gy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle=ctx.strokeStyle; ctx.font='11px ui-monospace,monospace';
    ctx.fillText((p.state==='pending'?'PENDING ':p.state==='confirmed'?'CONFIRMED ':'FAILED ')+(p.side==='buy'?'+':'-')+fmtUsd(p.usd), x+w/2+14, gy); ctx.restore();
  }
  // exhaust (procedural): leaves the nozzle opposite the nose
  const braking=S.pending.some(p=>p.side==='sell'&&p.state==='pending');
  const EP=exhaustParams(), flick=EP.flick, flame=EP.flame;
  const sa=Math.sin(S.heading), ca=Math.cos(S.heading), ang=rocketDrawAngle();
  ctx.save(); ctx.globalCompositeOperation='lighter';
  const HOT=softDot('255,240,200'), COLD=softDot('140,190,255');
  { const P=S.particles; for (let i=0;i<P.n;i++){ const p=P.a[i]; ctx.globalAlpha=clamp(0.32*p.life,0,1); blit(p.hot?HOT:COLD,p.x,p.y,p.s*(1.3-p.life*0.3)); } }
  // FLAME CONE — stretched hot sprites along the engine axis; length = volume / speed / climb, flickers, sputters
  { ctx.save(); ctx.translate(x,y); ctx.rotate(ang); const L=(34+170*flame)*(0.85+0.3*flick), Wf=20+12*flame;
    ctx.globalAlpha=clamp(0.55+0.4*flame,0,0.95); ctx.drawImage(FIRE_SPR,-Wf/2,-Wf*0.25,Wf,L);
    ctx.globalAlpha=clamp(0.5+0.5*flame,0,1); ctx.drawImage(CORE_SPR,-Wf*0.28,-Wf*0.15,Wf*0.56,L*0.55);
    // shock diamonds on a strong burn
    if (flame>0.75){ ctx.globalAlpha=clamp((flame-0.75)*1.6,0,0.7); for(let k=1;k<=3;k++){ const yy=L*0.16*k, r=Wf*0.22*(1-k*0.18); ctx.drawImage(CORE_SPR,-r,yy-r,2*r,2*r); } }
    ctx.restore(); }
  // engine core bloom at nozzle
  ctx.globalAlpha=clamp(0.55*flame*flick,0,1); blit(CORE_SPR,x,y,Math.min(90,40+45*flame)*flick);
  ctx.restore();
  // rocket — rotate about nozzle (aft). Nose leads; body trails. No center-spin / scaleX barrel-roll.
  if(im.complete&&!im.bad){
    const ow=Math.ceil(w), oh=Math.ceil(h), RB=rocketSprite(im,ow,oh), P=RB.pad;
    // squash & stretch along the body: stretch on hard climbs, slight squash when sinking (≤6%)
    const st=clamp((S.vyS||0)/1400,-0.5,1)*0.06, sx=1-st*0.5, sy=1+st;
    // motion blur: two faint ghosts trailing along the velocity when fast
    const spd=Math.hypot(S.fwd||0,S.vyS||0);
    if (spd>260){ const bl=clamp((spd-260)/600,0,1); for(let k=2;k>=1;k--){ ctx.save(); ctx.globalAlpha=0.13*bl/k;
      ctx.translate(x-(S.fwd||0)*0.03*k, y+(S.vyS||0)*0.03*k); ctx.rotate(ang); ctx.scale(sx,sy); ctx.drawImage(RB.base,-w/2,-pivotY,w,h); ctx.restore(); } }
    ctx.save(); ctx.translate(x,y); ctx.rotate(ang); ctx.scale(sx,sy);
    // rim light from the sky colour: tinted silhouette offset toward the sky (up-left in world), additive
    const sky=skyNow(), RL=rimSprite(RB,ow,oh,sky); const lx=-1.6*Math.cos(ang)+1.6*Math.sin(ang), ly=-1.6*Math.sin(ang)-1.6*Math.cos(ang);
    ctx.save(); ctx.globalCompositeOperation='lighter'; ctx.globalAlpha=0.85; ctx.drawImage(RL,-w/2+lx*1.5,-pivotY+ly*1.5,w,h); ctx.restore();
    ctx.drawImage(RB.glow,-w/2-P,-pivotY-P,w+2*P,h+2*P);          // cached rocket + glow
    // per-frame lighting on a small scratch canvas masked to the silhouette: sky tint, moving glint, warm engine underlight
    const oc=drawRocket.oc||(drawRocket.oc=document.createElement('canvas'));
    if(oc.width!==ow||oc.height!==oh){ oc.width=ow; oc.height=oh; }
    const o=oc.getContext('2d'); o.globalCompositeOperation='copy'; o.drawImage(RB.base,0,0);
    o.globalCompositeOperation='source-atop';
    const sg=o.createLinearGradient(0,0,ow,0); sg.addColorStop(0,`rgba(${sky[0]},${sky[1]},${sky[2]},.30)`); sg.addColorStop(0.55,`rgba(${sky[0]},${sky[1]},${sky[2]},0)`); o.fillStyle=sg; o.fillRect(0,0,ow,oh);
    const gx=ow/2+(S.glint||0)*w*0.28, gg=o.createLinearGradient(gx-14,oh*0.08,gx+14,oh*0.9);
    gg.addColorStop(0,'rgba(255,255,255,0)'); gg.addColorStop(0.45,`rgba(255,252,240,${0.08+0.12*Math.abs(S.glint||0)})`); gg.addColorStop(1,'rgba(255,255,255,0)');
    o.fillStyle=gg; o.fillRect(0,0,ow,oh);
    const wg=o.createLinearGradient(0,oh,0,oh*0.55); wg.addColorStop(0,`rgba(255,170,90,${clamp(0.45*flame,0,0.5)})`); wg.addColorStop(1,'rgba(255,170,90,0)'); o.fillStyle=wg; o.fillRect(0,0,ow,oh);
    ctx.drawImage(oc,-w/2,-pivotY,w,h);
    ctx.restore();
  }
  // nose tip (for brake rings): ahead of nozzle along heading
  const noseX=x+sa*pivotY, noseY=y-ca*pivotY;
  if (braking){ ctx.save(); ctx.globalCompositeOperation='lighter'; ctx.strokeStyle='rgba(255,140,180,.5)'; ctx.lineWidth=3;
    for(let k=0;k<3;k++){ ctx.beginPath(); ctx.arc(noseX,noseY,30+k*12+Math.sin(S.t*20)*3,Math.PI*1.15+S.heading,Math.PI*1.85+S.heading); ctx.stroke(); } ctx.restore(); }
}

/* rim silhouette tinted with the (quantised) sky colour — rebuilt only when the tint or size changes */
function rimSprite(RB,ow,oh,sky){ const R=rimSprite, key=ow+'x'+oh+'|'+RB.key+'|'+sky.map(v=>v>>4).join(',');
  if(R.key===key) return R.c; const c=R.c||(R.c=document.createElement('canvas')); c.width=ow; c.height=oh; const g=c.getContext('2d');
  g.drawImage(RB.base,0,0); g.globalCompositeOperation='source-in'; g.fillStyle=`rgb(${sky[0]},${sky[1]},${sky[2]})`; g.fillRect(0,0,ow,oh); R.key=key; return c; }
/* Rocket base (sprite + token decal + alpha threshold) and its glow are rebuilt only when the size or
   decal changes (and during the 300 ms decal cross-fade) — previously getImageData ran every frame. */
function rocketSprite(im,ow,oh){ const R=rocketSprite, dec=window.__rocketDecal, has=!!(dec&&dec.canvas);
  const fa=has?clamp((performance.now()-dec.t0)/300,0,1):0, key=ow+'x'+oh+'|'+(has?dec.t0+':'+fa.toFixed(2):'-');
  if(R.key===key) return R;
  const base=R.base||(R.base=document.createElement('canvas')); base.width=ow; base.height=oh; const o=base.getContext('2d');
  o.drawImage(im,0,0,ow,oh); if(has){ o.globalAlpha=fa; o.drawImage(dec.canvas,0,0,ow,oh); o.globalAlpha=1; }
  try{ const d=o.getImageData(0,0,ow,oh), px=d.data; for(let i=3;i<px.length;i+=4) if(px[i]<64) px[i]=0; o.putImageData(d,0,0); }catch(_){}
  const P=R.pad=24, gl=R.glow||(R.glow=document.createElement('canvas')); gl.width=ow+2*P; gl.height=oh+2*P; const g=gl.getContext('2d');
  g.shadowColor='rgba(200,220,255,.8)'; g.shadowBlur=24*W/Math.max(1,cv.width)*1.4; g.drawImage(base,P,P);
  R.key=key; return R; }
/* Exhaust emission runs in the fixed-step sim: rate (particles/s) instead of count-per-rendered-frame. */
function randLane(){ return LANES[Math.floor(Math.random()*3)]; }
function exhaustParams(){ const vol=clamp(Math.log10(1+S.volEma)/3.2,0,1), pend=S.pending.some(p=>p.side==='buy'&&p.state==='pending')?0.5:0;
  const I=clamp(0.3+vol*0.7+pend,0,1.4), flick=0.74+0.26*Math.abs(Math.sin(S.t*37.0))*Math.abs(Math.sin(S.t*17.3+1.7));
  const vy=S.vyS||0, move=clamp(Math.max(0,vy)/300+(S.fwdN||0)*0.9,0,1.5), thrustBoost=(S.aimDeg||0)>0&&S.t-(S.thrustT||-99)<1.2?clamp(S.aimDeg/88,0,1):0;
  // falling: engine sputters (blocky on/off flicker, deeper the faster it sinks)
  const fall=clamp(-vy/320,0,1), n=Math.sin(S.t*29.0)*Math.sin(S.t*13.7+0.6), sput=1-fall*(n>0.15?0.82:0.25);
  return {flick, sput, fall, flame:(I*(0.6+0.85*move+0.55*thrustBoost)+0.7*(S.flare||0))*flick*sput}; }
function exhaustStep(dt){ const EP=exhaustParams(), {flick,flame}=EP; exhaustParams.fall=EP.fall; const _u=0, sa=Math.sin(S.heading), ca=Math.cos(S.heading);
  const tx=(S.camX!=null?S.camX:S.x)+(S.sway||0)*0.45, ty=S.ry+(S.bob||0)*0.55;
  S._exAcc=(S._exAcc||0)+(2+flame*9)*(0.55+flick)*60*dt*(0.75+0.3*(S.fwdN||0)); let n=S._exAcc|0; S._exAcc-=n;
  for(let i=0;i<n;i++){ const sp=(140+Math.random()*280*flame)*(0.75+flick*0.5), j=(Math.random()-.5)*(40+30*flick);
    const p=S.particles.spawn(); p.x=tx+(Math.random()-.5)*10; p.y=ty; p.vx=-sa*sp+ca*j-(S.fwd||0)*0.7; p.vy=ca*sp+sa*j; p.life=0.7+Math.random()*0.45; p.s=(5+Math.random()*14*flame)*flick; p.hot=Math.random()<0.45*(1-0.7*(exhaustParams.fall||0)); } }
// faint 'your entry' altitude marker (set by the PnL HUD: window.__entryMcap)
function drawEntryLine(){ const m=window.__entryMcap; if(!(m>0)||S.displayAlt==null) return; const y=altToScreenY(mcapToAlt(m)); if(y<-20||y>H+20) return;
  const up=(S.confirmed.mcap||0)>=m; ctx.save(); ctx.strokeStyle=up?'rgba(143,240,192,.45)':'rgba(255,159,184,.45)'; ctx.setLineDash([10,8]); ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle=ctx.strokeStyle; ctx.font='bold 11px ui-monospace,monospace';
  ctx.fillText('YOUR ENTRY '+fmtUsd(m),W/2+60,y-6); ctx.restore(); }
// ── TRAMPS & WALLS (graduated coins): individual small elements, sized by $ (log), compact $ tag.
//    React pushes window.__trampWalls [{id,kind:'tramp'|'wall',mcap,lo,hi,sizeUsd,mine,status}] + window.__twPreview.
//    Max ~8 nearest the price, same-level merged. Never over the rocket; no camera shake; heading untouched.
const TW_FX={}, TW_MAX=8;
function twStep(){ const cur=S.confirmed&&S.confirmed.mcap; if(!(cur>0)) return;
  for(const l of (window.__trampWalls||[])){ const st=TW_FX[l.id]||(TW_FX[l.id]={side:null,t0:null});
    const side= l.kind==='tramp' ? (cur<=l.hi?'in':'out') : (cur>=l.hi?'in':'out');
    if(st.side==='out' && side==='in' && l.status==='active' && st.t0==null){ st.t0=S.t;
      try{ dispatchEvent(new CustomEvent('twfilled',{detail:{id:l.id,kind:l.kind}})); }catch(_){} }
    if(l.status==='filled' && st.t0==null) st.t0=S.t-10;
    st.side=side; } }
function fmtTag(v){ return v>=1e6?'$'+(v/1e6).toFixed(1).replace(/\.0$/,'')+'M':v>=1e3?'$'+(v/1e3).toFixed(1).replace(/\.0$/,'')+'K':'$'+Math.round(v); }
/* low-frequency caches (were rebuilt every frame) */
let _topT=-1, _top=[];
function topFuelers(){ if(S.t-_topT<0.5&&_top.length) return _top; _topT=S.t; _top=Object.entries(S.fuelers).sort((a,b)=>b[1]-a[1]); return _top; }
let _twT=-1, _twSrc=null, _twLen=-1, _tw=[]; const TW_LIST=[]; let _pvRef=null, _pvObj=null;
function twGroupsCached(){ const src=window.__trampWalls||null, len=src?src.length:0;
  if (src!==_twSrc || len!==_twLen || S.t-_twT>0.25){ _twSrc=src; _twLen=len; _twT=S.t; _tw=twGroups(); } return _tw; }
function twGroups(){ const cur=S.confirmed&&S.confirmed.mcap||0, src=(window.__trampWalls||[]).filter(l=>l.status!=='cancelled');
  const g=[]; // merge same kind within ~2px of altitude
  for(const l of src){ const a=mcapToAlt(l.mcap); let m=g.find(q=>q.kind===l.kind&&Math.abs(q.alt-a)*PX_PER_ALT<14);
    if(m){ m.sizeUsd+=l.sizeUsd||0; m.mine=m.mine||l.mine; m.ids.push(l.id); if(l.status==='active') m.status='active'; }
    else g.push({kind:l.kind,alt:a,mcap:l.mcap,sizeUsd:l.sizeUsd||0,mine:!!l.mine,status:l.status,ids:[l.id]}); }
  g.sort((x,y)=>Math.abs(x.mcap-cur)-Math.abs(y.mcap-cur)); return g.slice(0,TW_MAX); }
/* tramp/wall geometry shared by the renderer and blast hit-testing (sized by $: log width/thickness) */
const TWP={x:0,y:0,w:0,th:0};
function twPos(l,kx,ky){ const y=altToScreenY(l.alt), L=Math.log10(1+l.sizeUsd), w=clamp(24+L*26,28,150), th=clamp(1+L*1.1,1.5,6);
  let x=W*0.56+(hash(Math.round(l.mcap))-.5)*W*0.16; if(Math.abs(x-kx)<w/2+120&&Math.abs(y-ky)<140) x=kx+(x<kx?-1:1)*(w/2+130);   // slide aside if it would sit under the rocket
  TWP.x=x; TWP.y=y; TWP.w=w; TWP.th=th; return TWP; }
function twKeep(){ const px=(S.camX!=null?S.camX:S.x); return [px+75*Math.sin(S.heading), S.ry-75*Math.cos(S.heading)]; }
function drawTrampWalls(){ if(S.displayAlt==null) return; const list=TW_LIST; list.length=0; for(const g of twGroupsCached()) list.push(g); const pv=window.__twPreview;
  if(pv){ if(pv!==_pvRef||!_pvObj||_pvObj.mcap!==pv.mcap||_pvObj.sizeUsd!==(pv.sizeUsd||0)){ _pvRef=pv; _pvObj={kind:pv.kind,alt:mcapToAlt(pv.mcap),mcap:pv.mcap,sizeUsd:pv.sizeUsd||0,mine:true,status:'active',ids:['__pv'],preview:true}; } list.push(_pvObj); }
  if(!list.length) return;
  const px=(S.camX!=null?S.camX:S.x), kx=px+75*Math.sin(S.heading), ky=S.ry-75*Math.cos(S.heading);
  ctx.save(); ctx.beginPath(); ctx.rect(0,0,W,H); ctx.ellipse(kx,ky,110,120,0,0,Math.PI*2); ctx.clip('evenodd');   // keep-out around rocket
  for(const l of list){ twPos(l,kx,ky); const y=TWP.y; if(y<-30||y>H+30) continue;
    const w=TWP.w, th=TWP.th, tramp=l.kind==='tramp', x=TWP.x;
    const hit=l.ids.reduce((a,id)=>{ const f=TW_FX[id]; return f&&f.hitT!=null&&S.t-f.hitT<a.t?{t:S.t-f.hitT,amp:f.hitAmp}:a; },{t:Infinity,amp:0});
    const age=l.ids.reduce((a,id)=>{ const f=TW_FX[id]; return f&&f.t0!=null?Math.min(a,S.t-f.t0):a; },Infinity), fresh=age<1.5, done=!l.preview&&(l.status==='filled'||isFinite(age));
    const col= tramp?(l.mine?'255,215,110':'140,230,170'):(l.mine?'255,140,130':'205,190,185');
    ctx.globalAlpha= l.preview?0.5+0.3*Math.sin(S.t*8): done&&!fresh?0.3:0.85;
    ctx.strokeStyle=ctx.fillStyle=`rgba(${col},1)`; ctx.lineWidth=th;
    if(l.preview) ctx.setLineDash([5,4]);
    if(tramp){ const sag=(fresh?6*Math.exp(-age*3)*Math.cos(age*16):0) + (hit.t<1.2?hit.amp*7*Math.exp(-hit.t*4)*Math.cos(hit.t*22):0);   // blast shock flexes the bed   // small trampoline: sprung arc + 2 legs; subtle bounce on fill
      ctx.beginPath(); ctx.moveTo(x-w/2,y); ctx.quadraticCurveTo(x,y+th*1.4+3+sag,x+w/2,y);
      { const a0=ctx.globalAlpha; ctx.globalAlpha=a0*(l.mine?0.3:0.18); ctx.lineWidth=th+(l.mine?7:4); ctx.stroke(); ctx.globalAlpha=a0; ctx.lineWidth=th; } ctx.stroke();
      ctx.setLineDash([]); ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(x-w/2,y); ctx.lineTo(x-w/2+3,y+7); ctx.moveTo(x+w/2,y); ctx.lineTo(x+w/2-3,y+7); ctx.stroke();
    } else { // small stone wall: a dome-topped slab; subtle crack chips on fill
      const hgt=th*1.8; ctx.globalAlpha*=0.8; if(hit.t<0.25){ ctx.globalAlpha=Math.min(1,ctx.globalAlpha+0.6*(1-hit.t/0.25)); }   // brief hot flash where the shock struck ctx.beginPath(); ctx.moveTo(x-w/2,y); ctx.lineTo(x-w/2,y-hgt); ctx.quadraticCurveTo(x,y-hgt-th*1.5,x+w/2,y-hgt); ctx.lineTo(x+w/2,y); ctx.closePath(); ctx.fill();
      if(fresh){ const u=age/1.5; ctx.globalAlpha=0.8*(1-u); for(let j=0;j<6;j++){ const a=hash(j+l.mcap)*6.28; ctx.fillRect(x+Math.cos(a)*u*18,y-hgt/2+Math.sin(a)*u*12+u*u*10,2,2); } } }
    ctx.setLineDash([]); ctx.globalAlpha=done&&!fresh?0.45:0.9;
    ctx.font=(l.mine?'bold ':'')+'10px ui-monospace,monospace'; ctx.textAlign='left';
    const tag=fmtTag(l.sizeUsd)+(l.ids.length>1?' ×'+l.ids.length:''), tyy=tramp?y+4:y-th;
    ctx.lineWidth=2.5; ctx.strokeStyle='rgba(0,0,20,.75)'; ctx.strokeText(tag,x+w/2+5,tyy); ctx.fillText(tag,x+w/2+5,tyy);
    ctx.globalAlpha=1; }
  ctx.restore(); }
function screenYToMcap(y){ const base=(S.camAlt!=null?S.camAlt:S.displayAlt); return altToMcap(base-(y-(S.anch??ROCKET_Y))/PX_PER_ALT); }
function drawLanes(){ ctx.save(); ctx.strokeStyle='rgba(220,230,255,.08)'; ctx.setLineDash([6,18]); ctx.lineDashOffset=-S.t*60*(1+Math.log10(1+S.volEma));
  for (const lx of [W/2-130,W/2+130]){ ctx.beginPath(); ctx.moveTo(lx,0); ctx.lineTo(lx,H); ctx.stroke(); } ctx.restore(); }
function drawFx(dt){
  // collectible motes (cosmetic, lateral gameplay)
  ctx.save(); ctx.globalCompositeOperation='lighter';
  for (const m of S.motes){ const T=ORB[m.k]; blit(radialSprite('orb'+m.k,[[0,T.c0],[1,T.c1]]),m.x,m.y,T.r*(1+0.12*Math.sin(S.t*6+m.x))); }
  { const P=S.shards; for (let i=0;i<P.n;i++){ const s=P.a[i]; ctx.fillStyle=s.c; ctx.globalAlpha=clamp(s.life,0,1); ctx.fillRect(s.x,s.y,3,3); } }
  ctx.restore(); ctx.globalAlpha=1;
  // PENALTY orbs: dark red/black storm cores (normal blending so they read as dark), crackling rim
  for (const o of S.obstacles){ const T=ORB[o.k], r=T.r; ctx.save();
    blit(radialSprite('obs'+o.k,[[0,T.c0],[.55,T.c1],[1,'rgba(40,0,0,0)']]),o.x,o.y,r*1.6);
    ctx.strokeStyle=T.rim; ctx.beginPath();
    for(let k=0;k<=10;k++){ const a=k/10*6.283+S.t*3, rr=r*(0.9+0.25*hash(k+Math.floor(S.t*12)+o.x)); k?ctx.lineTo(o.x+Math.cos(a)*rr,o.y+Math.sin(a)*rr):ctx.moveTo(o.x+Math.cos(a)*rr,o.y+Math.sin(a)*rr); }
    ctx.globalAlpha=0.3; ctx.lineWidth=7; ctx.stroke(); ctx.globalAlpha=1; ctx.lineWidth=2; ctx.stroke();   // glow underlay instead of shadowBlur
    ctx.fillStyle=T.rim; ctx.font='bold 10px ui-monospace,monospace'; ctx.textAlign='center'; ctx.fillText(T.tag,o.x,o.y+r+14); ctx.restore(); }
  for (const f of S.floaters){ ctx.save(); ctx.globalAlpha=clamp(f.life,0,1); ctx.fillStyle=f.c; ctx.font=f.small?'bold 13px ui-monospace,monospace':'bold 16px ui-monospace,monospace'; ctx.textAlign='center'; ctx.fillText(f.txt,f.x,f.y); ctx.restore(); }
}

function drawPost(){
  // bloom-ish: brighten highlights by re-drawing the frame blurred & additive (cheap: downscaled copy)
  // (full-screen self-copy bloom removed: reading the canvas back every frame stalls the GPU pipeline;
  //  glow now comes from the cached additive sprites themselves)
  ctx.drawImage(VIGNETTE,0,0,W,H);   // cached vignette
  // grain
  const g=grain[(S.t*24|0)%4]; ctx.save(); ctx.globalCompositeOperation='overlay'; const ox=(Math.random()*256)|0, oy=(Math.random()*256)|0;
  for(let x=-ox;x<W;x+=256) for(let y=-oy;y<H;y+=256) ctx.drawImage(g,x,y); ctx.restore();
}

/* text glow without shadowBlur: a wide, faint round stroke in the glow colour under the fill */
function glowText(t,x,y,glow,lw,a){ ctx.save(); ctx.lineJoin='round'; ctx.strokeStyle=glow; const g=ctx.globalAlpha*(a||0.35)*0.4;
  for(const f of GLOW_STEPS){ ctx.globalAlpha=g; ctx.lineWidth=lw*f; ctx.strokeText(t,x,y); } ctx.restore(); ctx.fillText(t,x,y); }   // 3 soft rings ≈ blur halo
const GLOW_STEPS=[1.6,1.0,0.5];
/* MOMENTUM widget: candle window, arrow along the nose, buy-vs-sell pressure bar, turn-around cue */
function panel(x,y,w,h){ ctx.save(); ctx.fillStyle='rgba(8,10,28,.62)'; ctx.strokeStyle='rgba(220,230,255,.18)'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.roundRect? ctx.roundRect(x,y,w,h,10) : ctx.rect(x,y,w,h); ctx.fill(); ctx.stroke(); ctx.restore(); }

function drawHud(){
  const m=S.confirmed.mcap, a=S.displayAlt, ti=clamp(Math.floor(mcapToAlt(m)),0,TIERS.length-1), t=TIERS[ti];
  ctx.save(); ctx.textBaseline='alphabetic';
  // top-left: MCAP + tier
  panel(20,18,380,112);
  ctx.fillStyle='rgba(200,210,255,.7)'; ctx.font='12px ui-monospace,monospace'; ctx.fillText(IS_POOL&&source.real?`PRICE $${(S.confirmed.mcap/source.supply).toFixed(5)}${source.paper!==1?' (incl. paper '+((source.paper-1)*100).toFixed(2)+'%)':''}`:'MARKET CAP · confirmed',36,42);
  ctx.fillStyle='#fff'; ctx.font='bold 40px ui-monospace,monospace'; glowText(fmtUsd(m),34,84,'rgb(180,200,255)',8,0.3);
  ctx.fillStyle='#ffe7a3'; ctx.font='bold 14px ui-monospace,monospace'; ctx.fillText(`TIER ${ti} · ${t.name}`,36,108);
  // progress to next tier
  const f=clamp(mcapToAlt(m)-ti,0,1); ctx.fillStyle='rgba(255,255,255,.12)'; ctx.fillRect(36,116,348,4); ctx.fillStyle='#ffe7a3'; ctx.fillRect(36,116,348*f,4);
  if (ti<TIERS.length-1){ ctx.fillStyle='rgba(255,255,255,.55)'; ctx.font='10px ui-monospace,monospace'; ctx.textAlign='right'; ctx.fillText('next '+fmtUsd(TIERS[ti+1].lo),384,108); ctx.textAlign='left'; }
  // top-right column starts below the site's wallet strip + the Share/Exit row (FlightCanvas measures it)
  S.hudRT=S.hudRT==null?Math.max(18,+window.__hudRT||0):lerp(S.hudRT,Math.max(18,+window.__hudRT||0),0.15); const RT=Math.round(S.hudRT), RX=W-330;   // eased: no HUD jump when the wallet strip changes height
  panel(RX,RT,310,92);
  const sinceSwap=(performance.now()-S.confirmed.lastSwapTs)/1000, holding=sinceSwap>1.5;
  ctx.fillStyle=S.status.ok?'#8ff0c0':'#ff8f8f'; ctx.font='bold 12px ui-monospace,monospace'; ctx.fillText('● '+(S.status.source||source.name),RX+16,RT+24);
  ctx.fillStyle='rgba(220,228,255,.8)'; ctx.font='11px ui-monospace,monospace'; ctx.fillText(String(S.status.msg).slice(0,40),RX+16,RT+42);
  if (SIM.on){ ctx.fillStyle='#c9b8ff'; ctx.font='bold 11px ui-monospace,monospace'; const d=(S.simF-1)*100;
    ctx.fillText(`◆ SIMULATED MARKET · ${SIM_REG[SIM.regime].n}  ${d>=0?'+':''}${d.toFixed(1)}%`,RX+16,RT+60); }
  else { ctx.fillText(`block #${S.confirmed.block}`,RX+16,RT+60); }
  ctx.font='11px ui-monospace,monospace'; ctx.fillStyle=holding?'#ffd98a':'#8ff0c0'; ctx.fillText(holding?`HOLDING · no trades ${sinceSwap.toFixed(1)}s`:'LIVE · trade flow',RX+16,RT+78);
  const top=topFuelers(); panel(RX,RT+100,310,96);
  ctx.fillStyle='#ffe7a3'; ctx.font='bold 12px ui-monospace,monospace'; ctx.fillText(IS_POOL?'TOP BUYERS · real wallets in feed':'KING OF THE HILL · top fuelers (mock)',RX+16,RT+120);
  top.slice(0,3).forEach(([w,v],i)=>{ ctx.fillStyle=w==='you'?'#9ff3c8':'rgba(220,228,255,.85)'; ctx.font='11px ui-monospace,monospace'; ctx.fillText(`${i===0?'👑':' '+(i+1)} ${w.padEnd(11)} ${fmtUsd(v)}`,RX+16,RT+140+i*18); });
  if (top[0][0]==='you'){ ctx.save(); ctx.fillStyle='#ffd24a'; ctx.font='bold 16px ui-monospace,monospace'; ctx.textAlign='center'; glowText('👑 KOTH',S.x,S.ry-100,'#ffb000',8,0.4); ctx.restore(); }
  // bottom-left: trade feed (compact)
  panel(20,H-160,310,140); ctx.font='12px ui-monospace,monospace';
  ctx.fillStyle='rgba(200,210,255,.7)'; ctx.fillText(IS_POOL?'TRADES (real onchain + your paper)':'TRADES (onchain only)',36,H-138);
  S.feed.slice(0,6).forEach((r,i)=>{ ctx.fillStyle=r.c; ctx.globalAlpha=1-i*0.12; ctx.fillText(r.txt.slice(0,38),36,H-116+i*17); }); ctx.globalAlpha=1;
  // bottom-right: controls (compact)
  panel(RX,H-104,310,84);
  const md=MODES[S.mode]; ctx.fillStyle='#fff'; ctx.font='bold 12px ui-monospace,monospace'; ctx.fillText(`MODE ${md.name} · ${fmtShot(md.usd)}/shot  [1-6 / click]`,RX+16,H-82);
  ctx.font='11px ui-monospace,monospace'; ctx.fillStyle='#9ff3c8'; ctx.fillText('SPACE fuel',RX+16,H-64); ctx.fillStyle='#ffb0c8'; ctx.fillText('SHIFT bomb',RX+100,H-64);
  ctx.fillStyle='rgba(220,228,255,.8)'; ctx.fillText('A/D lane',RX+190,H-64);
  ctx.fillText(`pending ${S.pending.filter(p=>p.state==='pending').length}/${MAX_PENDING}${source instanceof MockReplaySource?'   T turbo '+(S.turbo?'ON':'off'):''}`,RX+16,H-46);
  if (S.orbsOn){ ctx.fillStyle='#ffe7a3'; ctx.fillText(`POINTS ${S.score}  streak ${S.streak}${S.mult>1?'  ×'+S.mult:''}`,RX+16,H-28); }
  // top-centre: ammo tiles (mouse-clickable — see AMMO_HIT / pointer handlers)
  const am=autoMode(m), AW=472, ax=Math.round(Math.max(410,Math.min((W-AW)/2,RX-14-AW))), ay=18; panel(ax,ay,AW,82);
  ctx.fillStyle='rgba(200,210,255,.7)'; ctx.font='11px ui-monospace,monospace'; ctx.fillText(`AMMO · auto by depth: ${MODES[am].name} (${MODES[am].range})`,ax+12,ay+16);
  MODES.forEach((q,i)=>{ const bx=ax+12+i*76, by=ay+24, below=q.usd<MIN_SHOT, hov=i===S.ammoHover, sel=i===S.mode; const R=AMMO_HIT[i]; R.x=bx; R.y=by; R.w=72; R.h=30;
    ctx.fillStyle=sel?'rgba(255,231,163,.9)':hov?'rgba(255,255,255,.22)':'rgba(255,255,255,.08)'; ctx.fillRect(bx,by,72,30);
    ctx.strokeStyle=hov?'#fff':i===am?'#9ff3c8':'rgba(255,255,255,.2)'; ctx.lineWidth=hov||i===am?2:1; ctx.strokeRect(bx,by,72,30);
    ctx.fillStyle=sel?'#1a1630':'#e8ecff'; ctx.font='bold 10px ui-monospace,monospace'; ctx.fillText(`${q.key} ${q.name}`,bx+5,by+13); ctx.font='10px ui-monospace,monospace'; ctx.fillText(fmtShot(q.usd)+(below?' ·min✗':''),bx+5,by+25); });
  ctx.font='11px ui-monospace,monospace';
  if (MODES[S.mode].usd<MIN_SHOT){ ctx.fillStyle='#ffb0c8'; ctx.fillText(`below min shot on ${CHAIN.label} (${fmtShot(MIN_SHOT)}): blocked`,ax+12,ay+72); }
  else { ctx.fillStyle='#9ff3c8'; ctx.fillText(`PAPER $${S.balance.toFixed(2)} · min shot ${fmtShot(MIN_SHOT)} · gas ≈$${GAS_USD.toFixed(4)}`,ax+12,ay+72); }
  S.toasts.slice(0,3).forEach((t,i)=>{ const a=clamp(t.life,0,1), y=ay+92+i*58, tx=Math.round(ax+(AW-300)/2); ctx.globalAlpha=a; panel(tx,y,300,50);
    ctx.fillStyle='#ffe7a3'; ctx.font='bold 13px ui-monospace,monospace'; ctx.fillText('★ ACHIEVEMENT · '+t.title,tx+14,y+21); ctx.fillStyle='rgba(220,228,255,.85)'; ctx.font='11px ui-monospace,monospace'; ctx.fillText(t.sub,tx+14,y+39); ctx.globalAlpha=1; });
  // tier banner
  if (S.tierBanner>0){ ctx.globalAlpha=clamp(S.tierBanner,0,1); ctx.textAlign='center'; ctx.fillStyle='#fff7df';
    const BY=BANNER_Y; let fs=54; ctx.font=`bold ${fs}px Georgia,serif`; while(ctx.measureText(TIERS[S.tierShown].name).width>W-120&&fs>24){ fs-=4; ctx.font=`bold ${fs}px Georgia,serif`; } glowText(TIERS[S.tierShown].name,W/2,BY,'rgb(255,220,150)',14,0.3); ctx.font='16px ui-monospace,monospace'; glowText('ENTERED · '+fmtUsd(TIERS[S.tierShown].lo)+'+ MCAP',W/2,BY+30,'rgb(255,220,150)',6,0.3);
    ctx.textAlign='left'; ctx.globalAlpha=1; }
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
  {k:'puff',    name:'BRAKE',         min:0,                life:0.6, sf:0,   tau:0},
  {k:'grenade', name:'GRENADE',       min:BOMB_PCT.GRENADE, life:0.9, sf:11,  tau:0.12},
  {k:'bunker',  name:'BUNKER BUSTER', min:BOMB_PCT.BUNKER,  life:2.0, sf:9,   tau:0.22, fall:0.45},
  {k:'cruise',  name:'CRUISE MISSILE',min:BOMB_PCT.CRUISE,  life:2.2, sf:7,   tau:0.40, fall:0.55},
  {k:'nuke',    name:'NUKE',          min:BOMB_PCT.NUKE,    life:2.8, sf:5.5, tau:0.70, fall:0.30},
  {k:'atom',    name:'ATOM BOMB',     min:BOMB_PCT.ATOM,    life:4.6, sf:3.2, tau:1.10, fall:0.40},
];
const BOMB_ALIASES={daisy:'cruise', moab:'nuke'};
const BOMB_MERGE_WIN=0.30;   // s (sim time): sells landing within this window merge into one bomb
const BOMB_MIN_GAP=0.55;     // s between detonations (queue otherwise)
const BOMB_MAX_ACTIVE=2;     // live blasts on screen (puffs excluded)
const BOMB_MAX_QUEUE=2;      // overflow merges into the last queued bomb (×N)
const SLOWMO_S=0.6, SLOWMO_SCALE=0.3;
function bombTierOf(pct){ let i=0;   // tier = price impact only; a full-bag dump is NOT automatically an ATOM
  for(let k=0;k<BOMB_TIERS.length;k++) if(pct>=BOMB_TIERS[k].min) i=k; return i; }
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
S.bombsOn=localStorage.getItem('disciple.bombs')!=='off';
S.bombFrame=null; S.bombQ=[]; S.bombs=[]; S.bfx=new Pool(CAP.bfx); S.bombLabels=[]; S.lastBombT=-99; S.lastPuffT=-99;
S.scorch=0; S.slowmoUntil=-1; S.timeScale=1; S.screenFlash=null;
function setBombs(on){ S.bombsOn=on; try{localStorage.setItem('disciple.bombs',on?'on':'off');}catch(_){} dispatchEvent(new Event('apflightbombs')); }
function setShake(){ /* camera shake removed permanently; kept as a no-op for the settings page API */ }
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
  let active=0; for (const b of S.bombs) if(b.age<b.T.life*0.6) active++;
  if (S.bombQ.length && S.t-S.bombQ[0].t>=0.05 && S.t-S.lastBombT>=BOMB_MIN_GAP && active<BOMB_MAX_ACTIVE){
    const f=S.bombQ.shift(); launchBomb(bPct(f),f); }
  for (const tm of simTimers) if(!tm.done&&S.t>=tm.at){ tm.done=true; tm.fn(); }
  // 3) advance
  for (const b of S.bombs){ b.age+=dt; if(!b.det && b.age>=(b.T.fall||0)){ b.det=true; detonate(b); } }
  keepIf(S.bombs,BOMB_LIVE);
  bfxStep(dt);
  for (const l of S.bombLabels) l.age+=dt; keepIf(S.bombLabels,LABEL_LIVE);
  S.scorch=Math.max(0,S.scorch-dt/7);
}
const BOMB_LIVE=b=>b.age<b.T.life+(b.T.fall||0), LABEL_LIVE=l=>l.age<l.life;
/* SMOKE & DEBRIS PHYSICS (fixed step).
   smoke : relaxes toward the local wind (drag = entrainment), rises with buoyancy that fades as it
           cools, expands fast then slower (entrainment growth), fades in quickly and out smoothly.
   others: ballistic with exponential drag + gravity (chunks/embers), unchanged look. */
const SMOKE_BUOY=55, SMOKE_GROW=10;
function windAt(y){ return -34 + 12*Math.sin(S.t*0.31) + 7*Math.sin(S.t*1.17 + y*0.012); }   // px/s, gentle gusts
function bfxStep(dt){ const P=S.bfx;
  for (let i=P.n-1;i>=0;i--){ const p=P.a[i]; p.life-=dt; if(p.life<=0||p.y<-200||p.y>H+200){ P.kill(i); continue; }
    if (p.k==='smoke'){ const u=1-p.life/p.max, k=1-Math.exp(-dt*(p.drag||1.5));
      p.vx+=(windAt(p.y)-p.vx)*k; p.vy+=(0-p.vy)*k; p.vy-=SMOKE_BUOY*(1-u)*dt;
      p.r+=((p.gr||0)*(1-u)*(1-u)+SMOKE_GROW)*dt; }
    else { const d=Math.exp(-dt*(p.drag||0)); p.vx*=d; p.vy*=d; p.vy+=(p.g||0)*dt; p.r+=(p.gr||0)*dt; }
    p.x+=p.vx*dt; p.y+=p.vy*dt; } }
/* =====================================================================
   SHOCKWAVES — every bomb launches an expanding front from its real blast point. Things react when the
   front reaches them (d crosses r between steps), with falloff (1-d/R)²:
     smoke/embers/exhaust: radial velocity kick (smoke also puffs up)
     clouds: pushed/lofted and thinned (dissipate, then re-form)
     tramps/walls: hit-tested against their $-sized box → bed flex / wall flash + chips
     rocket: hit-tested against its capsule silhouette → small attitude wobble (spring), still clamped
   ===================================================================== */
const SHOCK={grenade:{v:520,R:140,amp:70}, bunker:{v:700,R:240,amp:150}, cruise:{v:900,R:440,amp:260}, nuke:{v:1150,R:720,amp:420}, atom:{v:1300,R:1150,amp:640}};
const WOB_MAX=6, WOB_W=13, WOB_Z=0.32;   // deg, rad/s, damping ratio (underdamped → a couple of visible rocks)
S.shocks=[]; S.wob=0; S.wobV=0;
function addShock(x,y,k){ const T=SHOCK[k]; if(T) S.shocks.push({x,y,r:0,v:T.v,R:T.R,amp:T.amp}); }
const fall=(d,R)=>{ if(d>=R) return 0; const u=1-d/R; return u*u; };
function rocketCapsule(){ const h=S.heading, px=(S.camX!=null?S.camX:S.x)+(S.sway||0)*0.45, py=S.ry+(S.bob||0)*0.55, L=144;
  RC.ax=px; RC.ay=py; RC.bx=px+Math.sin(h)*L; RC.by=py-Math.cos(h)*L; RC.r=18; return RC; }
const RC={ax:0,ay:0,bx:0,by:0,r:0};
function segDist(px,py,c){ const vx=c.bx-c.ax, vy=c.by-c.ay, t=clamp(((px-c.ax)*vx+(py-c.ay)*vy)/(vx*vx+vy*vy||1),0,1);
  SD.t=t; SD.x=c.ax+vx*t; SD.y=c.ay+vy*t; return Math.hypot(px-SD.x,py-SD.y); }
const SD={t:0,x:0,y:0};
function kickPool(P,sx,sy,r0,r1,R,amp,mul){ for(let i=0;i<P.n;i++){ const p=P.a[i], dx=p.x-sx, dy=p.y-sy, d=Math.hypot(dx,dy)+1e-3;
  if(d<=r0||d>r1) continue; const f=fall(d,R); if(!f) continue; const kv=amp*f*mul; p.vx+=dx/d*kv; p.vy+=dy/d*kv; if(p.k==='smoke') p.r+=8*f; } }
function shockStep(dt){
  if(!S.shocks.length){ wobStep(dt); return; }
  let tw=null;
  for (const sh of S.shocks){ const r0=sh.r; sh.r+=sh.v*dt; const r1=sh.r;
    kickPool(S.bfx,sh.x,sh.y,r0,r1,sh.R,sh.amp,1.4); kickPool(S.particles,sh.x,sh.y,r0,r1,sh.R,sh.amp,0.6);
    for (const c of CLOUDS){ cloudBase(c); const dx=CB.x+c.ox-sh.x, dy=CB.y+c.oy-sh.y, d=Math.hypot(dx,dy)+1; if(d<=r0-c.r*0.5||d>r1+c.r*0.5||c._sh===sh) continue;
      const f=1/(1+(d/sh.R)*(d/sh.R)); c._sh=sh; c.vx+=dx/d*sh.amp*f*(0.6+c.spd); c.vy+=dy/d*sh.amp*f*(0.6+c.spd)-sh.amp*0.15*f; c.dens=Math.max(0.08,c.dens-f*Math.min(0.9,sh.amp/500)); }
    // rocket silhouette
    const rc=rocketCapsule(), dr=Math.max(0,segDist(sh.x,sh.y,rc)-rc.r);
    if ((dr>r0||r0===0) && dr<=r1){ const f=fall(dr,sh.R); if(f>0){
      // torque: push the hit point away from the blast; lever = distance from the nozzle pivot along the body
      const nx=rc.bx-rc.ax, ny=rc.by-rc.ay, L=Math.hypot(nx,ny)||1, px=SD.x-sh.x, py=SD.y-sh.y, pl=Math.hypot(px,py)||1;
      const dAim=(-nx*(py/pl)+ny*(px/pl))/L;   // d(aim)/d(push) sign in screen coords (y down), deg-agnostic
      const sg=Math.abs(dAim)>0.12?Math.sign(dAim):(sh.y>=SD.y?1:-1);   // along-axis hits still rock it (blast below → nose kicks up)
      S.wobV+=sg*clamp(0.35*sh.amp*f*(0.5+0.5*Math.abs(dAim)),0,140); } }
    // tramps & walls ($-sized boxes)
    if (window.__trampWalls && window.__trampWalls.length){ if(!tw){ tw=twGroupsCached(); } const [kx,ky]=twKeep();
      for (const l of tw){ const g=twPos(l,kx,ky), hx=g.w/2, hy=g.th*2+4, ddx=Math.max(0,Math.abs(sh.x-g.x)-hx), ddy=Math.max(0,Math.abs(sh.y-(g.y-hy/2))-hy/2), d=Math.hypot(ddx,ddy);
        if (d>r0 && d<=r1){ const f=fall(d,sh.R); if(f>0) for (const id of l.ids){ const st=TW_FX[id]||(TW_FX[id]={side:null,t0:null}); st.hitT=S.t; st.hitAmp=clamp(f*sh.amp/200,0.2,1);
          if(l.kind!=='tramp') for(let i=0;i<Math.round(4+8*f);i++) spawnShard(g.x+(Math.random()-.5)*g.w, g.y-g.th, (Math.random()-.5)*220, -80-Math.random()*200, '#d8ccc6'); } } } }
  }
  keepIf(S.shocks,SHOCK_LIVE); wobStep(dt); }
const SHOCK_LIVE=sh=>sh.r<sh.R;
function wobStep(dt){ S.wobV+=(-WOB_W*WOB_W*S.wob-2*WOB_Z*WOB_W*S.wobV)*dt; S.wob=clamp(S.wob+S.wobV*dt,-WOB_MAX,WOB_MAX); if(Math.abs(S.wob)===WOB_MAX) S.wobV*=-0.3; }
function bfxSpawn(k,x,y,vx,vy,r,gr,life,drag,c,a,g){ const p=S.bfx.spawn(); p.k=k; p.x=x; p.y=y; p.vx=vx; p.vy=vy; p.r=p.r0=r; p.gr=gr; p.life=p.max=life; p.drag=drag; p.c=c; p.a=a; p.g=g||0; return p; }
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
function spawnPuff(){ const tp=tipPoint(), y=altToScreenY(tp.alt);
  for(let i=0;i<7;i++) bfxSpawn('smoke',tp.x-10,y+(Math.random()-.5)*8,-60-Math.random()*90,(Math.random()-.5)*50,5+Math.random()*5,28,0.6,3,'225,215,190',0.32);
  for(let i=0;i<4;i++) bfxSpawn('spark',tp.x,y,-120-Math.random()*120,(Math.random()-.5)*90,1.6,0,0.3,4,'255,220,150',0.8); }
function burst(x,y,n,spd,opt){ const fn=typeof opt==='function';
  for(let i=0;i<n;i++){ const a=Math.random()*6.2832, v=spd*(0.35+Math.random()*0.65), o=fn?opt(i,a):opt;
    bfxSpawn(o.k||'spark',x,y,o.vx!=null?o.vx:Math.cos(a)*v,o.vy!=null?o.vy:Math.sin(a)*v,o.r!=null?o.r:2,o.gr||0,o.life!=null?o.life:1,o.drag!=null?o.drag:2,o.c||'255,220,140',o.a!=null?o.a:1,o.g||0); } }
function detonate(b){
  const x=b.x, y=bombY(b), k=b.T.k; b.y0=y; b.detAge=b.age; addShock(x,y,k);   // real blast point
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
    S.screenFlash={t0:S.t,dur:0.45,a:0.55,c:'255,240,200'};
  } else if (k==='atom'){
    burst(x,y,110,900,{k:'ember',r:3,life:2.2,max:2.2,drag:1.1,g:90,c:'255,225,150'});
    S.screenFlash={t0:S.t,dur:0.9,a:0.95,c:'255,255,250'};
    S.slowmoUntil=S.t+SLOWMO_S*SLOWMO_SCALE; S.scorch=1;
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
          bfxSpawn('smoke',mx-Math.cos(ang)*12,my-Math.sin(ang)*12,-20+Math.random()*10,-10+Math.random()*20,6+Math.random()*8,20,0.7,2,'160,150,140',0.4); }
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
        ctx.strokeStyle=`rgba(20,12,10,${0.8*a})`; ctx.lineWidth=4; ctx.stroke(); ctx.strokeStyle=`rgba(255,200,90,${0.3*a})`; ctx.lineWidth=5; ctx.stroke(); ctx.strokeStyle=`rgba(255,215,120,${0.9*a})`; ctx.lineWidth=1.4; ctx.stroke(); }
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
  for (let i=0;i<S.bfx.n;i++){ const p=S.bfx.a[i]; const v=clamp(p.life/p.max,0,1), a=p.a*v;
    if (p.k==='smoke'){ const age=p.max-p.life, fin=clamp(age/0.12,0,1);   // quick fade-in, smooth fade-out, thinner as it expands
      ctx.globalCompositeOperation='source-over'; ctx.globalAlpha=clamp(p.a*fin*Math.pow(v,1.3)*Math.min(1,1.6*p.r0/Math.max(p.r,1e-3)+0.25),0,1); blit(softDot(p.c),p.x,p.y,p.r); ctx.globalAlpha=1; }
    else if (p.k==='streak'){ ctx.globalCompositeOperation='lighter'; ctx.strokeStyle=`rgba(${p.c},${a})`; ctx.lineWidth=p.r; ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x-p.vx*0.06,p.y-p.vy*0.06); ctx.stroke(); }
    else if (p.k==='chunk'){ ctx.globalCompositeOperation='source-over'; ctx.fillStyle=`rgba(${p.c},${a})`; ctx.fillRect(p.x-p.r,p.y-p.r,p.r*2,p.r*2); }
    else { ctx.globalCompositeOperation='lighter'; ctx.fillStyle=`rgba(${p.c},${a})`; ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,6.2832); ctx.fill(); } }
  ctx.restore(); ctx.globalCompositeOperation='source-over'; ctx.globalAlpha=1;
}
function fireball(x,y,r,a){ if(a<=0||r<=1) return; const ga=ctx.globalAlpha; ctx.globalAlpha=ga*clamp(a,0,1); blit(FIRE_SPR,x,y,r); ctx.globalAlpha=ga; }
function ring(x,y,r,a,w,c){ if(a<=0) return; ctx.beginPath(); ctx.arc(x,y,r,0,6.2832);
  ctx.strokeStyle=`rgba(${c},${a*0.28})`; ctx.lineWidth=w*3.2; ctx.stroke();   // glow underlay (was shadowBlur w*3)
  ctx.strokeStyle=`rgba(${c},${a})`; ctx.lineWidth=w; ctx.stroke(); }
function godRays(x,y,R,a,seed,n){ if(a<=0) return;
  const g=ctx.createRadialGradient(x,y,0,x,y,R); g.addColorStop(0,`rgba(255,248,215,${a})`); g.addColorStop(1,'rgba(255,230,160,0)'); ctx.fillStyle=g;   // one gradient for all rays
  ctx.beginPath(); for(let i=0;i<n;i++){ const ang=hash(seed+i)*6.2832, w=0.04+0.05*hash(seed+i*3); ctx.moveTo(x,y); ctx.arc(x,y,R,ang-w,ang+w); ctx.closePath(); } ctx.fill(); }
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
  ctx.globalAlpha=0.6*fade;
  for(let i=0;i<9;i++){ const v=i/8, py=lerp(y,cy,v), rr=sw*(1.6-0.6*v)+6;
    blit(radialSprite('stem'+i,[[0,`rgba(${Math.round(lerp(120,240,v))},${Math.round(lerp(80,150,v))},60,1)`],[1,'rgba(80,55,50,0)']]),x+Math.sin(t*2+i)*3,py,rr); }
  ctx.globalAlpha=fade;
  // cap: rolling toroid of puffs, hot gold core cooling to smoke at the rim
  for (const p of b.puffs){ const ang=p.a+t*0.35*p.s, rx=Math.cos(ang)*capR*(0.35+0.7*p.r), ry=Math.sin(ang)*capR*0.42*(0.4+0.6*p.r)-capR*0.12;
    const rr=capR*0.42*p.s, px=x+rx, py=cy+ry, hot=clamp(1-p.r*0.8-t*0.18,0,1);
    const q=Math.round(hot*15), h=q/15;   // 16 cached heat levels
    blit(radialSprite('cap'+q,[[0,`rgba(${Math.round(lerp(120,255,h))},${Math.round(lerp(70,170,h))},${Math.round(lerp(55,70,h))},1)`],[0.65,`rgba(${Math.round(lerp(80,200,h))},${Math.round(lerp(55,90,h))},45,.75)`],[1,'rgba(60,45,45,0)']],96),px,py,rr); }
  ctx.globalAlpha=1; ctx.globalCompositeOperation='lighter'; fireball(x,cy-capR*0.1,capR*0.45,0.35*fade*clamp(1.4-t*0.35,0,1));
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
    ctx.fillStyle=l.tier>=5?'#fffdf2':'#ffd77a'; glowText(l.txt,0,0,'rgb(255,210,120)',9,0.3); ctx.restore(); }
}
/* Debug hooks: ?debugBomb=puff|grenade|bunker|cruise|nuke|atom|cycle  [&debugBombAt=1.2]
   Aliases: daisy→cruise, moab→nuke. window.__flight.bomb('nuke') or bomb(7.5) (impact %). */
function debugBomb(spec,opt){ opt=opt||{};
  if (typeof spec==='string' && BOMB_ALIASES[spec]) spec=BOMB_ALIASES[spec];
  const i=typeof spec==='number'?null:BOMB_TIERS.findIndex(t=>t.k===spec);
  const pct=typeof spec==='number'?spec:[0.8,3.2,8,18,35,55][Math.max(0,i)];
  noteSell({side:'sell',usd:opt.usd??[40,600,8900,31e3,120e3,480e3][Math.max(0,bombTierOf(pct))],impactPct:pct,trader:opt.trader||'0xabc1230000000000000000000000000000def456',fullStack:!!opt.fullStack}); }

/*HEADING-BEGIN*/
function rocketDrawAngle(){ const a=clamp((S.aimDisp||0)-(S.microRot||0)*180/Math.PI+(S.wob||0),AIM_MIN,AIM_MAX); return Math.PI/2-a*Math.PI/180; }   // blast wobble ≤ ±6°, final angle still clamped
/* Rocket heading physics (pure; unit-tested by web/scripts/test-heading.mjs).
   aim = degrees above horizontal with nose right: 0 = sideways cruise, 88 = near vertical.
   Clamped to [AIM_MIN, AIM_MAX]: never past vertical, never nose-down/backward, never flips.
   Sells/dumps/bombs may only dip the nose to AIM_MIN. Critically damped spring on a
   rate-limited target, angular speed capped at AIM_MAX_RATE. No angle wrapping anywhere. */
const AIM_MIN=-60, AIM_MAX=90, AIM_MAX_RATE=110, AIM_W=9, AIM_SUB=1/120;   // max internal substep (s)
/* Attitude v3 (maker lee): the nose follows the candle. aim = degrees above horizontal, nose right.
   A hard pump stands the rocket vertical (90°), a fast dump dives it nose-DOWN to −60°, a flat candle
   cruises at a forward lean (AIM_REST 74°). vy = momentum over the selected candle window (world px/s, +up),
   fwdN = 0..1 forward speed, fight = degrees of buy/sell push-back (buys pull a dive up, sells push a pump
   over). The band is one contiguous interval that never reaches ±180°: it cannot pass vertical or flip,
   and stepHeading rate-limits every change to AIM_MAX_RATE °/s. */
const AIM_REST=74;
function aimFromMotion(vy, fwdN, fight, v0){
  const cl=(v,a,b)=>v<a?a:v>b?b:v; vy=Number.isFinite(vy)?vy:0; fwdN=Number.isFinite(fwdN)?cl(fwdN,0,1):0; fight=Number.isFinite(fight)?cl(fight,-60,60):0;
  const u=Math.tanh(vy/(v0>0?v0:140));
  const a=AIM_REST + (u>0?(AIM_MAX-AIM_REST)*u:(AIM_REST-AIM_MIN)*u) - 5*fwdN + fight;
  return cl(a,AIM_MIN,AIM_MAX);
}
function stepHeading(st, wantAimDeg, bankDeg, dt){
  const cl=(v,a,b)=>v<a?a:v>b?b:v;
  if (!(dt>0)) return st.aimDisp;
  // dt-based: large dt is split into ≤AIM_SUB substeps so the spring is stable at any caller rate
  if (dt>AIM_SUB*1.0001){ const n=Math.ceil(dt/AIM_SUB-1e-6), h=dt/n; for(let i=0;i<n;i++) stepHeadingOnce(st,wantAimDeg,bankDeg,h); return st.aimDisp; }
  return stepHeadingOnce(st,wantAimDeg,bankDeg,dt);
}
function stepHeadingOnce(st, wantAimDeg, bankDeg, dt){
  const cl=(v,a,b)=>v<a?a:v>b?b:v;
  if (!Number.isFinite(st.aimDisp)||st.aimDisp<AIM_MIN) st.aimDisp=AIM_REST;
  if (!Number.isFinite(st.aimVel)) st.aimVel=0;
  if (!Number.isFinite(st.aimTgt)) st.aimTgt=st.aimDisp;
  let want=Number.isFinite(wantAimDeg)?wantAimDeg:AIM_REST;
  want=cl(want - (Number.isFinite(bankDeg)?cl(bankDeg,-6,6):0), AIM_MIN, AIM_MAX);
  // rate-limit the target itself
  const step=AIM_MAX_RATE*dt, dT=want-st.aimTgt;
  st.aimTgt=Math.abs(dT)>step ? st.aimTgt+Math.sign(dT)*step : want;
  // critically damped (ζ=1) spring toward target; linear degrees, so diff is already shortest-path
  const e=st.aimTgt-st.aimDisp;
  st.aimVel+= (AIM_W*AIM_W*e - 2*AIM_W*st.aimVel)*dt;
  st.aimVel=cl(st.aimVel,-AIM_MAX_RATE,AIM_MAX_RATE);
  st.aimDisp=cl(st.aimDisp+st.aimVel*dt, AIM_MIN, AIM_MAX);   // |Δ| ≤ AIM_MAX_RATE·dt (rate cap, not a per-frame cap)
  if ((st.aimDisp===AIM_MIN&&st.aimVel<0)||(st.aimDisp===AIM_MAX&&st.aimVel>0)) st.aimVel=0;
  return st.aimDisp;
}
/*HEADING-END*/
/*CAMERA-BEGIN*/
/* Camera (pure; unit-tested by web/scripts/test-camera.mjs). Critically damped spring (ω=CAM_W) on the
   camera's pixel position, with acceleration capped at CAM_AMAX and speed at CAM_VMAX, substepped.
   Position is continuous, velocity is continuous, and |Δ| per 1/60 s ≤ CAM_VMAX/60 px whatever the input
   (price gaps, replay restarts, tab resume, sim impulses). A huge gap is tracked at capped speed while
   the rocket rides the soft edge of the safe band (rocketScreenY). */
const CAM_W=1.6, CAM_VMAX=1500, CAM_AMAX=6000, CAM_SUB=1/120;
function stepCamera(st, targetPx, dt){
  const cl=(v,a,b)=>v<a?a:v>b?b:v;
  if (!Number.isFinite(st.camPx)) st.camPx=Number.isFinite(targetPx)?targetPx:0;
  if (!Number.isFinite(st.camV)) st.camV=0;
  if (!Number.isFinite(targetPx) || !(dt>0)) return st.camPx;
  const n=Math.max(1,Math.ceil(dt/CAM_SUB-1e-6)), h=dt/n;
  for (let i=0;i<n;i++){
    const e=targetPx-st.camPx;
    // stopping-distance guard: never ask for more speed than can be braked to zero at CAM_AMAX
    const vStop=Math.sign(e)*Math.sqrt(2*CAM_AMAX*Math.abs(e)*0.9);
    let a=CAM_W*CAM_W*e-2*CAM_W*st.camV;
    if (Math.abs(st.camV)>Math.abs(vStop) && Math.sign(st.camV)===Math.sign(e)) a=(vStop-st.camV)/h;
    a=cl(a,-CAM_AMAX,CAM_AMAX);
    st.camV=cl(st.camV+a*h,-CAM_VMAX,CAM_VMAX);
    st.camPx+=st.camV*h;
  }
  return st.camPx;
}
function rocketScreenY(anchor, offPx, Hh){ const up=Hh*0.20, dn=Hh*0.22; const o=Number.isFinite(offPx)?offPx:0;
  return anchor - (o>0? up*Math.tanh(o/up) : dn*Math.tanh(o/dn)); }
/*CAMERA-END*/
/* =====================================================================
   UPDATE LOOP — render at rAF, state only from confirmed events
   ===================================================================== */
let last=performance.now();
const FIXED_DT=+Q.get('fixedDt')>0?1/+Q.get('fixedDt'):0, CAPTURE=Q.get('capture')==='1';   // ?fixedDt=30 deterministic step; ?capture=1 = manual __flight.step(n)
let _rafOn=false;
const RAF=f=>{ if(CAPTURE) return; if(document.hidden){ _rafOn=false; return; } _rafOn=true; requestAnimationFrame(f); };   // hidden tab: loop stops
document.addEventListener('visibilitychange',()=>{ if(!document.hidden && !_rafOn && !CAPTURE){ last=performance.now(); acc=0; _rafOn=true; requestAnimationFrame(frame); } });
/* Fixed-timestep simulation (60 Hz) decoupled from rendering. Each rAF accumulates real time, runs
   0..MAX_STEPS sim steps, then renders with visual state interpolated between the last two sim states
   (alpha = leftover/SIM_DT), so motion is identical at 30/60/120/144 Hz displays. */
const SIM_DT=1/60, MAX_STEPS=5; let acc=0;
const LERP_KEYS=['displayAlt','camAlt','camPx','camX','x','aimDisp','bob','sway','microRot','heading','bank','cloudY','bgScrollX','vxS','wob','ry','anch','fwd','vyS'];
const PREV={}, CUR={};
/* frame-time stats (both render modes): long = >25 ms (missed a 60 Hz vsync), >50 ms = visible hitch */
const PERF=window.__flightPerf={n:0,long25:0,long50:0,max:0,sum:0,reset(){ this.n=this.long25=this.long50=this.max=this.sum=0; }};
function frame(now){
  { const d=now-last; if(d>0&&d<5000){ PERF.n++; PERF.sum+=d; if(d>25) PERF.long25++; if(d>50) PERF.long50++; if(d>PERF.max) PERF.max=d; } }
  const rawDt=FIXED_DT||Math.min(0.25,Math.max(0,(now-last)/1000)); last=now;
  if (S.confirmed.mcap===null || loaded<names.length){ S.t+=rawDt; drawLoading(); RAF(frame); return; }
  acc+=rawDt; let n=0;
  while (acc>=SIM_DT-1e-9 && n<MAX_STEPS){ for(const k of LERP_KEYS) PREV[k]=S[k]; S.particles.snap(); S.shards.snap(); S.bfx.snap(); simStep(SIM_DT); acc-=SIM_DT; n++; }
  if (n===MAX_STEPS && acc>SIM_DT) acc=0;             // long stall: drop the backlog instead of spiralling
  const alpha=n?clamp(acc/SIM_DT,0,1):1;
  for (const k of LERP_KEYS){ const a=PREV[k], b=S[k]; CUR[k]=b; if(typeof a==='number'&&typeof b==='number') S[k]=a+(b-a)*alpha; }
  const lp=alpha<0.999; if(lp){ S.particles.lerpIn(alpha); S.shards.lerpIn(alpha); S.bfx.lerpIn(alpha); }
  render(rawDt); governor(rawDt);
  if(lp){ S.particles.lerpOut(); S.shards.lerpOut(); S.bfx.lerpOut(); }
  for (const k of LERP_KEYS) S[k]=CUR[k];
  RAF(frame);
}
function simStep(stepDt){
  // ATOM slow-mo: eased time scale (uniform dt scaling keeps every spring smooth)
  const tsT=S.t<S.slowmoUntil?SLOWMO_SCALE:1; S.timeScale=lerp(S.timeScale,tsT,1-Math.exp(-stepDt*(tsT<1?30:5)));
  const dt=stepDt*S.timeScale; S.t+=dt;
  if (DEBUG_BOMB && !S._dbgFired && S.t>=DEBUG_BOMB_AT){ S._dbgFired=true; runDebugBomb(); }
  ammoTierStep(); pushMark();
  /* SPRING — altitude tracks price. ω≈22 rad/s, ζ≈0.72 → ~150 ms rise with a little overshoot.
     Tunables: SPRING_W (stiffness), SPRING_Z (damping; <1 overshoots). */
  const SPRING_W=10, SPRING_Z=1.0;   // critically damped (~0.35 s): no overshoot bounce, no screen snap
  simMarketStep(dt);
  const target=mcapToAlt(S.confirmed.mcap*S.simF);   // simF: visual-only simulated-market offset (1 when off)
  const altErr=target-S.displayAlt;
  S.altVel=(S.altVel||0)+ (SPRING_W*SPRING_W*altErr - 2*SPRING_Z*SPRING_W*(S.altVel||0))*dt;
  S.displayAlt+=(S.altVel||0)*dt;
  if (Math.abs(altErr)<2e-5 && Math.abs(S.altVel)<2e-4){ S.displayAlt=target; S.altVel=0; }
  // volume EMAs decay (τ≈6s) → exhaust intensity
  const dec=Math.exp(-dt/6); S.volEma*=dec; S.buyEma*=dec; S.sellEma*=dec;
  // lateral steering — cosmetic only. Laggy follow so A/D banks instead of teleporting.
  const steer=S.t<S.slowUntil?3:7;           // VOID orb penalty: sluggish steering
  const nx=lerp(S.x,LANES[S.lane],1-Math.exp(-dt*steer)); S.vx=(nx-S.x)/Math.max(dt,1e-3); S.x=nx;
  const bankTarget=clamp(-S.vx/900,-0.38,0.38);
  S.bank=lerp(S.bank||0,bankTarget,1-Math.exp(-dt*6));
  // price velocity in px/s (unsmoothed, for clouds / speed lines) then a short visual smoother
  const vUpRaw=(S.displayAlt-(S.prevAlt??S.displayAlt))/Math.max(dt,1e-3)*PX_PER_ALT; S.prevAlt=S.displayAlt;
  S.vUp=vUpRaw;
  // smoothed vertical velocity (px/s, +up) — drives attitude, sputter, speed lines (τ≈0.18 s)
  S.vyS=lerp(S.vyS||0, clamp(vUpRaw,-4000,4000), 1-Math.exp(-dt/0.18));
  /* FORWARD SPEED from volume + momentum: rolling USD/s (volEma τ6 s) normalised by the tier's FLARE
     preset, plus |buy−sell| imbalance. Second-order smoothed (ω=1.4) so it never jumps.
     Quiet ≈ 60 px/s drift, heavy flow → ~520 px/s blast. */
  { const ref=Math.max(MIN_SHOT,MODES[2].usd), x=(MOM.vol/TF.sec)/ref + Math.abs(MOM.buy-MOM.sell)/TF.sec/ref*0.6;   // candle-window volume
    const tgt=60+460*(1-Math.exp(-x*0.8)), w=1.4; S.fwdV=(S.fwdV||0)+(w*w*(tgt-(S.fwd||60))-2*w*(S.fwdV||0))*dt; S.fwd=(S.fwd||60)+S.fwdV*dt;
    S.fwdN=clamp((S.fwd-60)/460,0,1); }
  S.vxS=lerp(S.vxS||0,S.vx*0.55,1-Math.exp(-dt*8));
  // Flush coalesced thrusts once per frame (many swaps → one net size-based angle).
  flushThrustQueue();
  // ATTITUDE — heading follows the velocity vector inside the upright band (see aimFromMotion).
  const sinceThrust=S.t-(S.thrustT||-99);
  S.cruise=0;                                       // legacy sideways-cruise mode retired (rocket stays upright)
  momentumStep(dt);
  if (sinceThrust>1.2) S.aimDeg=0;
  const bankDeg=(S.bank||0)*(180/Math.PI)*0.5;
  stepHeading(S, aimFromMotion(S.momV, S.fwdN, S.fight, 140/Math.sqrt(TF.sec)), bankDeg, dt);
  S.heading=Math.PI/2 - S.aimDisp*Math.PI/180; S.tilt=S.heading;
  // CAMERA — critically damped spring in pixel space, then hard caps on speed and acceleration.
  // It lags the rocket on purpose, so the ROCKET visibly rises / drops on screen, then the view follows.
  if (S.camAlt==null) S.camAlt=S.displayAlt;
  if (S.camX==null) S.camX=S.x;
  stepCamera(S, S.displayAlt*PX_PER_ALT, dt);
  S.camAlt=S.camPx/PX_PER_ALT;
  { const e=S.x-S.camX, w=8; S.camXV=(S.camXV||0)+(w*w*e-2*w*(S.camXV||0))*dt; S.camX+=S.camXV*dt; }
  // screen anchor eases on resize (no jump when the window / sidebar changes)
  S.anch=S.anch==null?ROCKET_Y:lerp(S.anch,ROCKET_Y,1-Math.exp(-dt*5));
  // rocket screen y: true altitude vs camera, soft-limited to the safe band (tanh, never a hard stop)
  S.ry=rocketScreenY(S.anch,(S.displayAlt-S.camAlt)*PX_PER_ALT,H);
  // idle bob / sway / micro-rot — attenuated during thrust so they don't fight heading
  const thrustHold=sinceThrust<1.2? clamp(1-sinceThrust/1.2,0,1) : 0;
  const amp=(1+(Math.abs(vUpRaw)/500))*(1-0.7*thrustHold);
  S.bob=(Math.sin(S.t*1.7)*3.2*amp + Math.sin(S.t*3.1+1.2)*1.4)*(1-0.55*thrustHold);
  S.sway=(Math.sin(S.t*1.15+0.4)*4.5 + Math.sin(S.t*2.4)*1.6)*(1-0.55*thrustHold) + (S.bank||0)*-12;
  S.microRot=(Math.sin(S.t*1.35)*0.012 + Math.sin(S.t*2.8+0.7)*0.006)*(1-0.8*thrustHold) + (S.bank||0)*0.05;
  S.roll=1; // kept for compat; draw path no longer scaleX-wobbles
  S.glint=Math.sin(S.t*1.8);
  // parallax scroll: clouds/bg move with price velocity; sideways adds horizontal drift
  // parallax: vertical is tied to the camera POSITION (not raw price velocity), horizontal to forward speed
  S.cloudY=S.camPx;
  S.bgScrollX=(S.bgScrollX||0)+S.fwd*dt;
  // speed streaks on strong moves
  // speed lines: rate and length scale with total speed; they flow opposite the rocket's motion
  { const sp=Math.hypot(S.fwd,S.vyS); if (sp>140 && Math.random()<dt*Math.min(30,(sp-140)/18)){
    S.speedBits.push({x:Math.random()*(W+200),y:Math.random()*H,len:0,w:0.8+Math.random()*1.4,life:0.5,up:S.vyS>0,k:0.6+Math.random()*0.8}); } }
  for (const b of S.speedBits){ b.life-=dt*1.6; b.x-=S.fwd*dt*1.6*b.k; b.y+=S.vyS*dt*1.2*b.k; }
  keepIf(S.speedBits,ALIVE); if(S.speedBits.length>40){ S.speedBits.copyWithin(0,S.speedBits.length-40); S.speedBits.length=40; }
  // trailing tick polyline: tip at nozzle, scrolls left. Flat crawl + angled thrust segments.
  // Use stable S.x (no sway) so flat segments stay steady frame-to-frame.
  const tipX=S.x;
  const scroll=S.fwd*0.9*dt; // trail scrolls with forward speed (volume)
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
  keepIf(S.trail,TRAIL_ON);
  if(S.t>S.multUntil) S.mult=1;
  for (const f of S.floaters){ f.y-=40*dt; f.life-=dt*0.9; } keepIf(S.floaters,ALIVE);
  // tier change banner
  const ti=clamp(Math.floor(target),0,TIERS.length-1); if (ti!==S.tierShown){ if(S.tierShown>=0){ S.tierBanner=2.2; award('tier'+ti,'TIER WITNESS','crossed into '+TIERS[ti].name); } S.tierShown=ti; }
  S.tierBanner=Math.max(0,S.tierBanner-dt);
  // particles
  { const P=S.particles; for (let i=P.n-1;i>=0;i--){ const p=P.a[i]; p.x+=p.vx*dt; p.y+=p.vy*dt; p.life-=dt*2.2; if(p.life<=0) P.kill(i); } }
  { const P=S.shards; for (let i=P.n-1;i>=0;i--){ const s=P.a[i]; s.x+=s.vx*dt; s.y+=s.vy*dt; s.vy+=500*dt; s.life-=dt*0.9; if(s.life<=0||s.y>H+20) P.kill(i); } }
  for (const f of S.flashes) f.life-=dt*0.8; keepIf(S.flashes,ALIVE);
  // motes drift down (speed ∝ trade flow), collect by steering
  const flow=1+Math.log10(1+S.buyEma)*0.5;
  // OFF-CHAIN ORB LAYER: reward spawn ∝ buy flow, penalty spawn ∝ sell flow (server-seeded in prod)
  const lane=randLane;
  const P=ORB_SPAWN, room=S.orbsOn&&S.motes.length+S.obstacles.length<P.maxOnScreen&&S.t-S.lastOrbT>=P.minGap;
  if (room&&Math.random()<dt*Math.min(P.rewardMax,P.rewardBase+P.rewardFlow*Math.log10(1+S.buyEma))){ const r=Math.random(); S.motes.push({k:r<0.85?'halo':'mult',x:lane(),y:-20,v:90+Math.random()*40}); S.lastOrbT=S.t; }
  else if (room&&Math.random()<dt*Math.min(P.penaltyMax,P.penaltyBase+P.penaltyFlow*Math.log10(1+S.sellEma))){ S.obstacles.push({k:Math.random()<0.7?'storm':'void',x:lane(),y:-40,v:100}); S.lastOrbT=S.t; }
  for (const m of S.motes){ m.y+=m.v*dt*flow; if (Math.abs(m.x-S.x)<50&&Math.abs(m.y-S.ry)<40){ m.dead=true; const T=ORB[m.k];
      if (m.k==='mult'){ S.mult=2; S.multUntil=S.t+10; }
      const pts=T.pts*S.mult*(1+Math.floor(S.streak/10)); S.score+=pts; S.streak++; S.collected++;
      S.floaters.push({x:m.x,y:m.y-20,txt:m.k==='mult'?'×2 POINTS 10s':'+'+pts,c:T.rim||'#ffe7a3',life:1.2});
      if(S.streak===10) award('streak10','PERFECT LANE ×10','10 reward orbs in a row'); if(S.collected===25) award('c25','HALO HOARDER','25 reward orbs collected'); } }
  for (const o of S.obstacles){ o.y+=o.v*dt*flow; if (!o.hit&&Math.abs(o.x-S.x)<50&&Math.abs(o.y-S.ry)<40){ o.hit=true; o.dead=true; const T=ORB[o.k];
      const loss=Math.min(S.score,T.pts); S.score-=loss; S.streak=0; if(o.k==='void') S.slowUntil=S.t+3;
      S.floaters.push({x:o.x,y:o.y-20,txt:'−'+loss+(o.k==='void'?' · SLOWED 3s':' · streak lost'),c:'#ff5a6a',life:1.4});
      S.flashes.push({txt:o.k==='void'?'VOID ORB · steering slowed':'STORM ORB · −'+loss+' pts',life:1.2,c:'#ff7a85'});
      for(let i=0;i<30;i++) spawnShard(o.x,o.y,(Math.random()-.5)*320,(Math.random()-.5)*320,'#ff3344'); } }
  keepIf(S.motes,NOT_DEAD_MOTE); keepIf(S.obstacles,NOT_DEAD_OBS);
  bombStep(dt);
  for (const t of S.toasts) t.life-=dt*0.6; keepIf(S.toasts,ALIVE);
  if (!S.ach.koth){ let top=null, tv=-Infinity; for (const k in S.fuelers) if(S.fuelers[k]>tv){ tv=S.fuelers[k]; top=k; } if(top==='you') award('koth','KING OF THE HILL','top fueler on this coin'); }
  cloudStep(dt); shockStep(dt);
  twStep(); exhaustStep(dt);
}
function render(dt){
  ctx.save();   // camera is stable: no shake of any kind
  drawBg(); drawClouds(); drawSpeedLines(); drawLevels(); drawEntryLine(); drawTrampWalls(); drawTickTrail(); drawFx(dt); drawBombs(); drawRocket(dt); drawClouds(true); ctx.restore(); drawPost(); drawBombScreen(); drawHud();
  if (window.__flightLog){ const h=S.heading, prev=window.__flightLogPrevH; const dh=prev==null?0:Math.atan2(Math.sin(h-prev),Math.cos(h-prev)); window.__flightLogPrevH=h;
    window.__flightLog.push({t:S.t,dt,heading:h,headingDeg:h*180/Math.PI,dHeadingDeg:dh*180/Math.PI,aimDeg:S.aimDeg||0,aimDisp:S.aimDisp,drawAimDeg:90-rocketDrawAngle()*180/Math.PI,x:S.x,camX:S.camX,bob:S.bob||0,sway:S.sway||0,displayAlt:S.displayAlt,camAlt:S.camAlt,altVel:S.altVel||0,cruise:S.cruise||0}); }
}
RAF(frame);
if (Q.get('launched')==='1'){ const f=document.getElementById('launchFade'); f.style.transition='none'; f.style.opacity=1; S.altVel=-0.25; requestAnimationFrame(()=>requestAnimationFrame(()=>{ f.style.transition='opacity .9s ease'; f.style.opacity=0; })); }
const DEBUG_BOMB=Q.get('debugBomb'), DEBUG_BOMB_AT=+(Q.get('debugBombAt')||1.2);
function runDebugBomb(){ if(DEBUG_BOMB==='cycle'){ ['puff','grenade','bunker','cruise','nuke','atom'].forEach((k,i)=>setTimeoutSim(()=>debugBomb(k),i*2.4)); } else debugBomb(isNaN(+DEBUG_BOMB)?DEBUG_BOMB:+DEBUG_BOMB,{fullStack:Q.get('fullStack')==='1'}); }
const simTimers=[]; function setTimeoutSim(fn,d){ simTimers.push({at:S.t+d,fn}); }
window.__flightMom=()=>({sec:TF.sec,pct:MOM.pct,press:MOM.press,buy:MOM.buy,sell:MOM.sell});
window.__flight={bomb:(k,o)=>debugBomb(k,o),estimateImpactPct,BOMB_PCT,BOMB_TIERS,setBombs,setShake,step:n=>{ for(let i=0;i<(n||1);i++) frame(last+1000*SIM_DT); },ORB_SPAWN,setOrbs,MODES,MIN_SHOT,GAS_USD,ORB,trade,autoMode,S,source,mcapToAlt,altToMcap,bandOf,plateOf,screenYToMcap,TIERS,CLOUDS,climbAngleDeg,applyThrust,queueThrust,flushThrustQueue};   // for tests / console

})();
