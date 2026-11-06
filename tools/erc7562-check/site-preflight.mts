// No RPC, no state changes. Verify literal client helper treatment of exact funding legs.
import {writeFileSync} from 'node:fs';
import {parseAbi,encodeFunctionData} from 'viem';
import {setupCreditCalls,withAutoTopUp} from './site/web/lib/aa/prepayBootstrap';
import {withPaymasterApprove} from './site/web/lib/aa/paymasterClient';
import {classifyCreditCalldata} from './site/web/lib/aa/paymaster';
const usdg='0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D';
const paymaster='0x1111111111111111111111111111111111111111';
const sender='0x2222222222222222222222222222222222222222';
const router='0x688160633b22012717661545df6299d3d3174ad2';
const abi=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[])']);
const batch=(cs:any[])=>encodeFunctionData({abi,functionName:'executeBatch',args:[cs.map(c=>({target:c.to,value:c.value||0n,data:c.data}))]});
const funding=setupCreditCalls(usdg,paymaster,sender);
const fakeBuy={to:router,value:0n,data:'0x12345678'} as const;
const topped=withAutoTopUp([fakeBuy],{usdg,paymaster,account:sender,available:1_000_000n,wallet:10_000_000n});
const results=[['setup',funding],['topup',topped]].map(([name,calls]:any)=>{
 const after=withPaymasterApprove(calls,usdg,paymaster,1n);
 return {name,before:classifyCreditCalldata(batch(calls),sender,usdg,paymaster),after:classifyCreditCalldata(batch(after),sender,usdg,paymaster),beforeCount:calls.length,afterCount:after.length,removedApprove:after.length!==calls.length};
});
const out={scope:'Pure client call-shaping preflight, not ERC-7562 trace',results};
console.log(JSON.stringify(out,(_,v)=>typeof v==="bigint"?v.toString():v,2));
writeFileSync(new URL('./site-preflight.json',import.meta.url),JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2));
