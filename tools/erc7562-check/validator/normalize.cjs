// Lossless entity-aggregate adapter from reference BundlerCollectorTracer to ERC7562Call.
// Actual call edges, CREATE destinations, values and outputs are retained. Per-entity opcode /
// code-access information stays aggregated (as the reference JS tracer supplies it).
// Storage is keyed by actual storage address, avoiding delegatecall-code vs storage ambiguity.
const {EVMOpcodes}=require('./enum/EVMOpcodes.cjs');
const {utils}=require('ethers');
const blank=(c={})=>({accessedSlots:{reads:{},writes:{},transientReads:{},transientWrites:{}},contractSize:{},extCodeAccessInfo:[],gas:'0',gasUsed:'0',input:'0x',outOfGas:false,usedOpcodes:{},value:'0',calls:[],...c});
exports.normalize=(trace,ep)=>{
 const root=blank({from:'0x0000000000000000000000000000000000000000',to:ep.toLowerCase(),type:'CALL',keccak:trace.keccak});
 const stack=[root]; const all=[];
 for(const c of trace.calls||[]){
  if(c.type==='RETURN'||c.type==='REVERT'){
   if(stack.length>1){const n=stack.pop();n.output=c.data;n.error=c.type==='REVERT'?'execution reverted':undefined;n.gasUsed=String(c.gasUsed||0)}else if(c.type==='REVERT')root.error='execution reverted';
  }else if(c.to){const n=blank({from:c.from.toLowerCase(),to:c.to.toLowerCase(),type:c.type,input:c.method||'0x',value:String(c.value||0),gas:String(c.gas||0)});stack[stack.length-1].calls.push(n);stack.push(n);all.push(n)}
 }
 for(const level of trace.callsFromEntryPoint){
  const addr=level.topLevelTargetAddress.toLowerCase();
  const n=all.find(c=>c.to===addr);
  if(!n)throw new Error('Missing call frame for '+addr);
  n.usedOpcodes=Object.fromEntries(Object.entries(level.opcodes).filter(([op])=>EVMOpcodes[op]!==undefined).map(([op,count])=>[EVMOpcodes[op],count]));
  n.contractSize=Object.fromEntries(Object.entries(level.contractSize).map(([a,v])=>[a,{...v,opcode:EVMOpcodes[v.opcode]||0}]));
  n.extCodeAccessInfo=Object.keys(level.extCodeAccessInfo);n.outOfGas=!!level.oog;
  for(const [storageAddr,slots] of Object.entries(level.access)){
   if(storageAddr.toLowerCase()===addr){n.accessedSlots=slots;continue;}
   n.calls.unshift(blank({from:addr,to:storageAddr.toLowerCase(),type:'STATICCALL',accessedSlots:slots}));
  }
 }
 let context='0x';
 for(const n of all)if(n.input==='0x52b7512c' && n.output){try{[context]=utils.defaultAbiCoder.decode(['bytes','uint256'],n.output)}catch{}}
 return {root,context,senderCreator:root.calls.find(c=>c.input==='0x570e1a36')?.to || '0xefc2c1444ebcc4db75e7613d20c6a62ff67a167c'};
};
