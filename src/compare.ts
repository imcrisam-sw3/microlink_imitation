import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {ResponseResult} from './types.js';

export function parseJson(body: string): {valid: boolean; value?: unknown} {
  try { return {valid:true, value:JSON.parse(body)}; } catch { return {valid:false}; }
}
export function jsonFingerprint(body:string):string|null {
  const parsed=parseJson(body);
  if(!parsed.valid)return null;
  function canonical(value:unknown):string {
    if(value===null)return 'null';
    if(Array.isArray(value))return 'a:['+value.map(canonical).join(',')+']';
    if(typeof value==='object')return 'o:{'+Object.keys(value!).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
    if(typeof value==='number')return 'n:'+(Object.is(value,-0)?'-0':String(value));
    return typeof value+':'+JSON.stringify(value);
  }
  return createHash('sha256').update(canonical(parsed.value)).digest('hex');
}
export function outcome(response: ResponseResult): string {
  if (response.failure) return response.failure.kind;
  if (response.status !== null && (response.status < 200 || response.status > 299)) return 'http-error';
  if (!parseJson(response.body).valid) return /html/i.test(response.headers['content-type'] ?? '') || /^\s*</.test(response.body) ? 'html' : 'invalid-json';
  return response.status === null ? 'unknown-status' : 'json';
}
export function compareResponses(remote: ResponseResult, local: ResponseResult, fingerprints?:{remote:string|null;local:string|null}) {
  const a = parseJson(remote.body);
  const b = parseJson(local.body);
  const remoteOutcome = outcome(remote);
  const localOutcome = outcome(local);
  const differences: Array<{path:string;remote?:unknown;local?:unknown}> = [];
  let truncated = false;
  const diff = (left: unknown, right: unknown, path: string): void => {
    if (isDeepStrictEqual(left,right)) return;
    if (differences.length >= 50) {truncated=true; return;}
    if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object' && Array.isArray(left) === Array.isArray(right)) {
      const l = left as Record<string,unknown>;
      const r = right as Record<string,unknown>;
      for (const key of new Set([...Object.keys(l),...Object.keys(r)])) {
        diff(l[key],r[key],Array.isArray(left) ? `${path}[${key}]` : `${path}.${key}`);
      }
    } else {differences.push({path,remote:left,local:right});}
  };
  if (a.valid && b.valid) diff(a.value,b.value,'$');
  const accessWorks = remoteOutcome === 'json' && localOutcome === 'json' ? true : remoteOutcome === 'unknown-status' || localOutcome === 'unknown-status' ? null : false;
  return {accessWorks,jsonEqual:a.valid && b.valid ? fingerprints?.remote && fingerprints?.local ? fingerprints.remote===fingerprints.local : isDeepStrictEqual(a.value,b.value) : null,remoteOutcome,localOutcome,remoteStatus:remote.status,localStatus:local.status,remoteContentType:remote.headers['content-type'] ?? null,localContentType:local.headers['content-type'] ?? null,remoteDurationMs:remote.durationMs,localDurationMs:local.durationMs,differences,truncated};
}
