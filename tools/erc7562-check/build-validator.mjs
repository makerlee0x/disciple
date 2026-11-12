import * as esbuild from 'esbuild';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const req=createRequire(import.meta.url);
await esbuild.build({entryPoints:['bundler/packages/validation-manager/src/BundlerCollectorTracer.ts','bundler/packages/validation-manager/src/TracerResultParser.ts','bundler/packages/validation-manager/src/ERC7562Parser.ts','bundler/packages/validation-manager/src/enum/EVMOpcodes.ts'],bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},outdir:'validator',outbase:'bundler/packages/validation-manager/src',alias:{'@account-abstraction/utils':resolve('validator/utils.cjs')},external:['ethers','ethers/lib/utils','debug'],plugins:[{name:'diagnostics-only',setup(build){build.onResolve({filter:/^\.\/decodeHelper$/},()=>({path:resolve('validator/diagnostics.cjs')}))}}]});
const {bundlerCollectorTracer}=req('./validator/BundlerCollectorTracer.cjs');
const body=bundlerCollectorTracer.toString().match(/function \w+\s*\(\s*\)\s*{\s*return\s*(\{[\s\S]+\});?\s*}\s*$/)[1];
writeFileSync('validator/tracer.js',body);
