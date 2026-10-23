import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {TestContext} from 'node:test';
import {brotliDecompressSync,gunzipSync} from 'node:zlib';
import type {PreparedRequest,LoadedProfile} from '../src/types.js';

export async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[]=[];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}
export async function serve(t: TestContext, handler: (req: IncomingMessage,res: ServerResponse)=>void|Promise<void>) {
  const server=createServer((req,res)=>{Promise.resolve(handler(req,res)).catch(error=>{res.statusCode=500;res.end(String(error));});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  return 'http://127.0.0.1:'+(server.address() as AddressInfo).port+'/';
}
export function profile(url:string,method:PreparedRequest['method']='GET',headers:Record<string,string>={},body:string|null=null): LoadedProfile {
  const request={url,method,headers,body,timeoutMs:2000};
  return {request,template:{...request,headers:{...headers}},secrets:[]};
}
export async function fixture(t:TestContext, fault?:unknown, status=200) {
  const targetCalls: Array<{method:string;body:string;headers:IncomingMessage['headers']}>=[];
  const serviceCalls: Array<{query:URLSearchParams;headers:IncomingMessage['headers']}>=[];
  const target=await serve(t,async(req,res)=>{
    const body=await bodyOf(req);
    targetCalls.push({method:req.method!,body,headers:req.headers});
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({method:req.method,body,authorization:req.headers.authorization ?? null,userAgent:req.headers['user-agent']}));
  });
  const endpoint=await serve(t,async(req,res)=>{
    const query=new URL(req.url!,'http://localhost').searchParams;
    serviceCalls.push({query,headers:req.headers});
    res.statusCode=status;
    res.setHeader('content-type','application/json');
    if(fault!==undefined){res.end(JSON.stringify(fault));return;}
    const url=query.get('url')!;
    if(!url.startsWith(target)) throw new Error('Test refuses external target');
    const headers:Record<string,string>={'user-agent':'Microlink-Test/1.0'};
    for(const [key,value] of Object.entries(req.headers)) if(key.startsWith('x-api-header-')) headers[key.slice(13)]=String(value);
    const payload=query.get('function')!;
    const [format,encoded]=payload.split('#');
    const code=encoded ? (format==='br'?brotliDecompressSync:gunzipSync)(Buffer.from(encoded,'base64url')).toString() : payload;
    const fn=new Function('return ('+code+')')();
    let data:Record<string,unknown>;
    if(query.get('data.content.attr')==='json'){
      const response=await fetch(url,{headers,redirect:'manual'});
      data={url,statusCode:response.status,headers:Object.fromEntries(response.headers),content:await response.json(),function:{isFulfilled:true,value:await fn({url,headers}),profiling:{},logging:{}}};
    } else {
      data={function:{isFulfilled:true,value:await fn({url,headers,probeTimeoutMs:query.get('probeTimeoutMs')}),profiling:{},logging:{}}};
    }
    res.end(JSON.stringify({status:'success',data}));
  });
  return {target,endpoint,targetCalls,serviceCalls};
}
