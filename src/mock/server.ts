import { createServer } from 'node:http';

export interface MockServerOptions {
  blockedInstances: number;
  blockStatus: '403' | '429' | 'mixed';
}

export async function startMockServer(options: MockServerOptions) {
  const requestPath = '/api/v1/event/11/statistics';
  let received = 0;
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== requestPath) {
      response.writeHead(404);
      response.end();
      return;
    }
    received++;
    const blocked = received <= options.blockedInstances;
    const status = !blocked ? 200 : options.blockStatus === 'mixed'
      ? (received % 2 === 1 ? 403 : 429) : Number(options.blockStatus);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-local-mock': '1' };
    if (status === 429) headers['retry-after'] = '0';
    response.writeHead(status, headers);
    response.end(JSON.stringify({ mock: true, status, marker: 'mock-response-body' }));
  });

  async function close(): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // El servidor pertenece a la simulación y siempre escucha en loopback.
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await close();
    throw new Error('No se pudo abrir el mock local.');
  }
  const baseUrl = 'http://127.0.0.1:' + address.port;
  return {
    baseUrl,
    requestUrl: baseUrl + requestPath,
    get closed() { return !server.listening; },
    close,
  };
}
