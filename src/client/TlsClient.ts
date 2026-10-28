import { randomInt } from 'node:crypto';
import { Agent, Headers, fetch } from 'undici';
import uniqueRandomArray from 'unique-random-array';
import userAgents from 'top-user-agents';
import tls from 'https-tls';

const randomUserAgent = uniqueRandomArray(userAgents);

export class TlsClient {
  readonly userAgent: string;
  readonly tlsOptions: Omit<ReturnType<typeof tls>, 'signatureAlgorithms'> & { sigalgs?: string };
  readonly headers: Readonly<Record<string, string>>;
  private readonly agent: Agent;

  constructor(userAgent = randomUserAgent(), headers: Record<string, string> = {}) {
    if (!userAgent) throw new Error('No se pudo obtener un User-Agent.');
    this.userAgent = userAgent;
    this.headers = Object.freeze({ ...headers });
    const { signatureAlgorithms, ...tlsOptions } = tls(userAgent);
    // https-tls usa el nombre de Got; Node/Undici reconoce sigalgs.
    this.tlsOptions = { ...tlsOptions, sigalgs: signatureAlgorithms };
    this.agent = new Agent({ connect: { ...this.tlsOptions } });
  }

  /** Sin User-Agent elige otra familia TLS; siempre devuelve una instancia limpia. */
  async changeProfile(userAgent?: string, headers: Record<string, string> = {}): Promise<TlsClient> {
    if (userAgent === undefined) {
      const browser = tls.getBrowser(this.userAgent);
      const candidates = userAgents.filter(value => tls.getBrowser(value) !== browser);
      if (!candidates.length) throw new Error('No hay otro perfil TLS disponible.');
      userAgent = candidates[randomInt(candidates.length)]!;
    }
    const next = new TlsClient(userAgent, headers);
    await this.agent.destroy(new Error('Perfil reemplazado.'));
    return next;
  }

  get(
    url: string,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
    redirect: 'follow' | 'manual' | 'error' = 'follow',
  ) {
    return fetch(url, {
      method: 'GET',
      dispatcher: this.agent,
      headers: this.requestHeaders(headers),
      signal,
      redirect,
    });
  }

  post(url: string, body: unknown, headers: Record<string, string> = {}, redirect: 'follow' | 'manual' | 'error' = 'follow') {
    const requestHeaders = this.requestHeaders(headers);
    if (!requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json');
    return fetch(url, {
      method: 'POST',
      dispatcher: this.agent,
      headers: requestHeaders,
      body: JSON.stringify(body),
      redirect,
    });
  }

  close() {
    if (this.agent.destroyed) return Promise.resolve();
    return this.agent.close();
  }

  private requestHeaders(headers: Record<string, string>) {
    const merged = new Headers(this.headers);
    for (const [name, value] of Object.entries(headers)) merged.set(name, value);
    // La instancia mantiene el mismo User-Agent usado para configurar su TLS.
    merged.set('user-agent', this.userAgent);
    return merged;
  }
}
