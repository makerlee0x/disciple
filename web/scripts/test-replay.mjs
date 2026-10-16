// Replay determinism: same inputs + seed ⇒ identical frame hashes over 2 runs; live engine untouched.
// Usage: BASE_URL=http://localhost:3000 npm run test:replay   (needs a running server + playwright)
const { chromium } = await import('playwright').catch(()=>{ console.error('test:replay needs playwright (npx playwright install chromium)'); process.exit(2); });
const BASE=process.env.BASE_URL||'http://localhost:3000', SHOTS=process.env.SHOTS||'';
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:900,height:900}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto(BASE+'/dev/replay',{timeout:180000}); await p.waitForFunction(()=>window.__replayDemo,null,{timeout:180000});
const res=await p.evaluate(async(shots)=>{
  const D=window.__replayDemo, fn=await D.loadReplay(), out=[], pngs={};
  for(let run=0;run<2;run++){
    const r=await fn({...D.opts(), durationSec:6, fps:30, width:540, height:960, seed:42}); const hs=[]; const ev={trade:0,bomb:0,tier:0};
    r.on('trade',()=>ev.trade++); r.on('bomb',()=>ev.bomb++); r.on('tier',()=>ev.tier++);
    for(let f;(f=r.step());){ hs.push(r.hash()); if(shots&&run===0&&[30,90,150,179].includes(f.i)) pngs[f.i]=r.canvas.toDataURL('image/png'); }
    out.push({hs,ev,frames:r.frames,mid:r.stateAt(3)}); r.dispose(); }
  const other=await fn({...D.opts(), durationSec:6, fps:30, width:540, height:960, seed:43}); for(let i=0;i<60;i++) other.step();
  return {a:out[0],b:out[1],seedDiff:other.hash()!==out[0].hs[59],live:typeof window.__flight, pngs};
},!!SHOTS);
await b.close();
const same=res.a.hs.length===res.b.hs.length&&res.a.hs.every((h,i)=>h===res.b.hs[i]);
const uniq=new Set(res.a.hs).size;
console.log(`frames ${res.a.hs.length}/${res.a.frames} · unique ${uniq} · identical across runs: ${same} · different seed differs: ${res.seedDiff} · events ${JSON.stringify(res.a.ev)} · stateAt(3) ${JSON.stringify(res.a.mid)} · live __flight on page: ${res.live}`);
if(SHOTS){ const fs=await import('node:fs'); for(const [i,u] of Object.entries(res.pngs)) fs.writeFileSync(`${SHOTS}replay-f${String(i).padStart(3,'0')}.png`,Buffer.from(u.split(',')[1],'base64')); }
if(errs.length) console.log('page errors:',errs);
if(!same||uniq<10||errs.length){ console.log('FAIL'); process.exit(1); } console.log('PASS');
