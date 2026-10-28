import { randomInt } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export interface UtlsClientOptions {
  profile?: 'chrome' | 'firefox' | 'safari' | 'ios';
  headers?: Record<string, string>;
  timeoutMs?: number;
  binaryPath?: string;
  caFile?: string;
}

// Versiones de los perfiles Auto de uTLS v1.8.2 usados por native/utls/transport.go.
// https://github.com/refraction-networking/utls/blob/v1.8.2/u_common.go
const PROFILE_USER_AGENTS: Record<NonNullable<UtlsClientOptions['profile']>, string> = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
};

interface WorkerResponse {
  ready?: boolean;
  id: number;
  error?: string;
  status: number;
  headers?: Record<string, string[]>;
  body?: string;
  url: string;
  protocol: string;
}

export class UtlsClient {
  readonly profile: NonNullable<UtlsClientOptions['profile']>;
  readonly headers: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly binaryPath: string;
  private readonly caFile?: string;
  private worker?: ChildProcessWithoutNullStreams;
  private startup?: Promise<void>;
  private exited?: Promise<void>;
  private closing?: Promise<void>;
  private failure?: Error;
  private readonly shutdown = new AbortController();
  private sequence = 0;
  private readonly pending = new Map<number, {
    resolve: (response: WorkerResponse) => void;
    reject: (error: Error) => void;
  }>();

