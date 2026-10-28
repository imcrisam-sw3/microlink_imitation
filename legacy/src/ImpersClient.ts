import type { Session, RequestOptions, Response as NativeResponse } from 'impers';

export interface ImpersClientOptions {
  impersonate?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  headerMode?: 'profile' | 'provided';
}

export class ImpersClient {
  readonly impersonate: string;
  readonly headerMode: 'profile' | 'provided';
  readonly headers: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly shutdown = new AbortController();
  private sessionPromise?: Promise<Session>;
  private closePromise?: Promise<void>;

  constructor({ impersonate = 'safari_ios', headers = {}, timeoutMs = 20_000, headerMode = 'profile' }: ImpersClientOptions = {}) {
    if (!impersonate.trim()) throw new Error('El perfil de Impers no puede estar vacío.');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs debe ser positivo.');
    if (headerMode !== 'profile' && headerMode !== 'provided') throw new Error('headerMode debe ser profile o provided.');
    this.impersonate = impersonate;
    this.headerMode = headerMode;
    this.timeoutMs = timeoutMs;
    this.headers = Object.freeze(Object.fromEntries(this.requestHeaders(headers)));
  }

  async ready(): Promise<void> {
    this.ensureOpen();
    this.sessionPromise ??= import('impers').then(({ Session, Curl }) => {
      this.ensureOpen();
      if (!Curl.hasImpersonateSupport()) {
        throw new Error('Impers requiere curl-impersonate; la libcurl cargada no admite impersonación.');
      }
      return new Session({
        impersonate: this.impersonate,
        timeout: this.timeoutMs / 1000,
        maxConnections: 1,
        verify: true,
        defaultHeaders: this.headerMode === 'profile',
      });
    });
    await this.sessionPromise;
    this.ensureOpen();
  }

  get(
    url: string,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
    redirect: 'follow' | 'manual' | 'error' = 'follow',
  ) {
    return this.request('GET', url, undefined, headers, signal, redirect);
  }

  post(url: string, body: unknown, headers: Record<string, string> = {}) {
    return this.request('POST', url, body, headers);
  }

  close(): Promise<void> {
    this.shutdown.abort(new Error('ImpersClient cerrado.'));
    this.closePromise ??= (async () => {
      const session = await this.sessionPromise?.catch(() => undefined);
      await session?.close();
    })();
    return this.closePromise;
  }

  private ensureOpen(): void {
    if (this.shutdown.signal.aborted) throw new Error('ImpersClient cerrado.');
  }

  private requestHeaders(headers: Record<string, string>): Headers {
    const merged = new Headers(this.headers);
    for (const [name, value] of Object.entries(headers)) merged.set(name, value);
    if (this.headerMode === 'provided') {
      // Conserva el UA de referencia como hacen TlsClient y FingerprintClient.
      const userAgent = this.headers?.['user-agent'];
      if (userAgent) merged.set('user-agent', userAgent);
      return merged;
    }
    // El perfil nativo aporta su identidad; no se mezclan UAs ni Client Hints ajenos.
    for (const name of [...merged.keys()]) {
      if (name === 'user-agent' || name.startsWith('sec-ch-ua')) merged.delete(name);
    }
    return merged;
  }

  private async request(
    method: 'GET' | 'POST',
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
    redirect: 'follow' | 'manual' | 'error' = 'follow',
  ) {
    this.ensureOpen();
    signal?.throwIfAborted();
    await this.ready();
    const session = await this.sessionPromise!;
    this.ensureOpen();
    const requestHeaders = this.requestHeaders(headers);
    if (method === 'POST' && !requestHeaders.has('content-type')) {
      requestHeaders.set('content-type', 'application/json');
    }
    const nativeOptions: Partial<RequestOptions> = {};
    if (this.headerMode === 'provided') {
      const { CurlOpt } = await import('impers');
      // curl descomprime también zstd; evita descomprimir de nuevo en el SDK.
      nativeOptions.decodeContent = false;
      nativeOptions.curlOptions = {
        [CurlOpt.ACCEPT_ENCODING]: requestHeaders.get('accept-encoding') ?? 'gzip, deflate, br',
      };
    }
    const response: NativeResponse = await session.request(method, url, {
      ...nativeOptions,
      headers: Object.fromEntries(requestHeaders),
      ...(method === 'POST' ? { content: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal,
      allowRedirects: redirect === 'follow',
    });
    if (redirect === 'error' && [301, 302, 303, 307, 308].includes(response.status)) {
      throw new Error('La petición devolvió una redirección con redirect=error.');
    }
    // Impers entrega el cuerpo completo y text es una propiedad, no un método.
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      text: async (): Promise<string> => response.text,
      json: async (): Promise<unknown> => response.json(),
    };
  }
}
