import { STATUS_CODES } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { TlsClient } from '../TlsClient.js';
import { FingerprintClient } from '../FingerprintClient.js';
import { ImpersClient } from '../ImpersClient.js';
import { startMockServer, type MockServerOptions } from './server.js';

export interface MockOptions extends MockServerOptions {
  client: 'tls' | 'fingerprint' | 'impers';
  maxInstances: number;
  intervalMs: number;
  timeoutMs: number;
}
type MockAttempt = {
  instanceId: number;
  url: string;
  userAgent?: string;
  impersonate?: string;
  status: number | null;
  latencyMs: number;
  closedAt?: string;
  error?: 'timeout' | 'network' | 'cancelled';
};
export interface MockReport {
  mode: 'local-mock';
  options: MockOptions;
  startedAt: string;
  finishedAt?: string;
  mockBaseUrl: string;
  mockServerClosed: boolean;
  reason: 'success' | 'max_instances' | 'cancelled' | 'error';
  counts: {
    attempted: number;
    http200: number;
    http403: number;
    http429: number;
    otherHttp: number;
    timeouts: number;
    networkErrors: number;
    cancelled: number;
  };
  attempts: MockAttempt[];
  error?: string;
}

function validate(options: MockOptions): MockOptions {
  if (options.client !== 'tls' && options.client !== 'fingerprint' && options.client !== 'impers') throw new Error('--client debe ser tls, fingerprint o impers.');
  if (!['403', '429', 'mixed'].includes(options.blockStatus)) throw new Error('--block-status debe ser 403, 429 o mixed.');
  const ranges: [string, number, number, number][] = [
    ['max-instances', options.maxInstances, 1, 10],
    ['blocked-instances', options.blockedInstances, 0, 10],
    ['interval-ms', options.intervalMs, 0, 2_147_483_647],
    ['timeout-ms', options.timeoutMs, 1, 2_147_483_647],
  ];
  for (const [name, value, min, max] of ranges) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error('--' + name + ' debe ser un entero entre ' + min + ' y ' + max + '.');
    }
  }
  return options;
}

export function parseMockOptions(args: string[]): MockOptions {
  const { values } = parseArgs({
    args,
    options: {
      client: { type: 'string', default: 'tls' },
      'max-instances': { type: 'string', default: '10' },
      'blocked-instances': { type: 'string', default: '3' },
      'block-status': { type: 'string', default: 'mixed' },
      'interval-ms': { type: 'string', default: '500' },
      'timeout-ms': { type: 'string', default: '20000' },
    },
    strict: true,
    allowPositionals: false,
  });
  function integer(name: 'max-instances' | 'blocked-instances' | 'interval-ms' | 'timeout-ms'): number {
    const value = values[name]!;
    if (!/^\d+$/.test(value)) throw new Error('--' + name + ' debe ser un entero.');
    return Number(value);
  }
  return validate({
    client: values.client as MockOptions['client'],
    maxInstances: integer('max-instances'),
    blockedInstances: integer('blocked-instances'),
    blockStatus: values['block-status'] as MockOptions['blockStatus'],
    intervalMs: integer('interval-ms'),
    timeoutMs: integer('timeout-ms'),
  });
}

