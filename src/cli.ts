import {existsSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {resolve,join} from 'node:path';
import {parseArgs} from 'node:util';
import {loadProfile,resolveValue} from './profile.js';
import {captureRequest,replayCapture} from './transport.js';
import {captureSecrets,readCapture,redact,replayDirectory,saveCapture,saveJson} from './artifacts.js';
import {compareResponses,outcome,jsonFingerprint} from './compare.js';
import type {Capture} from './types.js';

const help=`Microlink imitation — captura y reproducción HTTP

  pnpm capture --profile get-free
  pnpm compare --profile post
  pnpm replay --capture results/<run>/capture.json

  --profile <nombre|archivo.json>  Perfil en profiles/ o ruta JSON (default: get-free)
  --capture <archivo>              Captura para replay; no llama a Microlink
  --out <directorio>               Directorio de capturas (default: results)
  -h, --help                      Mostrar ayuda

Por defecto usa https://api.microlink.io sin enviar la clave configurada.
Para get/post: MICROLINK_ENDPOINT=https://pro.microlink.io y MICROLINK_API_KEY.
Configura ALTENAR_AUTHORIZATION para el perfil post.
Cada compare hace una llamada al servicio y una petición local, sin reintentos.
`;
async function main():Promise<number> {
  let secrets:Array<[string,string]>=[];
  const print=(value:unknown)=>console.log(JSON.stringify(redact(value,secrets),null,2));
  try {
    if(existsSync('.env'))loadEnvFile('.env');
    secrets=Object.entries(process.env).filter(([key,value])=>/key|token|secret|authorization|cookie/i.test(key) && !!value).map(([key,value])=>[value!, '${'+key+'}']);
    const {values,positionals}=parseArgs({args:process.argv.slice(2),allowPositionals:true,options:{profile:{type:'string'},capture:{type:'string'},out:{type:'string'},help:{type:'boolean',short:'h'}}});
    if(values.help || positionals.length===0){console.log(help);return 0;}
    const [command]=positionals;
    if(positionals.length!==1 || !['capture','replay','compare'].includes(command!))throw new Error('Comando inválido. Usa capture, replay o compare; consulta --help.');
    let capture:Capture;
    let path:string;
    if(command==='replay'){
      if(!values.capture)throw new Error('replay requiere --capture <archivo>.');
      path=resolve(values.capture);
      capture=await readCapture(path);
      const references=[...Object.values(capture.request.headers),...(capture.bodyBindings ?? []).map(binding=>binding.template)];
      for(const value of references){
        for(const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)){
          const name=match[1]!;
          const real=resolveValue('${'+name+'}',process.env);
          secrets.push([real,'${'+name+'}']);
        }
      }
    } else {
      if(values.capture)throw new Error('--capture solo se usa con replay.');
      const name=values.profile ?? 'get-free';
      const profilePath=/[\\/]|\.json$/i.test(name)?resolve(name):resolve('profiles',name+'.json');
      const profile=await loadProfile(profilePath);
      secrets.push(...profile.secrets);
      capture=await captureRequest(profile,{apiKey:process.env.MICROLINK_API_KEY || undefined,endpoint:process.env.MICROLINK_ENDPOINT || undefined});
      secrets=captureSecrets(capture,secrets);
      path=await saveCapture(capture,values.out ?? 'results',secrets);
    }
    if(command==='capture' || !capture.replayable){
      print({mode:capture.mode,capture:path,replayable:capture.replayable,serviceStatus:capture.service.status,remoteStatus:capture.remote.status,outcome:outcome(capture.remote),error:capture.service.failure ?? null,notes:capture.notes});
      return capture.replayable && outcome(capture.remote)==='json'?0:1;
    }
    const local=await replayCapture(capture);
    const comparison=compareResponses(redact(capture.remote,secrets),redact(local,secrets),{remote:capture.remoteJsonFingerprint ?? jsonFingerprint(capture.remote.body),local:jsonFingerprint(local.body)});
    const directory=replayDirectory(path);
    await saveJson(join(directory,'local.json'),local,secrets);
    await saveJson(join(directory,'comparison.json'),comparison,secrets);
    print({mode:capture.mode,capture:path,replayDirectory:directory,comparison,notes:capture.notes});
    return comparison.accessWorks===true?0:comparison.accessWorks===null?2:1;
  } catch(error) {
    const message=error instanceof Error?error.message:'Error inesperado.';
    console.error(JSON.stringify(redact({error:message},secrets)));
    return 1;
  }
}
process.exitCode=await main();
