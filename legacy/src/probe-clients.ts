import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SofaScore } from './SofaScore.js';
import { TlsClient } from './TlsClient.js';
import { FingerprintClient } from './FingerprintClient.js';
import { ImpersClient } from './ImpersClient.js';

export interface ProbeOptions {
  client: 'tls' | 'fingerprint' | 'impers';
  baseUrl: string;
  requests: number;
  intervalMs: number;
  rotateEvery: number;
  timeoutMs: number;
}

type Counts = {
  attempted: number;
  http200: number;
  http403: number;
  http429: number;
  otherHttp: number;
  otherHttpByStatus: Record<string, number>;
  networkErrors: number;
  timeouts: number;
  cancelled: number;
};
type Event = { id: number; home?: string; away?: string; customId?: string };
type RequestRecord = {
  sequence: number;
  instanceId: number;
  phase: 'discovery' | 'statistics';
  eventId?: number;
  url: string;
  status: number | null;
  latencyMs: number;
  responseBytes?: number;
  retryAfter?: string;
  error?: 'network' | 'timeout' | 'cancelled';
  errorMessage?: string;
};
type Instance = {
  id: number;
  firstRequest: number;
  lastRequest: number;
  userAgent?: string;
  tlsOptions?: TlsClient['tlsOptions'];
  impersonate?: string;
  headers: Readonly<Record<string, string>>;
  counts: Counts;
  closedAt?: string;
  closeError?: string;
};
export interface ProbeReport {
  startedAt: string;
  finishedAt?: string;
  options: ProbeOptions;
  reason: 'completed' | 'discovery_failed' | 'no_events' | 'rate_limited' | 'cancelled' | 'error';
  counts: Counts;
  eventIds: number[];
  instances: Instance[];
  records: RequestRecord[];
  error?: string;
}

export function parseProbeOptions(args: string[]): ProbeOptions {
  const { values } = parseArgs({
    args,
    options: {
      client: { type: 'string', default: 'tls' },
      'base-url': { type: 'string', default: new URL(new SofaScore().getRequest.url).origin },
      requests: { type: 'string', default: '400' },
      'interval-ms': { type: 'string', default: '500' },
      'rotate-every': { type: 'string', default: '50' },
      'timeout-ms': { type: 'string', default: '20000' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values['base-url']) throw new Error('--base-url no puede estar vacío.');
  const baseUrl = new URL(values['base-url']);
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('--base-url debe usar http o https.');
  if (values.client !== 'tls' && values.client !== 'fingerprint' && values.client !== 'impers') throw new Error('--client debe ser tls, fingerprint o impers.');
  function integer(name: 'requests' | 'interval-ms' | 'rotate-every' | 'timeout-ms', minimum: number): number {
    const raw = values[name]!;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum) {
      throw new Error('--' + name + ' debe ser un entero mayor o igual que ' + minimum + '.');
    }
    return value;
  }
  return {
    client: values.client,
    baseUrl: baseUrl.href,
    requests: integer('requests', 1),
    intervalMs: integer('interval-ms', 0),
    rotateEvery: integer('rotate-every', 0),
    timeoutMs: integer('timeout-ms', 1),
  };
}

function newCounts(): Counts {
  return { attempted: 0, http200: 0, http403: 0, http429: 0, otherHttp: 0, otherHttpByStatus: {}, networkErrors: 0, timeouts: 0, cancelled: 0 };
}

function count(counts: Counts, record: RequestRecord): void {
  counts.attempted++;
  if (record.status === 200) counts.http200++;
  else if (record.status === 403) counts.http403++;
  else if (record.status === 429) counts.http429++;
  else if (record.status !== null) {
    counts.otherHttp++;
    counts.otherHttpByStatus[record.status] = (counts.otherHttpByStatus[record.status] ?? 0) + 1;
  }
  // Un error al leer el cuerpo puede coexistir con un estado HTTP ya recibido.
  if (record.error === 'network') counts.networkErrors++;
  else if (record.error === 'timeout') counts.timeouts++;
  else if (record.error === 'cancelled') counts.cancelled++;
}

function readEvents(body: string): Event[] {
  let payload: unknown;
  try { payload = JSON.parse(body); }
  catch { throw new Error('La respuesta de eventos no contiene JSON válido.'); }
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { events?: unknown }).events)) {
    throw new Error('La respuesta no contiene un arreglo events.');
  }
  const ids = new Set<number>();
  const events: Event[] = [];
  for (const raw of (payload as { events: unknown[] }).events) {
    if (!raw || typeof raw !== 'object') continue;
    const event = raw as { id?: unknown; homeTeam?: { slug?: unknown }; awayTeam?: { slug?: unknown }; customId?: unknown };
    if (typeof event.id !== 'number' || !Number.isSafeInteger(event.id) || event.id <= 0 || ids.has(event.id)) continue;
    ids.add(event.id);
    events.push({
      id: event.id,
      home: typeof event.homeTeam?.slug === 'string' ? event.homeTeam.slug : undefined,
      away: typeof event.awayTeam?.slug === 'string' ? event.awayTeam.slug : undefined,
      customId: typeof event.customId === 'string' ? event.customId : undefined,
    });
  }
  return events;
}

