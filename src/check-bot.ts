import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotDetector } from './tool/BotDetector.js';
import { AntibotDetector } from './tool/AntibotDetector.js';

// CONFIGURACIÓN: edita estos objetos y variables.
export const GET_REQUEST: ProbeRequest = {
  method: 'GET',
  url: 'https://www.sofascore.com/api/v1/event/16285064/statistics', // URL a probar.
  headers: {},
};
export const POST_REQUEST: ProbeRequest = {
  method: 'POST',
  url: '',
  headers: {},
  body: { example: 'value' },
};
export const REQUEST_TO_USE = GET_REQUEST; // Cambia por POST_REQUEST.
export const CLIENTS_TO_USE: ClientName[] = ['tls', 'fingerprint', 'impers', 'utls'];
export const REQUESTS_PER_CLIENT = 400;
export const REPORT_EVERY = 40;

// Clientes que tenemos. Sólo se construyen los seleccionados.
export const AVAILABLE_CLIENTS = {
  tls: async () => {
    const { TlsClient } = await import('./client/TlsClient.js');
    const client = new TlsClient();
    return directClient(client, client.userAgent);
  },
  fingerprint: async () => {
    const { FingerprintClient } = await import('./client/FingerprintClient.js');
    const client = new FingerprintClient();
    return directClient(client, client.userAgent);
  },
  impers: async () => {
    const { ImpersClient } = await import('./client/ImpersClient.js');
    const client = new ImpersClient();
    try {
      const userAgent = await observeUserAgent(client);
      return directClient(client, userAgent, 1);
    } catch (error) {
      await client.close();
      throw error;
    }
  },
  utls: async (request?: ProbeRequest) => {
    const { UtlsClient } = await import('./client/UtlsClient.js');
    const client = new UtlsClient();
    const userAgent = new Headers(request?.headers).get('user-agent') ?? client.headers['user-agent'] ?? null;
    return directClient(client, userAgent);
  },
  microlink: async (): Promise<ProbeClient> => {
    const { Microlink } = await import('./client/Microlink.js');
    const client = new Microlink();
    return {
      userAgent: null,
      identityRequests: 0,
      close: () => {},
      async send(request) {
        const data = request.method === 'POST'
          ? await client.post(request.url, request.body, request.headers)
          : await client.get(request.url, request.headers);
        const diagnostic = data.data?.function;
        if (!diagnostic?.isFulfilled) throw new Error('Microlink no devolvió el diagnóstico del destino.');
        const value = diagnostic.value;
        const status = value?.statusCode ?? value?.status;
        if (!Number.isInteger(status)) throw new Error('Microlink no informó el estado HTTP del destino.');
        return {
          status,
          headers: new Headers(value.headers ?? data.headers ?? {}),
          userAgent: value.userAgent ?? null,
          text: async () => value.rawBody ?? value.body ?? '',
        };
      },
    };
  },
};

type ClientName = keyof typeof AVAILABLE_CLIENTS;
type ProbeRequest =
  | { method: 'GET'; url: string; headers: Record<string, string> }
  | { method: 'POST'; url: string; headers: Record<string, string>; body: unknown };
interface ProbeResponse {
  status: number;
  headers: Iterable<[string, string]>;
  text(): Promise<string>;
  userAgent?: string | null;
}
interface HttpClient {
  get(url: string, headers?: Record<string, string>, signal?: AbortSignal, redirect?: 'follow' | 'manual' | 'error'): Promise<ProbeResponse>;
  post(url: string, body: unknown, headers?: Record<string, string>): Promise<ProbeResponse>;
  close(): void | Promise<void>;
}
interface ProbeClient {
  userAgent: string | null;
  identityRequests: number;
  send(request: ProbeRequest): Promise<ProbeResponse>;
  close(): void | Promise<void>;
}
export interface CheckConfig {
  request: ProbeRequest;
  clients: ClientName[];
  requestsPerClient: number;
  reportEvery: number;
}
interface ClientSummary {
  client: ClientName;
  requested: number;
  attempted: number;
  statusCounts: Record<string, number>;
  errors: number;
  antibotDetections: number;
  analyzedResponses: number;
  userAgent: string | null;
  isBot: boolean | null;
  identityRequests: number;
  initializationError: string | null;
  closeError: string | null;
}
const botDetector = new BotDetector();
const antibotDetector = new AntibotDetector();

