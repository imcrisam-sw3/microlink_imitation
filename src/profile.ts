import {readFile} from 'node:fs/promises';
import type {Environment, HeadersMap, LoadedProfile, PreparedRequest} from './types.js';

export function resolveValue(value: string, env: Environment): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const result = env[name];
    if (!result) throw new Error(`Falta la variable de entorno ${name}.`);
    return result;
  });
}
export function headerMap(value: unknown): HeadersMap {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('headers debe ser un objeto.');
  const entries = Object.entries(value);
  for (const [key, item] of entries) {
    if (typeof item !== 'string') throw new Error(`La cabecera ${key} debe ser un string.`);
    new Headers({[key]:item});
  }
  return Object.fromEntries(entries.map(([key, value]) => [key.toLowerCase(), value as string]));
}
export function validateRequest(value: unknown): asserts value is PreparedRequest {
  if (!value || typeof value !== 'object') throw new Error('La request debe ser un objeto.');
  const request = value as PreparedRequest;
  const url = new URL(request.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('La URL debe usar HTTP(S) sin credenciales embebidas.');
  if (!['GET', 'POST'].includes(request.method)) throw new Error('method debe ser GET o POST.');
  if (request.method === 'GET' && request.body != null) throw new Error('GET no permite body.');
  if (request.body !== null && typeof request.body !== 'string') throw new Error('El body preparado debe ser string o null.');
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 60000) throw new Error('timeoutMs debe estar entre 1 y 60000.');
  headerMap(request.headers);
}
export async function loadProfile(path: string, env: Environment = process.env): Promise<LoadedProfile> {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('El perfil debe ser un objeto JSON.');
  if (typeof value.url !== 'string') throw new Error('Falta url en el perfil.');
  const method = String(value.method ?? 'GET').toUpperCase() as PreparedRequest['method'];
  const body = value.body == null ? null : typeof value.body === 'string' ? value.body : JSON.stringify(value.body);
  const template: PreparedRequest = {url:value.url,method,headers:headerMap(value.headers),body,timeoutMs:value.timeoutMs ?? 30000};
  validateRequest(template);
  const secrets: Array<[string,string]> = [];
  const headers = Object.fromEntries(Object.entries(template.headers).map(([key,value]) => {
    const resolved = resolveValue(value, env);
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      const name = match[1]!;
      secrets.push([env[name]!, '${'+name+'}']);
    }
    if (/^(authorization|proxy-authorization|cookie|x-api-key|x-auth-token)$/i.test(key)) {
      const reference = value.includes('${') ? value : '${REPLAY_'+key.toUpperCase().replaceAll('-', '_')+'}';
      template.headers[key] = reference;
      secrets.push([resolved, reference]);
    }
    return [key,resolved];
  }));
  return {request:{...template,headers},template,secrets};
}
