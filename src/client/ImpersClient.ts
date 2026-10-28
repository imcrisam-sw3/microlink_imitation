import { randomInt } from 'node:crypto';
import type { Session, RequestOptions, Response as NativeResponse } from 'impers';

export interface ImpersClientOptions {
  impersonate?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxConnections?: number;
  headerMode?: 'profile' | 'provided';
  httpsTlsUserAgent?: string;
}

export class ImpersClient {
  readonly impersonate: string;
  readonly maxConnections: number;
  readonly httpsTlsUserAgent?: string;
  readonly headerMode: 'profile' | 'provided';
  readonly headers: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly shutdown = new AbortController();
  private sessionPromise?: Promise<Session>;
  private tlsCurlOptions?: RequestOptions['curlOptions'];
  private closePromise?: Promise<void>;

  constructor({ impersonate = 'safari_ios', headers = {}, timeoutMs = 20_000, headerMode = 'profile', httpsTlsUserAgent, maxConnections = 1 }: ImpersClientOptions = {}) {
    if (!impersonate.trim()) throw new Error('El perfil de Impers no puede estar vacío.');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs debe ser positivo.');
    if (headerMode !== 'profile' && headerMode !== 'provided') throw new Error('headerMode debe ser profile o provided.');
    if (httpsTlsUserAgent !== undefined && (typeof httpsTlsUserAgent !== 'string' || !httpsTlsUserAgent.trim())) {
      throw new Error('httpsTlsUserAgent debe ser un User-Agent no vacío.');
    }
    if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 2_147_483_647) {
      throw new Error('maxConnections debe ser un entero positivo de hasta 2147483647.');
    }
    this.maxConnections = maxConnections;
    this.httpsTlsUserAgent = httpsTlsUserAgent;
    this.impersonate = impersonate;
    this.headerMode = headerMode;
    this.timeoutMs = timeoutMs;
    this.headers = Object.freeze(Object.fromEntries(this.requestHeaders(headers)));
  }

  /** Sin opciones escoge otro navegador del catálogo nativo, sin heredar la sesión. */
  async changeProfile(options?: ImpersClientOptions): Promise<ImpersClient> {
    if (options === undefined) {
      const { NATIVE_IMPERSONATE_TARGETS } = await import('impers');
      const browser = this.impersonate.match(/^[a-z]+/i)?.[0]?.toLowerCase();
      const candidates = NATIVE_IMPERSONATE_TARGETS.filter(value => value.browser.toLowerCase() !== browser);
      if (!candidates.length) throw new Error('No hay otro perfil nativo disponible.');
      options = { impersonate: candidates[randomInt(candidates.length)]!.target_name, maxConnections: this.maxConnections };
    }
    const next = new ImpersClient(options);
    await this.close();
    return next;
  }

  async ready(): Promise<void> {
    this.ensureOpen();
    this.sessionPromise ??= import('impers').then(async ({ Session, Curl, CurlOpt, CurlSslVersion }) => {
      this.ensureOpen();
      if (!Curl.hasImpersonateSupport()) {
        throw new Error('Impers requiere curl-impersonate; la libcurl cargada no admite impersonación.');
      }
      if (this.httpsTlsUserAgent) {
        const { default: tls } = await import('https-tls');
        this.ensureOpen();
        const { ciphers, signatureAlgorithms, ecdhCurve, minVersion, maxVersion } = tls(this.httpsTlsUserAgent);
        const versions: Record<string, number> = {
          TLSv1: CurlSslVersion.CURL_SSLVERSION_TLSv1_0,
          'TLSv1.1': CurlSslVersion.CURL_SSLVERSION_TLSv1_1,
          'TLSv1.2': CurlSslVersion.CURL_SSLVERSION_TLSv1_2,
          'TLSv1.3': CurlSslVersion.CURL_SSLVERSION_TLSv1_3,
        };
        const minimum = minVersion && versions[minVersion];
        const maximum = maxVersion && versions[maxVersion];
        if (!ciphers || !signatureAlgorithms || !ecdhCurve || !minimum || !maximum) {
          throw new Error('https-tls devolvió una configuración TLS incompleta o no soportada.');
        }
        const signatureAliases: Record<string, string> = { 'ECDSA+SHA1': 'ecdsa_sha1', 'RSA+SHA1': 'rsa_pkcs1_sha1' };
        this.tlsCurlOptions = {
          // curl-impersonate admite la lista conjunta de cifrados TLS 1.2/1.3.
          [CurlOpt.SSL_CIPHER_LIST]: ciphers,
          [CurlOpt.SSL_SIG_HASH_ALGS]: signatureAlgorithms.split(':').map(name => signatureAliases[name] ?? name).join(','),
          [CurlOpt.SSL_EC_CURVES]: ecdhCurve,
          // libcurl codifica el máximo en los 16 bits superiores.
          [CurlOpt.SSLVERSION]: minimum | (maximum << 16),
        };
      }
      return new Session({
        impersonate: this.impersonate,
        timeout: this.timeoutMs / 1000,
        maxConnections: this.maxConnections,
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

  post(url: string, body: unknown, headers: Record<string, string> = {}, redirect: 'follow' | 'manual' | 'error' = 'follow') {
    return this.request('POST', url, body, headers, undefined, redirect);
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
    } else {
      // El perfil nativo aporta su identidad; no se mezclan UAs ni Client Hints ajenos.
      for (const name of [...merged.keys()]) {
        if (name === 'user-agent' || name.startsWith('sec-ch-ua')) merged.delete(name);
      }
    }
    if (this.httpsTlsUserAgent) merged.set('user-agent', this.httpsTlsUserAgent);
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
    const nativeOptions: Partial<RequestOptions> = this.tlsCurlOptions ? { curlOptions: this.tlsCurlOptions } : {};
    if (this.headerMode === 'provided') {
      const { CurlOpt } = await import('impers');
      // curl descomprime también zstd; evita descomprimir de nuevo en el SDK.
      nativeOptions.decodeContent = false;
      nativeOptions.curlOptions = {
        ...this.tlsCurlOptions,
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