function directClient(client: HttpClient, userAgent: string | null, identityRequests = 0): ProbeClient {
  return {
    userAgent,
    identityRequests,
    send: request => request.method === 'POST'
      ? client.post(request.url, request.body, request.headers)
      : client.get(request.url, request.headers, undefined, 'manual'),
    close: () => client.close(),
  };
}

// La petición de identidad es sólo local; no consume el contador de la URL a probar.
async function observeUserAgent(client: HttpClient): Promise<string | null> {
  const server = createServer((req, res) => res.end(JSON.stringify({ userAgent: req.headers['user-agent'] ?? null })));
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  try {
    const response = await client.get('http://127.0.0.1:' + (server.address() as AddressInfo).port);
    const data = JSON.parse(await response.text());
    return typeof data.userAgent === 'string' ? data.userAgent : null;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  }
}

function redact(value: unknown, key = ''): unknown {
  if (/authorization|cookie|api[-_]?key|token|password|secret|session/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]');
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  }
  return value;
}
function safeURL(value: string): string {
  const url = new URL(value);
  if (url.username) url.username = '[REDACTED]';
  if (url.password) url.password = '[REDACTED]';
  for (const key of [...url.searchParams.keys()]) {
    if (/token|key|secret|password|authorization/i.test(key)) url.searchParams.set(key, '[REDACTED]');
  }
  return url.href;
}
function bodyValue(body: string): unknown {
  try { return JSON.parse(body); } catch { return body; }
}
function errorMessage(error: unknown): string {
  const message = String(redact(error instanceof Error ? error.message : String(error)));
  return message.replace(/https?:\/\/[^\s\x22'<>]+/gi, value => {
    try { return safeURL(value); } catch { return '[URL REDACTED]'; }
  });
}
async function save(file: string, value: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(redact(value), null, 2), { mode: 0o600 });
}
function logIdentity(client: string, userAgent: string | null, log: (...args: unknown[]) => void) {
  log('------');
  log('Agente:', client);
  log('User-Agent:', userAgent ?? 'desconocido: el cliente no lo expone');
  log('isbot:', userAgent === null ? 'desconocido' : botDetector.check(userAgent));
}

