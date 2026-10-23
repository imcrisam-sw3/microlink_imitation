import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {headerMap,validateRequest} from './profile.js';
import {protectBody,validateBodyBindings} from './body.js';
import type {Capture,ResponseResult} from './types.js';

const sensitive=/authorization|cookie|token|secret|api[-_]?key/i;
function reference(key:string):string {return '${REPLAY_'+key.toUpperCase().replaceAll(/[^A-Z0-9_]/g,'_')+'}';}
export function captureSecrets(capture:Capture,known:Array<[string,string]> = []):Array<[string,string]> {
  const result=[...known];
  for(const [key,value] of Object.entries(capture.request.headers)) {
    if(sensitive.test(key) && !value.includes('${') && !result.some(([secret])=>secret===value))result.push([value,reference(key)]);
  }
  return result.filter(([value])=>value.length>0);
}
export function redact<T>(value:T,secrets:Array<[string,string]> = []):T {
  const pairs=[...secrets].filter(([secret])=>secret.length>0).sort((a,b)=>b[0].length-a[0].length);
  function walk(input:unknown,key='',headers=false):unknown {
    if(typeof input==='string'){
      if(!headers && !sensitive.test(key)){
        try {
          const parsed:unknown=JSON.parse(input);
          const safe=walk(parsed);
          if(!isDeepStrictEqual(parsed,safe))return JSON.stringify(safe);
          return input;
        }catch{}
      }
      let result=input;
      for(const [secret,replacement] of pairs)result=result.replaceAll(secret,()=>replacement);
      if(sensitive.test(key) && result && !result.includes('${') && result!=='[REDACTED]')return reference(key);
      return result;
    }
    if(Array.isArray(input))return input.map(item=>walk(item,key,headers));
    if(input!==null && typeof input==='object')return Object.fromEntries(Object.entries(input).map(([k,v])=>[k,walk(v,k,headers || k==='headers' || k==='observedHeaders')]));
    return input;
  }
  return walk(value) as T;
}
function runId():string {return new Date().toISOString().replaceAll(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);}
async function writePrivateJson(path:string,value:unknown):Promise<void> {
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  await writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
}
export async function saveJson(path:string,value:unknown,secrets:Array<[string,string]> = []):Promise<void> {
  await writePrivateJson(path,redact(value,secrets));
}
export async function saveCapture(capture:Capture,root='results',secrets:Array<[string,string]> = []):Promise<string> {
  const path=resolve(root,runId(),'capture.json');
  const pairs=captureSecrets(capture,secrets);
  const safe=redact(capture,pairs);
  const body=protectBody(capture.request.body,pairs);
  safe.remoteJsonFingerprint=capture.remoteJsonFingerprint;
  safe.request.body=body.body;
  if(body.bindings.length>0)safe.bodyBindings=body.bindings;
  await writePrivateJson(path,safe);
  return path;
}
function responseValid(value:unknown):value is ResponseResult {
  if(!value || typeof value!=='object')return false;
  const response=value as ResponseResult;
  return (response.status===null || (Number.isInteger(response.status) && response.status>=100 && response.status<=599)) && typeof response.body==='string' && typeof response.durationMs==='number' && Number.isFinite(response.durationMs) && response.durationMs>=0 && !!response.headers && typeof response.headers==='object';
}
export async function readCapture(path:string):Promise<Capture> {
  try {
    const value=JSON.parse(await readFile(path,'utf8')) as Capture;
    if(value?.version!==1 || typeof value.replayable!=='boolean' || !['native-get','function-post'].includes(value.mode) || !responseValid(value.remote) || !responseValid(value.service))throw new Error();
    if(value.remoteJsonFingerprint!==undefined && value.remoteJsonFingerprint!==null && (typeof value.remoteJsonFingerprint!=='string' || !/^[a-f0-9]{64}$/.test(value.remoteJsonFingerprint)))throw new Error();
    validateRequest(value.request);
    validateBodyBindings(value.bodyBindings,value.request.body);
    headerMap(value.remote.headers);
    headerMap(value.service.headers);
    return value;
  }catch{throw new Error('Archivo de captura inválido o no legible.');}
}
export function replayDirectory(capturePath:string):string {
  return join(dirname(resolve(capturePath)),'replays',runId());
}
