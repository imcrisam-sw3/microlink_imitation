import {randomUUID} from 'node:crypto';
import {resolveValue} from './profile.js';
import type {BodyBinding,Environment} from './types.js';

export function protectBody(body:string|null,secrets:Array<[string,string]>):{body:string|null;bindings:BodyBinding[]} {
  if(body===null)return {body,bindings:[]};
  let isJson=false;
  try{JSON.parse(body);isJson=true;}catch{}
  const patterns=secrets.filter(([secret])=>secret.length>0).flatMap(([secret,template],index)=>{
    const escaped=JSON.stringify(secret).slice(1,-1);
    const reference=/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(template)?template:'${REPLAY_BODY_SECRET_'+index+'}';
    return escaped===secret
      ? [{text:secret,template:reference,encoding:isJson?'json' as const:'raw' as const}]
      : [{text:escaped,template:reference,encoding:'json' as const},{text:secret,template:reference,encoding:'raw' as const}];
  });
  let cursor=0;
  let result='';
  const bindings:BodyBinding[]=[];
  while(cursor<body.length){
    let next:{index:number;pattern:(typeof patterns)[number]}|undefined;
    for(const pattern of patterns){
      const index=body.indexOf(pattern.text,cursor);
      if(index!==-1 && (!next || index<next.index || (index===next.index && pattern.text.length>next.pattern.text.length)))next={index,pattern};
    }
    if(!next){result+=body.slice(cursor);break;}
    const marker='__ML_BODY_'+randomUUID()+'__';
    bindings.push({marker,template:next.pattern.template,encoding:next.pattern.encoding});
    result+=body.slice(cursor,next.index)+marker;
    cursor=next.index+next.pattern.text.length;
  }
  return {body:result,bindings};
}
export function validateBodyBindings(value:unknown,body:string|null):asserts value is BodyBinding[]|undefined {
  if(value===undefined)return;
  if(!Array.isArray(value))throw new Error('Bindings del body de captura inválidos.');
  const markers=new Set<string>();
  for(const entry of value){
    const b=entry as BodyBinding;
    if(!b || typeof b.marker!=='string' || !b.marker || markers.has(b.marker) || typeof b.template!=='string' || !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(b.template) || !['json','raw'].includes(b.encoding) || body===null || !body.includes(b.marker))throw new Error('Bindings del body de captura inválidos.');
    markers.add(b.marker);
  }
}
export function restoreBody(body:string|null,bindings:BodyBinding[]|undefined,env:Environment):string|null {
  validateBodyBindings(bindings,body);
  if(body===null)return null;
  for(const binding of bindings ?? []){
    const value=resolveValue(binding.template,env);
    body=body.replaceAll(binding.marker,()=>binding.encoding==='json'?JSON.stringify(value).slice(1,-1):value);
  }
  return body;
}