export async function runCheck(config: CheckConfig, log: (...args: unknown[]) => void = console.log) {
  const { request, clients, requestsPerClient, reportEvery } = config;
  if (!request.url) throw new Error('Configura la URL en GET_REQUEST o POST_REQUEST al inicio de src/check-bot.ts.');
  const url = new URL(request.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('La URL debe utilizar HTTP o HTTPS.');
  if (!['GET', 'POST'].includes(request.method)) throw new Error('El método debe ser GET o POST.');
  if (![requestsPerClient, reportEvery].every(value => Number.isInteger(value) && value > 0)) {
    throw new Error('REQUESTS_PER_CLIENT y REPORT_EVERY deben ser enteros positivos.');
  }
  if (!clients.length || new Set(clients).size !== clients.length || clients.some(name => !Object.hasOwn(AVAILABLE_CLIENTS, name))) {
    throw new Error('Selecciona clientes disponibles sin repetir: ' + Object.keys(AVAILABLE_CLIENTS).join(', '));
  }
  const directory = await mkdtemp(join(tmpdir(), 'client-bot-'));
  await save(join(directory, 'request.json'), { ...request, url: safeURL(request.url) });
  const summary = { directory, clients: [] as ClientSummary[] };
  log('------');
  log('URL a probar:', safeURL(request.url));
  log('Método:', request.method);
  log('Has antibot: pendiente; se comprobará en las respuestas contadas.');
  log('Clientes disponibles:', Object.keys(AVAILABLE_CLIENTS).join(', '));
  log('Clientes seleccionados:', clients.join(', '));
  log('Peticiones por cliente:', requestsPerClient, '| Reportar cada:', reportEvery);
  log('Resultados temporales:', directory);

  for (const name of clients) {
    const folder = join(directory, name);
    await mkdir(folder);
    const stats: ClientSummary = {
      client: name, requested: requestsPerClient, attempted: 0,
      statusCounts: {}, errors: 0, antibotDetections: 0, analyzedResponses: 0,
      userAgent: null, isBot: null, identityRequests: 0,
      initializationError: null, closeError: null,
    };
    summary.clients.push(stats);
    let client: ProbeClient;
    try {
      const createClient: (request: ProbeRequest) => Promise<ProbeClient> = AVAILABLE_CLIENTS[name];
      client = await createClient(request);
      stats.userAgent = client.userAgent;
      stats.isBot = client.userAgent === null ? null : botDetector.check(client.userAgent);
      stats.identityRequests = client.identityRequests;
      logIdentity(name, stats.userAgent, log);
      if (stats.identityRequests) log('Peticiones locales de identidad (fuera del conteo al destino):', stats.identityRequests);
    } catch (error) {
      stats.initializationError = errorMessage(error);
      stats.errors++;
      log('Error al iniciar', name + ':', stats.initializationError);
      await save(join(folder, 'init-error.json'), stats);
      continue;
    }
    try {
      for (let attempt = 1; attempt <= requestsPerClient; attempt++) {
        const started = performance.now();
        const result = {
          client: name, attempt, startedAt: new Date().toISOString(), durationMs: 0,
          status: null as number | null, userAgent: stats.userAgent, isBot: stats.isBot,
          headers: {} as Record<string, string>, body: null as unknown,
          antibot: null as ReturnType<AntibotDetector['check']> | null,
          error: null as string | null,
        };
        stats.attempted++;
        try {
          const response = await client.send(request);
          result.status = response.status;
          stats.statusCounts[response.status] = (stats.statusCounts[response.status] ?? 0) + 1;
          const headers = new Headers();
          for (const [key, value] of response.headers) headers.append(key, value);
          result.headers = Object.fromEntries(headers);
          result.antibot = antibotDetector.check({ statusCode: response.status, headers, url: request.url });
          if (response.userAgent !== undefined && response.userAgent !== stats.userAgent) {
            stats.userAgent = response.userAgent;
            stats.isBot = response.userAgent === null ? null : botDetector.check(response.userAgent);
            logIdentity(name, stats.userAgent, log);
          }
          result.userAgent = stats.userAgent;
          result.isBot = stats.isBot;
          const text = await response.text();
          result.body = bodyValue(text);
          result.antibot = antibotDetector.check({ statusCode: response.status, headers, html: text, url: request.url });

        } catch (error) {
          result.error = errorMessage(error);
          stats.errors++;
        }
        if (result.antibot) {
          stats.analyzedResponses++;
          if (result.antibot.detected) stats.antibotDetections++;
        }
        result.durationMs = Math.round(performance.now() - started);
        await save(join(folder, String(attempt).padStart(6, '0') + '.json'), result);
        if (attempt % reportEvery === 0 || attempt === requestsPerClient) {
          log('[' + name + '] ' + attempt + '/' + requestsPerClient,
            '| status:', result.status ?? 'sin respuesta', '| has antibot:', result.antibot?.detected ?? 'desconocido',
            '| ms:', result.durationMs, ...(result.error ? ['| error:', result.error] : []));
          }
          log('Reporte ' + name + ' ' + attempt + '/' + requestsPerClient);
          log('Status:', JSON.stringify(stats.statusCounts), '| errores:', stats.errors, '| respuestas con antibot:', stats.antibotDetections);
        }
    } finally {
      try { await client.close(); }
      catch (error) { stats.closeError = errorMessage(error); log('Error al cerrar', name + ':', stats.closeError); }
    }
  }

  log('------');
  log('Resumen final');
  for (const stats of summary.clients) {
    log(stats.client + ':', stats.attempted + '/' + stats.requested,
      '| status:', JSON.stringify(stats.statusCounts), '| errores:', stats.errors,
      '| has antibot:', stats.analyzedResponses ? stats.antibotDetections > 0 : 'desconocido',
      '| detecciones:', stats.antibotDetections);
  }
  log('isbot sólo analiza el User-Agent; has antibot=false significa que no se encontraron señales conocidas.');
  log('Resultados temporales:', directory);
  await save(join(directory, 'summary.json'), summary);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCheck({
    request: REQUEST_TO_USE, clients: CLIENTS_TO_USE,
    requestsPerClient: REQUESTS_PER_CLIENT, reportEvery: REPORT_EVERY,
  }).then(summary => {
    if (summary.clients.some(client => client.errors > 0 || client.closeError)) process.exitCode = 1;
  }).catch(error => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
