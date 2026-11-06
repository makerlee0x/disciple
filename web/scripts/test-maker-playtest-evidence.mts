import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { diagnosticText, errorDiagnostic } from "../lib/aa/diagnostics";
import { createLoginSetup } from "../lib/aa/loginSetup";
import { scanEventHistory } from "../lib/claims/eventHistory";
const source = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("setup diagnostics retain the full multiline reason and public operation hash, not signing/auth data", async () => {
  const end = "FINAL_ERROR_REASON", hash = "0x" + "43".repeat(32);
  const detail = "full reason ".repeat(100) + "\n" + end + ' https://provider.invalid/credential Bearer hiddentoken privateKey="hiddenkey" signature="signedop"';
  const error = Object.assign(new Error("friendly player copy"), { code: "Timeout", extra: { detail, userOpHash: hash, key: "private-local-key", request: { signature: "signedop" } } });
  const info = errorDiagnostic(error), text = JSON.stringify(info);
  assert.ok(String(info.detail).includes(end));assert.equal(info.userOpHash,hash);
  for (const secret of ["provider.invalid", "credential", "hiddentoken", "hiddenkey", "signedop", "private-local-key"]) assert.ok(!text.includes(secret),secret);
  const logs: { message: string; data?: Record<string,unknown> }[] = [];
  const setup = createLoginSetup({ now: () => 1000, enabled: () => true, oneTapOff: () => false,
    deployed: async () => true, health: async () => "missing", install: async () => { throw error; },
    warn: (message,data) => logs.push({message,data}) });
  assert.equal(await setup.ensure("0xmaker","login"),"failed");assert.equal(setup.lastError("0xmaker"),"friendly player copy");assert.equal(setup.lastDetail("0xmaker"),info.detail);
  assert.ok(logs[0].message.includes(end));assert.equal(logs[0].data?.userOpHash,hash);
  assert.equal(diagnosticText('authorization="Bearer secret"'), 'authorization=[redacted]');
});

test("the observed 7,618,710-block history uses complete <=100k inclusive chunks with one fixed head", async () => {
  const from=142064001n, head=149682710n, ranges: bigint[][]=[];let heads=0;
  const rows = await scanEventHistory({getBlockNumber:async()=>{heads++;return head;}},async(lo,hi)=>{ranges.push([lo,hi]);return [lo,hi];},from);
  assert.equal(heads,1);assert.equal(ranges.length,77);assert.equal(rows.length,154);assert.equal(ranges[0][0],from);assert.equal(ranges.at(-1)![1],head);
  ranges.forEach(([lo,hi],i)=>{assert.ok(hi-lo+1n<=100000n);if(i)assert.equal(lo,ranges[i-1][1]+1n);});
  for (const count of [0n,1n,99999n,100000n,100001n,200000n]) {const seen:bigint[][]=[];await scanEventHistory({getBlockNumber:async()=>head},async(lo,hi)=>{seen.push([lo,hi]);return [];},5n,4n+count);assert.equal(seen.length,Number((count+99999n)/100000n));}
  await assert.rejects(scanEventHistory({getBlockNumber:async()=>200000n},async(lo)=>{if(lo>0n)throw Error("RPC unavailable");return [1];},0n),/RPC unavailable/);
});

test("all rewards history paths use the bounded helper, preserving typed filters",()=>{
  for(const name of ["rewardsData","creatorFees","crew"]){const s=source(`../lib/claims/${name}.ts`);assert.ok(s.includes("scanEventHistory"));assert.doesNotMatch(s,/getContractEvents\([^\n]*toBlock: "latest"/);}
});

test("a late resize after wrap removal is a no-op; a mounted wrapper still sizes the canvas",()=>{
  const eng=source("../public/flight/engine.js"),body=eng.slice(eng.indexOf("function resize(){"),eng.indexOf("function relayout("));
  const make=new Function("document",`let DPR_PIN=0,DPR_STEPS=[1,2],dprIx=1,devicePixelRatio=2,innerWidth=800,innerHeight=600,scale=1,W=0,H=0;const cv={style:{},width:0,height:0},ctx={setTransform(){}};function relayout(w,h){W=w;H=h;} ${body};return {resize,cv};`);
  const missing=make({getElementById:()=>null});assert.doesNotThrow(()=>missing.resize());assert.equal(missing.cv.width,0);
  const live=make({getElementById:()=>({clientWidth:900,clientHeight:700})});live.resize();assert.equal(live.cv.width,1800);assert.equal(live.cv.height,1400);
});

test("paymaster and bundler outcome logging selects reasons/ids, never raw requests or signed operations",()=>{
  const pm=source("../app/api/paymaster/route.ts"),b=source("../app/api/bundler/route.ts");
  assert.match(pm,/logQuoteRejection\("pm_getPaymasterAllowance"/);assert.match(pm,/reason: error.code/);
  assert.match(b,/\[disciple\] bundler send result/);assert.match(b,/diagnosticText\(answer.error\?\.message/);
  assert.doesNotMatch(pm+b,/console\.(?:info|warn|error)\([^\n]*(?:JSON.stringify\(body\)|console.*paymasterData)/);
});
