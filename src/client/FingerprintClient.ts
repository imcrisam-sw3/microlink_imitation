import { FingerprintGenerator, type FingerprintGeneratorOptions, type Fingerprint } from 'fingerprint-generator';
import { Agent, Headers, fetch } from 'undici';
import tls from 'https-tls';

export class FingerprintClient {
  readonly fingerprint: Fingerprint;
  readonly userAgent: string;
  readonly tlsOptions: Omit<ReturnType<typeof tls>, 'signatureAlgorithms'> & { sigalgs?: string };
  readonly headers: Readonly<Record<string, string>>;
  private readonly agent: Agent;

  constructor(options: Partial<Omit<FingerprintGeneratorOptions, 'httpVersion'>> = {}) {
    const generator = new FingerprintGenerator({
      operatingSystems: ['ios'],
      devices: ['mobile'],
      ...options,
      // Esto configura los headers del generador; el transporte negocia HTTP por separado.
      httpVersion: '1',
    });
    const { fingerprint, headers } = generator.getFingerprint();
    const userAgent = headers['user-agent'] ?? headers['User-Agent'];
    if (!userAgent) throw new Error('El fingerprint generado no incluye User-Agent.');
    this.userAgent = userAgent;
    this.headers = Object.freeze({ ...headers });
    this.fingerprint = fingerprint;
    const { signatureAlgorithms, ...tlsOptions } = tls(userAgent);
    this.tlsOptions = { ...tlsOptions, sigalgs: signatureAlgorithms };
    this.agent = new Agent({ connect: { ...this.tlsOptions } });
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
    // Mantiene el User-Agent asociado a los encabezados de este fingerprint.
    merged.set('user-agent', this.userAgent);
    return merged;
  }
}
