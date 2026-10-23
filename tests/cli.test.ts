import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm,stat,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture} from './helpers.js';

const execute=promisify(execFile);
const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
const tsx=fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs',import.meta.url));
async function directory(t:test.TestContext){const path=await mkdtemp(join(tmpdir(),'microlink-cli-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function run(cwd:string,args:string[],env:NodeJS.ProcessEnv={}){
  try {
    const result=await execute(process.execPath,[tsx,cli,...args],{cwd,env:{...process.env,MICROLINK_API_KEY:'',ALTENAR_AUTHORIZATION:'',...env},timeout:10000});
    return {...result,code:0};
  }catch(error){const e=error as Error & {stdout:string;stderr:string;code:number};return {stdout:e.stdout,stderr:e.stderr,code:e.code};}
}
test('CLI compare loads .env, saves private redacted artifacts and reports equal JSON',async t=>{
  const f=await fixture(t);
  const cwd=await directory(t);
  await writeFile(join(cwd,'.env'),`TOKEN=opaque-target-token\nMICROLINK_ENDPOINT=${f.endpoint}\n`);
  await writeFile(join(cwd,'get.json'),JSON.stringify({url:f.target,method:'GET',headers:{authorization:'${TOKEN}'}}));
  const result=await run(cwd,['compare','--profile','get.json'],{MICROLINK_API_KEY:'service-test-key'});
  assert.equal(result.code,0,result.stderr);
  const output=JSON.parse(result.stdout);
  assert.equal(output.comparison.accessWorks,true);
  assert.equal(output.comparison.jsonEqual,true);
  assert.equal(result.stdout.includes('opaque-target-token'),false);
  assert.equal(result.stdout.includes('service-test-key'),false);
  assert.equal(f.serviceCalls.length,1);
  assert.equal(f.targetCalls.length,2);
  assert.equal((await stat(output.capture)).mode & 0o777,0o600);
  assert.equal((await readFile(output.capture,'utf8')).includes('opaque-target-token'),false);
  assert.equal((await readFile(join(output.replayDirectory,'local.json'),'utf8')).includes('opaque-target-token'),false);
});
test('CLI POST capture can be replayed in a separate process without Microlink credentials',async t=>{
  const f=await fixture(t);
  const cwd=await directory(t);
  await writeFile(join(cwd,'post.json'),JSON.stringify({url:f.target,method:'POST',headers:{authorization:'${TOKEN}','content-type':'application/json'},body:{price:1.07}}));
  const first=await run(cwd,['capture','--profile','post.json'],{TOKEN:'opaque-target-token',MICROLINK_API_KEY:'service-test-key',MICROLINK_ENDPOINT:f.endpoint});
  assert.equal(first.code,0,first.stderr);
  const path=JSON.parse(first.stdout).capture;
  const second=await run(cwd,['replay','--capture',path],{TOKEN:'opaque-target-token',MICROLINK_ENDPOINT:'http://127.0.0.1:1/'});
  assert.equal(second.code,0,second.stderr);
  assert.equal(JSON.parse(second.stdout).comparison.jsonEqual,true);
  assert.equal(f.serviceCalls.length,1);
  assert.deepEqual(f.targetCalls.map(call=>call.body),['{"price":1.07}','{"price":1.07}']);
});
test('CLI help sends no requests',async t=>{
  const f=await fixture(t);
  const cwd=await directory(t);
  const result=await run(cwd,['--help'],{MICROLINK_ENDPOINT:f.endpoint});
  assert.equal(result.code,0);
  assert.match(result.stdout,/capture/);
  assert.equal(f.serviceCalls.length,0);
});
test('CLI missing service key fails before touching the network',async t=>{
  const f=await fixture(t);
  const cwd=await directory(t);
  await writeFile(join(cwd,'get.json'),JSON.stringify({url:f.target,method:'GET',headers:{referer:'https://divinoplay.com/'}}));
  const result=await run(cwd,['compare','--profile','get.json'],{MICROLINK_ENDPOINT:f.endpoint});
  assert.equal(result.code,1);
  assert.match(result.stderr,/MICROLINK_API_KEY/);
  assert.equal(f.serviceCalls.length,0);
});
test('CLI service failure is captured and never triggers local replay',async t=>{
  const f=await fixture(t,{status:'fail',code:'EPROXYNEEDED',message:'Upstream blocked'},403);
  const cwd=await directory(t);
  await writeFile(join(cwd,'get.json'),JSON.stringify({url:f.target,method:'GET'}));
  const result=await run(cwd,['compare','--profile','get.json'],{MICROLINK_ENDPOINT:f.endpoint});
  assert.equal(result.code,1,result.stderr);
  const output=JSON.parse(result.stdout);
  assert.equal(output.replayable,false);
  assert.equal(output.error.code,'EPROXYNEEDED');
  assert.equal(f.serviceCalls.length,1);
  assert.equal(f.targetCalls.length,0);
});

test('CLI replay redacts credentials referenced only by persisted body bindings',async t=>{
  const f=await fixture(t);
  const cwd=await directory(t);
  const secret='ordinary-body-credential';
  await writeFile(join(cwd,'post.json'),JSON.stringify({url:f.target,method:'POST',headers:{authorization:'${CREDENTIAL_VALUE}','content-type':'application/json'},body:{value:secret}}));
  const first=await run(cwd,['capture','--profile','post.json'],{CREDENTIAL_VALUE:secret,MICROLINK_API_KEY:'service-test-key',MICROLINK_ENDPOINT:f.endpoint});
  assert.equal(first.code,0,first.stderr);
  const path=JSON.parse(first.stdout).capture;
  const snapshot=JSON.parse(await readFile(path,'utf8'));
  delete snapshot.request.headers.authorization;
  await writeFile(path,JSON.stringify(snapshot));
  const second=await run(cwd,['replay','--capture',path],{CREDENTIAL_VALUE:secret,MICROLINK_ENDPOINT:'http://127.0.0.1:1/'});
  assert.equal(second.code,0,second.stderr);
  const output=JSON.parse(second.stdout);
  assert.equal((await readFile(join(output.replayDirectory,'local.json'),'utf8')).includes(secret),false);
  assert.equal(f.targetCalls[1]!.body,'{"value":"ordinary-body-credential"}');
  assert.equal(f.serviceCalls.length,1);
});

test('CLI credential masking does not turn different JSON tokens into equal responses',async t=>{
  const {serve}=await import('./helpers.js');
  const target=await serve(t,(_req,res)=>{res.setHeader('content-type','application/json');res.end('{"token":"local-only-token"}');});
  const endpoint=await serve(t,(_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'success',data:{statusCode:200,headers:{'content-type':'application/json'},content:{token:'remote-only-token'},function:{isFulfilled:true,value:{headers:{}},profiling:{},logging:{}}}}));});
  const cwd=await directory(t);
  await writeFile(join(cwd,'get.json'),JSON.stringify({url:target,method:'GET'}));
  const result=await run(cwd,['compare','--profile','get.json'],{MICROLINK_ENDPOINT:endpoint});
  assert.equal(result.code,0,result.stderr);
  const output=JSON.parse(result.stdout);
  assert.equal(output.comparison.accessWorks,true);
  assert.equal(output.comparison.jsonEqual,false);
  assert.equal(result.stdout.includes('local-only-token'),false);
  assert.equal(result.stdout.includes('remote-only-token'),false);
});

test('CLI defaults to the headerless get-free profile',async t=>{
  const f=await fixture(t);
  const cwd=await directory(t);
  await mkdir(join(cwd,'profiles'));
  await writeFile(join(cwd,'profiles','get-free.json'),JSON.stringify({url:f.target,method:'GET',headers:{}}));
  const result=await run(cwd,['compare'],{MICROLINK_ENDPOINT:f.endpoint});
  assert.equal(result.code,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).comparison.accessWorks,true);
  assert.equal(f.serviceCalls.length,1);
  assert.equal(f.targetCalls.length,2);
});
