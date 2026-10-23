import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureRequest,replayCapture} from '../src/transport.js';
import {saveCapture,readCapture} from '../src/artifacts.js';
import {fixture,profile,serve} from './helpers.js';

test('native GET makes one service call and replays observed target headers locally',async t=>{
  const f=await fixture(t);
  const loaded=profile(f.target,'GET',{authorization:'opaque-target-token',referer:'https://divinoplay.com/'});
  const capture=await captureRequest(loaded,{endpoint:f.endpoint,apiKey:'service-test-key'});
  assert.equal(capture.mode,'native-get');
  assert.equal(capture.replayable,true);
  assert.equal(f.serviceCalls.length,1);
  assert.equal(f.serviceCalls[0]!.query.get('retry'),'0');
  assert.equal(f.serviceCalls[0]!.query.get('force'),'true');
  assert.equal(f.serviceCalls[0]!.query.toString().includes('opaque-target-token'),false);
  const local=await replayCapture(capture,{});
  assert.equal(local.status,200);
  assert.equal(f.serviceCalls.length,1);
  assert.equal(f.targetCalls.length,2);
  assert.equal(f.targetCalls[1]!.headers.authorization,'opaque-target-token');
  assert.equal(f.targetCalls[1]!.headers['user-agent'],'Microlink-Test/1.0');
  assert.equal(f.targetCalls[1]!.headers['x-api-key'],undefined);
  assert.equal(f.targetCalls[1]!.headers['x-api-header-authorization'],undefined);
});
test('POST Function sends the same serialized body remotely and locally without a preliminary GET',async t=>{
  const f=await fixture(t);
  const body='{"odds":[{"price":1.07}]}';
  const capture=await captureRequest(profile(f.target,'POST',{'content-type':'application/json'},body),{endpoint:f.endpoint,apiKey:'service-test-key'});
  assert.equal(capture.mode,'function-post');
  assert.equal(capture.headerSource,'function-configured');
  assert.equal(capture.remote.status,200);
  assert.equal(capture.replayable,true);
  assert.equal(f.targetCalls.length,1);
  assert.equal(f.targetCalls[0]!.method,'POST');
  assert.equal(f.targetCalls[0]!.body,body);
  assert.equal(f.serviceCalls[0]!.query.toString().includes('price'),false);
  await replayCapture(capture,{});
  assert.deepEqual(f.targetCalls.map(call=>call.body),[body,body]);
  assert.equal(f.serviceCalls.length,1);
  assert.equal(f.targetCalls[1]!.headers['x-microlink-probe-body'],undefined);
});
test('custom target headers require a key before any service request',async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>captureRequest(profile(f.target,'GET',{referer:'https://divinoplay.com/'}),{endpoint:f.endpoint}),/MICROLINK_API_KEY/);
  assert.equal(f.serviceCalls.length,0);
});
test('a rate-limit response is recorded without retrying or enabling replay',async t=>{
  const f=await fixture(t,{status:'fail',code:'ERATE',message:'Quota reached'},429);
  const capture=await captureRequest(profile(f.target),{endpoint:f.endpoint});
  assert.equal(f.serviceCalls.length,1);
  assert.equal(capture.service.status,429);
  assert.equal(capture.service.failure?.code,'ERATE');
  assert.equal(capture.replayable,false);
  await assert.rejects(()=>replayCapture(capture,{}),/captura/i);
  assert.equal(f.targetCalls.length,0);
});
test('HTTP 200 with a failed Function is a service failure, not upstream success',async t=>{
  const f=await fixture(t,{status:'success',data:{function:{isFulfilled:false,value:{name:'OutgoingRequestError',message:'Blocked by plan'}}}});
  const capture=await captureRequest(profile(f.target,'POST',{},'{}'),{endpoint:f.endpoint,apiKey:'service-test-key'});
  assert.equal(capture.replayable,false);
  assert.equal(capture.remote.status,null);
  assert.equal(capture.service.failure?.kind,'service-error');
});
test('a malformed success envelope cannot create a replayable capture',async t=>{
  const f=await fixture(t,{status:'success',data:{content:{ok:true}}});
  const capture=await captureRequest(profile(f.target),{endpoint:f.endpoint});
  assert.equal(capture.replayable,false);
  assert.equal(capture.service.failure?.kind,'service-error');
});
test('saved captures hide header credentials and replay resolves their environment references',async t=>{
  const f=await fixture(t);
  const root=await mkdtemp(join(tmpdir(),'microlink-results-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const loaded=profile(f.target,'GET',{authorization:'opaque-target-token'});
  loaded.secrets=[['opaque-target-token','${TOKEN}'],['service-test-key','[REDACTED]']];
  const capture=await captureRequest(loaded,{endpoint:f.endpoint,apiKey:'service-test-key'});
  const path=await saveCapture(capture,root,loaded.secrets);
  const text=await readFile(path,'utf8');
  assert.equal(text.includes('opaque-target-token'),false);
  assert.equal(text.includes('service-test-key'),false);
  const saved=await readCapture(path);
  assert.equal(saved.request.headers.authorization,'${TOKEN}');
  await replayCapture(saved,{TOKEN:'opaque-target-token'});
  assert.equal(f.serviceCalls.length,1);
  assert.equal(f.targetCalls[1]!.headers.authorization,'opaque-target-token');
});
test('corrupt capture versions are rejected before replay',async t=>{
  const root=await mkdtemp(join(tmpdir(),'microlink-corrupt-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'capture.json');
  await writeFile(path,'{"version":999,"replayable":true}');
  await assert.rejects(()=>readCapture(path),/captura/i);
});
test('local timeout stops a single request without retry',async t=>{
  let calls=0;
  const target=await serve(t,async(_req,res)=>{calls++;await new Promise(resolve=>setTimeout(resolve,200));res.end('{}');});
  const f=await fixture(t);
  const capture=await captureRequest(profile(f.target),{endpoint:f.endpoint});
  capture.request.url=target;
  capture.request.timeoutMs=30;
  const result=await replayCapture(capture,{});
  assert.equal(result.failure?.kind,'timeout');
  assert.equal(calls,1);
});
test('local redirects are reported without following another request',async t=>{
  let destinationCalls=0;
  const destination=await serve(t,(_req,res)=>{destinationCalls++;res.end('{}');});
  const redirect=await serve(t,(_req,res)=>{res.writeHead(302,{location:destination});res.end();});
  const f=await fixture(t);
  const capture=await captureRequest(profile(f.target),{endpoint:f.endpoint});
  capture.request.url=redirect;
  assert.equal((await replayCapture(capture,{})).status,302);
  assert.equal(destinationCalls,0);
});

test('saved JSON envelopes redact quoted credentials at every encoded level',async t=>{
  const secret='quote"slash\\secret$&$$';
  const data={statusCode:200,headers:{'content-type':'application/json'},content:{authorization:secret,nested:JSON.stringify({authorization:secret})},function:{isFulfilled:true,value:{headers:{authorization:secret}},profiling:{},logging:{}}};
  const f=await fixture(t,{status:'success',data});
  const root=await mkdtemp(join(tmpdir(),'microlink-escaped-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const loaded=profile(f.target,'GET',{authorization:secret});
  loaded.secrets=[[secret,'${TOKEN}']];
  const capture=await captureRequest(loaded,{endpoint:f.endpoint,apiKey:'service-test-key'});
  const saved=await readCapture(await saveCapture(capture,root,loaded.secrets));
  const envelope=JSON.parse(saved.service.body);
  const remote=JSON.parse(saved.remote.body);
  assert.equal(envelope.data.function.value.headers.authorization,'${TOKEN}');
  assert.equal(remote.authorization,'${TOKEN}');
  assert.equal(JSON.parse(remote.nested).authorization,'${TOKEN}');
});
test('new response cookies are redacted inside the serialized service envelope',async t=>{
  const cookie='session=new-response-secret; HttpOnly';
  const f=await fixture(t,{status:'success',data:{statusCode:200,headers:{'set-cookie':cookie},content:{ok:true},function:{isFulfilled:true,value:{headers:{}},profiling:{},logging:{}}}});
  const root=await mkdtemp(join(tmpdir(),'microlink-cookie-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const capture=await captureRequest(profile(f.target),{endpoint:f.endpoint});
  const saved=await readCapture(await saveCapture(capture,root));
  assert.notEqual(JSON.parse(saved.service.body).data.headers['set-cookie'],cookie);
});
for(const format of ['json','raw']){
  test('persisted '+format+' POST restores credential bytes while keeping unrelated markers literal',async t=>{
    const f=await fixture(t);
    const secret='quote"slash\\secret$&$$';
    const body=format==='json'?JSON.stringify({token:secret,note:'literal ${UNRELATED}'},null,2):'prefix '+secret+' literal ${UNRELATED}';
    const root=await mkdtemp(join(tmpdir(),'microlink-body-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const loaded=profile(f.target,'POST',{'content-type':format==='json'?'application/json':'text/plain',authorization:secret},body);
    loaded.secrets=[[secret,'${TOKEN}']];
    const capture=await captureRequest(loaded,{endpoint:f.endpoint,apiKey:'service-test-key'});
    const saved=await readCapture(await saveCapture(capture,root,loaded.secrets));
    await replayCapture(saved,{TOKEN:secret});
    assert.equal(f.targetCalls[1]!.body,body);
  });
}

test('persisted JSON POST restores a plain credential and rejects missing body bindings before HTTP',async t=>{
  const f=await fixture(t);
  const root=await mkdtemp(join(tmpdir(),'microlink-json-body-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const loaded=profile(f.target,'POST',{'content-type':'application/json',authorization:'ordinary-secret'},'{"token":"ordinary-secret"}');
  loaded.secrets=[['ordinary-secret','${TOKEN}']];
  const capture=await captureRequest(loaded,{endpoint:f.endpoint,apiKey:'service-test-key'});
  const saved=await readCapture(await saveCapture(capture,root,loaded.secrets));
  delete saved.request.headers.authorization;
  await assert.rejects(()=>replayCapture(saved,{}),/TOKEN/);
  assert.equal(f.targetCalls.length,1);
  await replayCapture(saved,{TOKEN:'ordinary-secret'});
  assert.equal(f.targetCalls[1]!.body,'{"token":"ordinary-secret"}');
});

function interceptService(t:test.TestContext){
  const calls:Array<{url:URL;options:RequestInit}>=[];
  t.mock.method(globalThis,'fetch',async(input:string|URL|Request,options:RequestInit={})=>{
    calls.push({url:new URL(String(input)),options});
    return new Response(JSON.stringify({status:'fail',message:'Test response'}),{status:429,headers:{'content-type':'application/json'}});
  });
  return calls;
}
for(const endpoint of [undefined,'https://api.microlink.io/']){
  test((endpoint?'explicit':'default')+' free endpoint never receives the configured API key',async t=>{
    const calls=interceptService(t);
    const capture=await captureRequest(profile('https://example.com/api'),{apiKey:'unused-service-secret',endpoint});
    assert.equal(calls.length,1);
    assert.equal(calls[0]!.url.origin,'https://api.microlink.io');
    assert.equal(calls[0]!.options.method,'GET');
    assert.equal(new Headers(calls[0]!.options.headers).has('x-api-key'),false);
    assert.equal(capture.service.status,429);
  });
}
test('explicit Pro endpoint receives the API key',async t=>{
  const calls=interceptService(t);
  await captureRequest(profile('https://example.com/api'),{endpoint:'https://pro.microlink.io/',apiKey:'service-test-key'});
  assert.equal(calls.length,1);
  assert.equal(calls[0]!.url.origin,'https://pro.microlink.io');
  assert.equal(new Headers(calls[0]!.options.headers).get('x-api-key'),'service-test-key');
});
test('Pro without an API key fails before the network even for a plain GET',async t=>{
  const calls=interceptService(t);
  await assert.rejects(()=>captureRequest(profile('https://example.com/api'),{endpoint:'https://pro.microlink.io/'}),/MICROLINK_API_KEY/);
  assert.equal(calls.length,0);
});
test('free endpoint rejects custom headers without silently changing the target request',async t=>{
  const calls=interceptService(t);
  const loaded=profile('https://example.com/api','GET',{referer:'https://divinoplay.com/'});
  await assert.rejects(()=>captureRequest(loaded,{apiKey:'unused-service-secret'}),/gratuito.*cabeceras.*get-free/i);
  assert.equal(calls.length,0);
  assert.equal(loaded.request.headers.referer,'https://divinoplay.com/');
});
test('free endpoint rejects this app POST mode before any request',async t=>{
  const calls=interceptService(t);
  await assert.rejects(()=>captureRequest(profile('https://example.com/api','POST',{},'{}'),{apiKey:'unused-service-secret'}),/gratuito.*POST/i);
  assert.equal(calls.length,0);
});
