import type { Session, Response as NativeResponse } from 'impers';

export interface ImpersClientOptions {
  impersonate?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class ImpersClient {
  readonly impersonate: string;
  readonly headers: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly shutdown = new AbortController();
  private sessionPromise?: Promise<Session>;
  private closePromise?: Promise<void>;

  constructor({ impersonate = 'safari_ios', headers = {}, timeoutMs = 20_000 }: ImpersClientOptions = {}) {
    if (!impersonate.trim()) throw new Error('El perfil de Impers no puede estar vacío.');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs debe ser positivo.');
    this.impersonate = impersonate;
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
    const response: NativeResponse = await session.request(method, url, {
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
