import {jsonFingerprint} from './compare.js';
import {restoreBody} from './body.js';
import {brotliCompressSync} from 'node:zlib';
import {headerMap,resolveValue,validateRequest} from './profile.js';
import type {Capture,Environment,HeadersMap,LoadedProfile,PreparedRequest,ResponseResult} from './types.js';

const BODY_HEADER='x-microlink-probe-body';
const HOP_HEADERS=new Set(['host','connection','content-length','keep-alive','transfer-encoding','trailer','te','upgrade','proxy-connection','proxy-authorization','accept-encoding']);
const headersFunction='({ headers }) => ({ headers })';
const postFunction=`async ({ url, headers, probeTimeoutMs }) => {
  const h = { ...headers };
  const encoded = h['x-microlink-probe-body'];
  delete h['x-microlink-probe-body'];
  const body = encoded === 'null' ? null : Buffer.from(encoded.slice(7), 'base64').toString('utf8');
  const r = await fetch(url, { method: 'POST', headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(Number(probeTimeoutMs)) });
  return { request: { url, method: 'POST', headers: h, body }, response: { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() } };
}`;
export interface ServiceOptions {apiKey?:string;endpoint?:string}
function record(value: unknown): value is Record<string,unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function replayHeaders(configured: HeadersMap, observed: HeadersMap = {}): HeadersMap {
  const all={...headerMap(configured),...headerMap(observed)};
  const excluded=new Set([...HOP_HEADERS,...(all.connection ?? '').split(',').map(value=>value.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(all).filter(([key])=>!excluded.has(key) && key!==BODY_HEADER && !key.startsWith('x-api-header-') && (key!=='x-api-key' || Object.hasOwn(configured,key))));
}
async function http(url:string,options:RequestInit,timeoutMs:number):Promise<ResponseResult> {
  const start=performance.now();
  try {
    const response=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(timeoutMs)});
    const body=await response.text();
    return {status:response.status,headers:Object.fromEntries(response.headers),body,durationMs:Math.round(performance.now()-start)};
  } catch(error) {
    const timeout=error instanceof Error && ['TimeoutError','AbortError'].includes(error.name);
    return {status:null,headers:{},body:'',durationMs:Math.round(performance.now()-start),failure:{kind:timeout?'timeout':'network-error',message:timeout?'La petición excedió timeoutMs.':'Falló la conexión HTTP.'}};
  }
}
function upstreamStatus(value:unknown):number|null {
  return typeof value==='number' && Number.isInteger(value) && value>=100 && value<=599 ? value : null;
}
export async function captureRequest(profile:LoadedProfile,options:ServiceOptions={}):Promise<Capture> {
  const request=profile.request;
  validateRequest(request);
  if(Object.hasOwn(request.headers,BODY_HEADER)) throw new Error('La cabecera x-microlink-probe-body está reservada.');
  const endpoint=new URL(options.endpoint ?? 'https://api.microlink.io/');
  if(!['http:','https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Endpoint de Microlink inválido.');
  const hostname=endpoint.hostname.toLowerCase().replace(/\.$/,'');
  const freeEndpoint=hostname==='api.microlink.io';
  if(freeEndpoint && (Object.keys(request.headers).length>0 || request.method==='POST')) throw new Error('El endpoint gratuito no admite las cabeceras personalizadas ni el modo POST de esta app. Usa --profile get-free para GET sin cabeceras, o configura MICROLINK_ENDPOINT=https://pro.microlink.io y MICROLINK_API_KEY para conservar la petición original.');
  if((hostname==='pro.microlink.io' || Object.keys(request.headers).length>0 || request.method==='POST') && !options.apiKey) throw new Error('Falta MICROLINK_API_KEY: Pro, las cabeceras personalizadas y el POST de esta app la requieren.');
  const params=new URLSearchParams({url:request.url,meta:'false',prerender:'false',ping:'false',retry:'0',force:'true',timeout:String(request.timeoutMs)});
  const serviceHeaders:HeadersMap={accept:'application/json'};
  if(options.apiKey && !freeEndpoint)serviceHeaders['x-api-key']=options.apiKey;
  for(const [key,value]of Object.entries(replayHeaders(request.headers)))serviceHeaders['x-api-header-'+key]=value;
  if(request.method==='GET')params.set('data.content.attr','json');
  else {
    serviceHeaders['x-api-header-'+BODY_HEADER]=request.body===null?'null':'base64:'+Buffer.from(request.body).toString('base64');
    params.set('probeTimeoutMs',String(request.timeoutMs));
  }
  const code=request.method==='GET'?headersFunction:postFunction;
  params.set('function','br#'+brotliCompressSync(Buffer.from(code)).toString('base64url'));
  endpoint.search=params.toString();
  const service=await http(endpoint.href,{method:'GET',headers:serviceHeaders},request.timeoutMs);
  const capture:Capture={
    version:1,createdAt:new Date().toISOString(),mode:request.method==='GET'?'native-get':'function-post',
    request:{...request,headers:replayHeaders(request.headers)},observedHeaders:null,headerSource:'unavailable',
    remote:{status:null,headers:{},body:'',durationMs:service.durationMs},service,replayable:false,
    notes:['Se reproducen los campos disponibles; IP, TLS y cabeceras implícitas del transporte pueden diferir.','La aplicación no reintenta; Microlink puede realizar operaciones internas adicionales.']
  };
  if(service.failure){capture.remote.failure=service.failure;return capture;}
  try {
    const envelope:unknown=JSON.parse(service.body);
    if(!record(envelope))throw new Error('Respuesta de Microlink inválida.');
    if(service.status===null || service.status<200 || service.status>299 || envelope.status!=='success') {
      const error=new Error(typeof envelope.message==='string'?envelope.message:'Microlink rechazó la consulta.') as Error & {code?:string};
      if(typeof envelope.code==='string')error.code=envelope.code;
      throw error;
    }
    const data=envelope.data;
    if(!record(data) || !record(data.function) || data.function.isFulfilled!==true || !record(data.function.value))throw new Error('La Function no se completó o falta su resultado.');
    const value=data.function.value;
    if(request.method==='GET'){
      if(!Object.hasOwn(data,'content') || !record(value.headers))throw new Error('Faltan JSON o cabeceras observables en la captura GET.');
      capture.observedHeaders=headerMap(value.headers);
      capture.headerSource='microlink-context';
      capture.remote={status:upstreamStatus(data.statusCode),headers:headerMap(data.headers),body:JSON.stringify(data.content),durationMs:service.durationMs};
      if(capture.remote.status===null)capture.notes.push('Microlink no expuso el estado HTTP del destino; el acceso remoto queda inconcluso.');
    } else {
      if(!record(value.request) || !record(value.response) || !record(value.request.headers) || typeof value.response.body!=='string')throw new Error('La Function no devolvió request y response completas.');
      if(value.request.method!=='POST' || typeof value.request.url!=='string' || new URL(value.request.url).href!==new URL(request.url).href || value.request.body!==request.body)throw new Error('La petición devuelta por la Function no coincide con el perfil.');
      const status=upstreamStatus(value.response.status);
      if(status===null)throw new Error('Estado HTTP del POST inválido.');
      capture.observedHeaders=headerMap(value.request.headers);
      capture.headerSource='function-configured';
      capture.remote={status,headers:headerMap(value.response.headers),body:value.response.body,durationMs:service.durationMs};
      capture.notes.push('El POST usa fetch dentro de una Function; no verifica la ruta nativa de proxies de Microlink.');
    }
    capture.request.headers=replayHeaders(request.headers,capture.observedHeaders!);
    capture.remoteJsonFingerprint=jsonFingerprint(capture.remote.body);
    capture.replayable=true;
  } catch(error) {
    const message=error instanceof Error?error.message:'Respuesta de Microlink inválida.';
    const code=record(error) && typeof error.code==='string'?error.code:undefined;
    const failure={kind:'service-error' as const,message,...(code?{code}:{})};
    capture.service.failure=failure;
    capture.remote.failure=failure;
  }
  return capture;
}
export async function replayCapture(capture:Capture,env:Environment=process.env):Promise<ResponseResult> {
  if(capture.version!==1 || capture.replayable!==true)throw new Error('La captura no es reproducible.');
  validateRequest(capture.request);
  const headers=Object.fromEntries(Object.entries(replayHeaders(capture.request.headers)).map(([key,value])=>[key,resolveValue(value,env)]));
  const body=restoreBody(capture.request.body,capture.bodyBindings,env);
  return http(capture.request.url,{method:capture.request.method,headers,body},capture.request.timeoutMs);
}