  constructor({ profile = 'chrome', headers = {}, timeoutMs = 20_000, binaryPath, caFile }: UtlsClientOptions = {}) {
    if (!['chrome', 'firefox', 'safari', 'ios'].includes(profile)) throw new Error('Perfil uTLS no soportado.');
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new Error('timeoutMs debe ser un entero positivo de hasta 2147483647.');
    }
    this.profile = profile;
    this.timeoutMs = timeoutMs;
    this.caFile = caFile;
    const initialHeaders = new Headers({ 'user-agent': 'utls-client/1.0' });
    for (const [name, value] of Object.entries(headers)) initialHeaders.set(name, value);
    this.headers = Object.freeze(Object.fromEntries(initialHeaders));
    const localBinary = fileURLToPath(new URL('../../bin/utls-worker', import.meta.url));
    this.binaryPath = binaryPath ?? (existsSync(localBinary) ? localBinary : process.env.UTLS_BINARY_PATH ?? '/usr/local/bin/utls-worker');
  }

  /** Sin opciones escoge otro perfil y su User-Agent; siempre termina el worker anterior. */
  async changeProfile(options?: UtlsClientOptions): Promise<UtlsClient> {
    if (options === undefined) {
      const profiles = (Object.keys(PROFILE_USER_AGENTS) as Array<NonNullable<UtlsClientOptions['profile']>>).filter(value => value !== this.profile);
      const profile = profiles[randomInt(profiles.length)]!;
      options = { profile, headers: { 'User-Agent': PROFILE_USER_AGENTS[profile] } };
    }
    const next = new UtlsClient(options);
    await this.close();
    return next;
  }

  get processId(): number | undefined {
    return this.worker?.pid;
  }

  async ready(): Promise<void> {
    this.ensureOpen();
    this.startup ??= this.start();
    await this.startup;
    this.ensureOpen();
  }

  get(url: string, headers: Record<string, string> = {}, signal?: AbortSignal, redirect: 'follow' | 'manual' | 'error' = 'follow') {
    return this.request('GET', url, undefined, headers, signal, redirect);
  }

  post(url: string, body: unknown, headers: Record<string, string> = {}, redirect: 'follow' | 'manual' | 'error' = 'follow') {
    return this.request('POST', url, JSON.stringify(body), headers, undefined, redirect);
  }

  close(): Promise<void> {
    this.shutdown.abort(new Error('UtlsClient cerrado.'));
    this.closing ??= (async () => {
      if (!this.worker) return;
      this.worker.stdin.end();
      const timer = setTimeout(() => this.worker?.kill('SIGKILL'), 2_000);
      timer.unref();
      try { await this.exited; }
      finally { clearTimeout(timer); }
    })();
    return this.closing;
  }

  private ensureOpen(): void {
    this.shutdown.signal.throwIfAborted();
    if (this.failure) throw this.failure;
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['-profile', this.profile, '-timeout-ms', String(this.timeoutMs)];
      if (this.caFile) args.push('-ca-file', this.caFile);
      const worker = spawn(this.binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      this.worker = worker;
      const startupTimer = setTimeout(() => {
        const error = new Error('Timeout al iniciar el worker uTLS.');
        this.fail(error); reject(error); worker.kill('SIGKILL');
      }, 10_000);
      startupTimer.unref();
      const lines = createInterface({ input: worker.stdout });
      lines.on('line', line => {
        try {
          const message: WorkerResponse = JSON.parse(line);
          if (message.ready === true) { clearTimeout(startupTimer); resolve(); return; }
          const pending = this.pending.get(message.id);
          if (!pending) return;
          if (message.error) pending.reject(new Error(message.error));
          else pending.resolve(message);
        } catch {
          const error = new Error('Respuesta inválida del worker uTLS.');
          this.fail(error); reject(error); worker.kill('SIGKILL');
        }
      });
      worker.stderr.on('data', chunk => process.stderr.write('[uTLS] ' + chunk.toString()));
      worker.stdin.on('error', error => { this.fail(error); reject(error); });
      worker.on('error', cause => {
        clearTimeout(startupTimer);
        const error = new Error('No se pudo iniciar uTLS. Compila desde WSL con sh scripts/build-utls.sh o configura binaryPath.', { cause });
        this.fail(error); reject(error);
      });
      this.exited = new Promise<void>(done => worker.on('close', (code, signal) => {
        clearTimeout(startupTimer);
        lines.close();
        const error = new Error('El proceso worker uTLS terminó (' + (signal ?? code) + ').');
        if (!this.shutdown.signal.aborted) this.fail(error);
        reject(error);
        done();
      }));
    });
  }

  private write(message: object): void {
    const line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line) >= 16 * 1024 * 1024) throw new Error('La petición supera el límite de 16 MiB.');
    this.worker!.stdin.write(line, error => { if (error) this.fail(error); });
  }

  private async request(method: 'GET' | 'POST', url: string, body: string | undefined, headers: Record<string, string>, signal?: AbortSignal, redirect: 'follow' | 'manual' | 'error' = 'follow') {
    this.ensureOpen();
    signal?.throwIfAborted();
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Solo se admiten URLs HTTP y HTTPS.');
    if (!['follow', 'manual', 'error'].includes(redirect)) throw new Error('Modo de redirección inválido.');
    const combined = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    // Cancelar durante el arranque no cancela el worker que pueden compartir otras peticiones.
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(combined.reason);
      combined.addEventListener('abort', abort, { once: true });
      this.ready().then(resolve, reject).finally(() => combined.removeEventListener('abort', abort));
      if (combined.aborted) abort();
    });
    combined.throwIfAborted();
    this.ensureOpen();
    const requestHeaders = new Headers(this.headers);
    for (const [name, value] of Object.entries(headers)) requestHeaders.set(name, value);
    if (method === 'POST' && !requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json');
    const id = ++this.sequence;
    const message = await new Promise<WorkerResponse>((resolve, reject) => {
      const finish = () => {
        this.pending.delete(id);
        combined.removeEventListener('abort', abort);
      };
      const abort = () => {
        finish(); reject(combined.reason);
        if (this.worker?.stdin.writable) {
          try { this.write({ type: 'cancel', id }); } catch { /* El worker ya terminó. */ }
        }
      };
      this.pending.set(id, {
        resolve: response => { finish(); resolve(response); },
        reject: error => { finish(); reject(error); },
      });
      combined.addEventListener('abort', abort, { once: true });
      try { this.write({ type: 'request', id, method, url: target.href, headers: Object.fromEntries(requestHeaders), body, redirect }); }
      catch (error) { finish(); reject(error); }
      if (combined.aborted) abort();
    });
    const responseHeaders = new Headers();
    for (const [name, values] of Object.entries(message.headers ?? {})) {
      for (const value of values) responseHeaders.append(name, value);
    }
    const bytes = Buffer.from(message.body ?? '', 'base64');
    const text = bytes.toString('utf8');
    return {
      status: message.status,
      ok: message.status >= 200 && message.status < 300,
      headers: responseHeaders,
      url: message.url,
      httpVersion: message.protocol,
      text: async (): Promise<string> => text,
      json: async (): Promise<unknown> => JSON.parse(text),
    };
  }
}
