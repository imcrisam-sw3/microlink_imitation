import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {Microlink} from '../src/client/Microlink.ts';

test('GET reports the actual destination agent and masks opaque tokens in logs and returned results', async () => {
  const secret='opaque-token-for-diagnostic-test';
  const logs=[];
  const originalLog=console.log;
  let calls=0;
  const server=createServer(async(req,res)=>{
    calls++;
    try {
      const url=new URL(req.url,'http://localhost');
      const code=url.searchParams.get('function');
      assert.ok(code,'GET must request a remote diagnostic Function');
      const fn=new Function(`return (${code})`)();
      const remote=await fn({page:{},headers:{'user-agent':'configured-agent'},response:{
        status:()=>200,
        request:()=>({headers:()=>({'user-agent':'actual-browser-agent'})}),
        text:async()=>`{\n  "opaque-provider-field": "${secret}",\n  "denied": null\n}`,
      }});
      assert.equal(remote.rawBody.includes(secret),false,'Remote diagnostic must hide tokens before returning');
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({status:'success',statusCode:200,data:{content:{'opaque-provider-field':secret,denied:null},function:{isFulfilled:true,value:remote}},headers:{'content-type':'application/json'}}));
    } catch(error){res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  console.log=(...args)=>logs.push(args.join(' '));
  try {
    const client=new Microlink();
    client.endpoint=`http://127.0.0.1:${server.address().port}`;
    const result=await client.get('https://provider.example/token', {authorization:'header-secret'});
    assert.equal(calls,1);
    assert.equal(result.error,undefined, result.error);
    assert.equal(result.data.function.value.userAgent,'actual-browser-agent');
    assert.equal(result.data.function.value.statusCode,200);
    assert.deepEqual(JSON.parse(result.data.function.value.rawBody),{'opaque-provider-field':'[REDACTED_TOKEN]',denied:null});
    assert.equal(result.data.content.denied,null);
    assert.equal(JSON.stringify(result).includes(secret),false);
    assert.equal(logs.join('\n').includes(secret),false);
    assert.equal(logs.join('\n').includes('header-secret'),false);
    assert.match(logs.join('\n'),/actual-browser-agent/);
  } finally {console.log=originalLog;await new Promise(resolve=>server.close(resolve));}
});

for (const [name, body, expected] of [
  ['preserves the provider denial and original JSON spacing', '{\n  "YUdGb1lTQmtiMjRuZENCbGRtVnVJSFJ5ZVE": null\n}', '{\n  "YUdGb1lTQmtiMjRuZENCbGRtVnVJSFJ5ZVE": null\n}'],
  ['masks a JSON string token', '"short-token"', '"[REDACTED_TOKEN]"'],
  ['masks nested opaque JSON values', '{"items":["secret",{"value":"escaped\\\"secret"}],"ok":true}', '{"items":["[REDACTED_TOKEN]",{"value":"[REDACTED_TOKEN]"}],"ok":true}'],
  ['preserves HTML denial while hiding bearer credentials', '<html><h1>Blocked</h1>Bearer secret-token</html>', '<html><h1>Blocked</h1>[REDACTED_TOKEN]</html>'],
]) {
  test(name, async () => {
    const server=createServer(async(req,res)=>{
      const code=new URL(req.url,'http://localhost').searchParams.get('function');
      const fn=new Function(`return (${code})`)();
      const value=await fn({page:{},response:{status:()=>200,request:()=>({headers:()=>({})}),text:async()=>body}});
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({status:'success',data:{function:{isFulfilled:true,value}}}));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const originalLog=console.log;
    console.log=()=>{};
    try {
      const client=new Microlink();
      client.endpoint=`http://127.0.0.1:${server.address().port}`;
      const result=await client.get('https://provider.example/token');
      assert.equal(result.data.function.value.rawBody,expected);
      assert.equal(result.data.function.value.userAgent,null);
    } finally {console.log=originalLog;await new Promise(resolve=>server.close(resolve));}
  });
}

test('an unavailable Function leaves a clear diagnostic and preserves the API error', async () => {
  const server=createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({status:'fail',code:'EFUNCTION',data:{function:{isFulfilled:false,value:{message:'Function unavailable'}}}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const logs=[];
  const originalLog=console.log;
  console.log=(...args)=>logs.push(args.join(' '));
  try {
    const client=new Microlink();
    client.endpoint=`http://127.0.0.1:${server.address().port}`;
    const result=await client.get('https://provider.example/token');
    assert.equal(result.code,'EFUNCTION');
    assert.equal(result.data.function.isFulfilled,false);
    assert.match(logs.join('\n'),/Diagnóstico destino no disponible/);
  } finally {console.log=originalLog;await new Promise(resolve=>server.close(resolve));}
});