export async function runMockProbe(
  input: MockOptions,
  { signal, log = console.log }: { signal?: AbortSignal; log?: (message: string) => void } = {},
): Promise<MockReport> {
  const options = { ...validate(input) };
  const report: MockReport = {
    mode: 'local-mock', options, startedAt: new Date().toISOString(),
    mockBaseUrl: '', mockServerClosed: false, reason: 'max_instances',
    counts: { attempted: 0, http200: 0, http403: 0, http429: 0, otherHttp: 0, timeouts: 0, networkErrors: 0, cancelled: 0 },
    attempts: [],
  };
  let mockServer: Awaited<ReturnType<typeof startMockServer>> | undefined;

  try {
    mockServer = await startMockServer(options);
    report.mockBaseUrl = mockServer.baseUrl;
    const url = mockServer.requestUrl;
    log('[Mock local] ' + report.mockBaseUrl + ' | máximo ' + options.maxInstances + ' instancias');

    for (let instanceId = 1; instanceId <= options.maxInstances; instanceId++) {
      if (signal?.aborted) { report.reason = 'cancelled'; break; }
      if (instanceId > 1 && options.intervalMs > 0) {
        await delay(options.intervalMs, undefined, { signal });
      }
      if (signal?.aborted) { report.reason = 'cancelled'; break; }
      const client = options.client === 'tls' ? new TlsClient() : options.client === 'fingerprint'
        ? new FingerprintClient() : new ImpersClient({ timeoutMs: options.timeoutMs });
      if (client instanceof ImpersClient) await client.ready();
      const attempt: MockAttempt = {
        instanceId, url, status: null, latencyMs: 0,
        ...(client instanceof ImpersClient ? { impersonate: client.impersonate } : { userAgent: client.userAgent }),
      };
      report.attempts.push(attempt);
      report.counts.attempted++;
      const timeout = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        timeout.abort(new Error('Tiempo de espera agotado.'));
      }, options.timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
      const started = performance.now();
      try {
        const response = await client.get(url, { accept: 'application/json' }, requestSignal, 'manual');
        attempt.status = response.status;
        await response.text();
      } catch {
        attempt.error = signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'network';
      } finally {
        clearTimeout(timer);
        attempt.latencyMs = Math.round(performance.now() - started);
        if (attempt.status === 200) report.counts.http200++;
        else if (attempt.status === 403) report.counts.http403++;
        else if (attempt.status === 429) report.counts.http429++;
        else if (attempt.status !== null) report.counts.otherHttp++;
        if (attempt.error === 'timeout') report.counts.timeouts++;
        else if (attempt.error === 'network') report.counts.networkErrors++;
        else if (attempt.error === 'cancelled') report.counts.cancelled++;
        await client.close();
        attempt.closedAt = new Date().toISOString();
      }
      const status = attempt.status === null ? 'sin respuesta' :
        'HTTP ' + attempt.status + ' ' + (STATUS_CODES[attempt.status] ?? '');
      log('[Mock][' + options.client + '] Instancia ' + instanceId + '/' + options.maxInstances +
        ' | ' + status + (attempt.error ? ' | ' + attempt.error : ''));
      if (attempt.error) {
        report.reason = attempt.error === 'cancelled' ? 'cancelled' : 'error';
        break;
      }
      if (attempt.status === 200) { report.reason = 'success'; break; }
      if (attempt.status !== 403 && attempt.status !== 429) { report.reason = 'error'; break; }
      if (instanceId < options.maxInstances) log('[Mock] Nueva instancia; se repetirá la misma petición local.');
    }
  } catch (error) {
    report.reason = signal?.aborted ? 'cancelled' : 'error';
    if (report.reason === 'error') report.error = error instanceof Error ? error.message : String(error);
  } finally {
    await mockServer?.close();
    report.mockServerClosed = mockServer?.closed ?? true;
    report.finishedAt = new Date().toISOString();
  }
  return report;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Uso: pnpm probe:mock [opciones]. Siempre utiliza un servidor 127.0.0.1 creado por el script.');
    console.log('--client=tls|fingerprint|impers (tls) --blocked-instances=3 --max-instances=10 --block-status=mixed|403|429');
    console.log('--interval-ms=500 --timeout-ms=20000. Las 10 instancias incluyen el intento inicial.');
    return;
  }
  const options = parseMockOptions(process.argv.slice(2));
  const controller = new AbortController();
  let signalCode = 130;
  const interrupt = () => { signalCode = 130; controller.abort(); };
  const terminate = () => { signalCode = 143; controller.abort(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const report = await runMockProbe(options, { signal: controller.signal });
    await mkdir('results', { recursive: true });
    const output = join('results', 'mock-probe-' + options.client + '-' +
      report.startedAt.replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8) + '.json');
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    const c = report.counts;
    console.log('[Mock] fin=' + report.reason + ' | instancias=' + c.attempted +
      ' | 200=' + c.http200 + ' | 403=' + c.http403 + ' | 429=' + c.http429);
    if (report.error) console.error('Error:', report.error);
    console.log('Informe:', resolve(output));
    process.exitCode = report.reason === 'success' ? 0 : report.reason === 'cancelled' ? signalCode : report.reason === 'max_instances' ? 2 : 1;
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