function summary(report: ProbeReport): string {
  const c = report.counts;
  const otherDetails = Object.entries(c.otherHttpByStatus)
    .map(([status, total]) => status + ' ' + (STATUS_CODES[Number(status)] ?? 'HTTP') + '=' + total)
    .join(', ');
  return '[' + report.options.client + '] ' + c.attempted + '/' + report.options.requests +
    ' | 200=' + c.http200 + ' | 403=' + c.http403 + ' | 429=' + c.http429 +
    ' | otros=' + c.otherHttp + (otherDetails ? ' [' + otherDetails + ']' : '') +
    ' | red=' + c.networkErrors + ' | timeout=' + c.timeouts;
}

export async function runProbe(
  options: ProbeOptions,
  { signal, log = console.log }: { signal?: AbortSignal; log?: (message: string) => void } = {},
): Promise<ProbeReport> {
  const report: ProbeReport = {
    startedAt: new Date().toISOString(), options: { ...options }, reason: 'completed',
    counts: newCounts(), eventIds: [], instances: [], records: [],
  };
  const sofaScore = new SofaScore();
  let client: TlsClient | FingerprintClient | ImpersClient | undefined;
  let instance: Instance | undefined;
  let events: Event[] = [];
  let nextEvent = 0;
  async function closeClient(): Promise<void> {
    const current = client;
    client = undefined;
    if (!current || !instance) return;
    try {
      await current.close();
      instance.closedAt = new Date().toISOString();
    } catch (error) {
      instance.closeError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  try {
    while (report.counts.attempted < options.requests) {
      if (signal?.aborted) { report.reason = 'cancelled'; break; }
      if (report.counts.attempted > 0 && options.intervalMs > 0) {
        await delay(options.intervalMs, undefined, { signal });
      }
      if (signal?.aborted) { report.reason = 'cancelled'; break; }
      if (!client || (options.rotateEvery > 0 && instance!.counts.attempted >= options.rotateEvery)) {
        await closeClient();
        client = options.client === 'tls' ? new TlsClient() : options.client === 'fingerprint'
          ? new FingerprintClient() : new ImpersClient({ timeoutMs: options.timeoutMs });
        if (client instanceof ImpersClient) await client.ready();
        instance = {
          id: report.instances.length + 1,
          firstRequest: report.counts.attempted + 1,
          lastRequest: report.counts.attempted,
          ...(client instanceof ImpersClient ? { impersonate: client.impersonate } : {
            userAgent: client.userAgent, tlsOptions: { ...client.tlsOptions },
          }),
          headers: { ...client.headers },
          counts: newCounts(),
        };
        report.instances.push(instance);
        log('[' + options.client + '] Instancia ' + instance.id + (instance.impersonate
          ? ' | Perfil nativo: ' + instance.impersonate : ' | User-Agent: ' + instance.userAgent));
      }

      const discovery = report.counts.attempted === 0;
      const event = discovery ? undefined : events[nextEvent++ % events.length]!;
      let referer = new URL('/', options.baseUrl).href;
      if (event?.home && event.away && event.customId) {
        referer = new URL('/football/match/' + encodeURIComponent(event.home + '-' + event.away) +
          '/' + encodeURIComponent(event.customId), options.baseUrl).href;
      }
      const template = discovery ? sofaScore.getRequest : sofaScore.getStatisticsRequest(event!.id, referer);
      const url = new URL(new URL(template.url).pathname, options.baseUrl).href;
      const record: RequestRecord = {
        sequence: report.counts.attempted + 1, instanceId: instance!.id,
        phase: discovery ? 'discovery' : 'statistics',
        ...(event ? { eventId: event.id } : {}),
        url, status: null, latencyMs: 0,
      };
      const timeout = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        timeout.abort(new Error('Tiempo de espera agotado.'));
      }, options.timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
      const startedAt = performance.now();
      let body = '';
      try {
        const response = await client.get(url, { ...template.headers, Referer: referer }, requestSignal, 'manual');
        record.status = response.status;
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter !== null) record.retryAfter = retryAfter;
        body = await response.text();
        record.responseBytes = Buffer.byteLength(body);
      } catch (error) {
        record.error = signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'network';
        record.errorMessage = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer);
        record.latencyMs = Math.round(performance.now() - startedAt);
        report.records.push(record);
        count(report.counts, record);
        count(instance!.counts, record);
        instance!.lastRequest = record.sequence;
      }
      if (report.counts.attempted % 50 === 0) log(summary(report));
      if (record.status === 429) { report.reason = 'rate_limited'; break; }
      if (record.error === 'cancelled' || signal?.aborted) { report.reason = 'cancelled'; break; }
      if (discovery) {
        if (record.error || record.status === null || record.status < 200 || record.status >= 300) {
          report.reason = 'discovery_failed';
          break;
        }
        try {
          events = readEvents(body);
          report.eventIds = events.map(event => event.id);
        } catch (error) {
          report.reason = 'discovery_failed';
          report.error = error instanceof Error ? error.message : String(error);
          break;
        }
        if (events.length === 0) { report.reason = 'no_events'; break; }
      }
    }
  } catch (error) {
    report.reason = signal?.aborted ? 'cancelled' : 'error';
    if (report.reason === 'error') report.error = error instanceof Error ? error.message : String(error);
  } finally {
    try { await closeClient(); }
    catch (error) {
      report.reason = 'error';
      report.error = error instanceof Error ? error.message : String(error);
    }
    report.finishedAt = new Date().toISOString();
  }
  return report;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Uso: pnpm probe:clients [opciones]');
    console.log('--base-url=' + new URL(new SofaScore().getRequest.url).origin + ' (predeterminado)');
    console.log('--client=tls|fingerprint|impers (tls) --requests=400 --interval-ms=500 --rotate-every=50 --timeout-ms=20000');
    console.log('--rotate-every=0 mantiene una instancia. Uso previsto: entorno propio o autorizado.');
    return;
  }
  const options = parseProbeOptions(process.argv.slice(2));
  const controller = new AbortController();
  let signalCode = 130;
  const interrupt = () => { signalCode = 130; controller.abort(); };
  const terminate = () => { signalCode = 143; controller.abort(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const report = await runProbe(options, { signal: controller.signal });
    await mkdir('results', { recursive: true });
    const output = join('results', 'probe-' + options.client + '-' +
      report.startedAt.replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8) + '.json');
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    console.log(summary(report) + ' | fin=' + report.reason);
    if (report.error) console.error('Error:', report.error);
    const limited = report.records.find(record => record.status === 429);
    if (limited) console.log('Retry-After:', limited.retryAfter ?? 'no indicado');
    console.log('Informe:', resolve(output));
    process.exitCode = report.reason === 'completed' ? 0 : report.reason === 'cancelled' ? signalCode : report.reason === 'error' ? 1 : 2;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main().catch(error => {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
