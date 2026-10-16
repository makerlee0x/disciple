// Trail-vs-rocket test. Per frame: head = drawn trail head, noz = rocket nozzle (drawRocket's pivot),
// lead = how far the newest stored trail point sits ABOVE the nozzle (px, + = trail above rocket).
// Usage: BASE_URL=http://localhost:3000 npm run test:trail   (needs a running dev server + playwright)
const { chromium } = await import('playwright').catch(()=>{ console.error('test:trail needs playwright (npx playwright install chromium)'); process.exit(2); });
const TAG=process.env.TAG||'run', D=process.env.SHOT_DIR?process.env.SHOT_DIR.replace(/\/?$/,'/'):null;
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1280,height:800}});
p.on('pageerror',e=>console.log('ERR',e.message));
await p.goto((process.env.BASE_URL||'http://localhost:3000')+'/coin/0x0000000000000000000000000000000000000001?source=mock&render=main&mcap=20000',{timeout:180000});
await p.waitForFunction(()=>window.__flight&&window.__flight.S&&window.__flight.S.displayAlt!=null,null,{timeout:180000});
await p.evaluate(()=>{ dispatchEvent(new CustomEvent('disciple:sim',{detail:{mode:'off'}})); window.__flight.setBombs(false);
  const F=window.__flight,S=F.S, PX=F.PX_PER_ALT||1.5*800*3, R=window.__tr={phase:'warm',m:{}};
  const proj=pt=> pt.y!=null&&pt.alt==null ? pt.y : (S.anch - (pt.alt - S.camAlt)*PX);
  const f=()=>{ const nz=[(S.camX??S.x)+(S.sway||0)*0.45, S.ry+(S.bob||0)*0.55];
    const hd=F.trailHead?F.trailHead():[(S.camX??S.x)+(S.sway||0)*0.35, S.ry+(S.bob||0)*0.5];
    const last=S.trail[S.trail.length-1]; const ly=last?proj(last):nz[1];
    const r=R.m[R.phase]||(R.m[R.phase]={head:0,lead:0,n:0}); r.n++;
    r.head=Math.max(r.head,Math.hypot(hd[0]-nz[0],hd[1]-nz[1])); r.lead=Math.max(r.lead, nz[1]-ly);
    r.emit=Math.max(r.emit||0, S._trailEmitErr||0); requestAnimationFrame(f); }; requestAnimationFrame(f); });
await p.waitForTimeout(2500);
const ramp=(k,ms)=>p.evaluate(([k,ms])=>new Promise(res=>{ const F=window.__flight; let m=F.S.confirmed.mcap; const iv=setInterval(()=>{ m*=k; F.setMcap?F.setMcap(m):(F.source.mcap=m, F.source.applyTrade(k>1?'buy':'sell',1,false)); },50); setTimeout(()=>{clearInterval(iv);res();},ms); }),[k,ms]);
for (const [ph,k] of [['climb',1.006],['dive',1/1.007]]){
  await p.evaluate(ph=>{window.__tr.phase=ph; window.__flight.S._trailEmitErr=0;},ph); await ramp(k,1800);
  if(D) await p.screenshot({path:`${D}r4-trail-${TAG}-${ph}.png`}); await ramp(k,1200); }
await p.evaluate(()=>{ window.__tr.phase='simburst'; window.__flight.S._trailEmitErr=0; dispatchEvent(new CustomEvent('disciple:sim',{detail:{mode:'on'}})); window.__flight.S.simT=1.3; });
await p.waitForTimeout(1500); if(D) await p.screenshot({path:`${D}r4-trail-${TAG}-simburst.png`}); await p.waitForTimeout(1500);
const m=await p.evaluate(()=>window.__tr.m); delete m.warm;
let ok=true; for (const [k,v] of Object.entries(m)){ const pass=v.head<2&&(v.emit||0)<2&&v.lead<2; ok=ok&&pass;
  console.log(`${TAG} ${k}: frames ${v.n}, head↔nozzle max ${v.head.toFixed(2)} px, newest point above nozzle max ${v.lead.toFixed(1)} px, emit err ${(v.emit||0).toFixed(2)} px ${pass?'PASS':'FAIL'}`); }
console.log(ok?'PASS':'FAIL'); await b.close(); process.exit(ok?0:1);
