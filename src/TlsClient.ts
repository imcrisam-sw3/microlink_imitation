import { Agent, Headers, fetch } from 'undici';
import uniqueRandomArray from 'unique-random-array';
import userAgents from 'top-user-agents';
import tls from 'https-tls';

const randomUserAgent = uniqueRandomArray(userAgents);

export class TlsClient {
  readonly userAgent: string;
  readonly tlsOptions: ReturnType<typeof tls>;
  readonly headers: Readonly<Record<string, string>>;
  private readonly agent: Agent;

  constructor(userAgent = randomUserAgent(), headers: Record<string, string> = {}) {
    if (!userAgent) throw new Error('No se pudo obtener un User-Agent.');
    this.userAgent = userAgent;
    this.headers = Object.freeze({ ...headers });
    this.tlsOptions = tls(userAgent);
    this.agent = new Agent({ connect: { ...this.tlsOptions } });
  }

  get(url: string, headers: Record<string, string> = {}) {
    return fetch(url, {
      method: 'GET',
      dispatcher: this.agent,
      headers: this.requestHeaders(headers),
    });
  }

  post(url: string, body: unknown, headers: Record<string, string> = {}) {
    const requestHeaders = this.requestHeaders(headers);
    if (!requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json');
    return fetch(url, {
      method: 'POST',
      dispatcher: this.agent,
      headers: requestHeaders,
      body: JSON.stringify(body),
    });
  }

  close() {
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
