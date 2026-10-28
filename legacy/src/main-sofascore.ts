import { setTimeout } from 'node:timers/promises';
import { SofaScore } from './SofaScore.js';
import { TlsClient } from './TlsClient.js';
import { FingerprintClient } from './FingerprintClient.js';
import { ImpersClient } from './ImpersClient.js';

type LiveEvent = {
  id: number;
  homeTeam?: { slug?: string };
  awayTeam?: { slug?: string };
  customId?: string;
};

const sofaScore = new SofaScore();
const sharedProfile = process.argv.includes('--shared-profile');
const reference = new FingerprintClient();
const clients = [
  ['TLS', sharedProfile ? new TlsClient(reference.userAgent, { ...reference.headers }) : new TlsClient()],
  ['Fingerprint', reference],
  ['Impers', new ImpersClient(sharedProfile
    ? { headerMode: 'provided', headers: { ...reference.headers } } : {})],
] as const;
if (sharedProfile) console.log('[Comparación] Headers compartidos de Fingerprint; Impers conserva su motor TLS nativo.');
const events: LiveEvent[] = [];
let selectedEvents = false;
let rateLimited = false;
let impersReady = false;

async function get(
  name: string,
  client: TlsClient | FingerprintClient | ImpersClient,
  request: typeof sofaScore.getRequest,
) {
  await setTimeout(1_000);
  try {
    console.log('[' + name + '] GET:', request.url);
    const response = await client.get(request.url, request.headers);
    console.log('[' + name + '] Status GET:', response.status);
    if (!response.ok) process.exitCode = 1;
    if (response.status === 429) {
      rateLimited = true;
      console.log('[' + name + '] Retry-After:', response.headers.get('retry-after'));
    }
    const body = await response.text();
    console.log('[' + name + '] Response GET (' + Buffer.byteLength(body) + ' bytes):',
      body.slice(0, 240).replace(/\s+/g, ' ') + (body.length > 240 ? ' … [truncado]' : ''));
    return { response, body };
  } catch (error) {
    console.error('[' + name + '] Error:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return null;
  }
}

try {
  for (const [name, client] of clients) {
    if (rateLimited) break;
    
    if (client instanceof ImpersClient) {
      try {
        await client.ready();
        impersReady = true;
        console.log('[' + name + '] Perfil nativo:', client.impersonate);
        if (client.headerMode === 'provided') console.log('[' + name + '] User-Agent compartido:', client.headers['user-agent']);
      } catch (error) {
        console.error('[' + name + '] Error:', error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        continue;
      }
    } else {
      console.log('[' + name + '] User-Agent:', client.userAgent);
      console.log('[' + name + '] TLS:', client.tlsOptions);
    }

    const result = await get(name, client, sofaScore.getRequest);
    if (!result?.response.ok) continue;
    try {
      const payload = JSON.parse(result.body) as { events?: LiveEvent[] } | null;
      if (!Array.isArray(payload?.events)) {
        throw new Error('La respuesta no contiene un arreglo events.');
      }
      if (!selectedEvents) {
        selectedEvents = true;
        const ids = new Set<number>();
        for (const event of payload.events) {
          if (!Number.isSafeInteger(event?.id) || event.id <= 0 || ids.has(event.id)) continue;
          ids.add(event.id);
          events.push(event);
          if (events.length === 3) break;
        }
        console.log('[SofaScore] Eventos seleccionados:', events.map(event => event.id));
      }
    } catch (error) {
      console.error('[' + name + '] Error:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }

  if (events.length === 0) {
    console.log('[SofaScore] Sin eventos válidos; estadísticas no ejecutadas.');
  }
  for (const event of events) {
    if (rateLimited) break;
    const home = event.homeTeam?.slug;
    const away = event.awayTeam?.slug;
    const customId = event.customId;
    const referer = typeof home === 'string' && home &&
      typeof away === 'string' && away && typeof customId === 'string' && customId
      ? new URL(
        '/football/match/' + encodeURIComponent(home + '-' + away) + '/' + encodeURIComponent(customId),
        sofaScore.getRequest.url,
      ).href
      : sofaScore.getRequest.headers.Referer;
    const request = sofaScore.getStatisticsRequest(event.id, referer);
    for (const [name, client] of clients) {
      if (rateLimited) break;
      if (client instanceof ImpersClient && !impersReady) continue;
      await get(name, client, request);
    }
  }
  if (rateLimited) console.log('[SofaScore] Prueba detenida por HTTP 429; no se harán más solicitudes.');
} finally {
  await Promise.all(clients.map(([, client]) => client.close()));
}
