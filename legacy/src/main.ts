import { Altenar } from './Altenar.js';
import { TlsClient } from './TlsClient.js';
import { FingerprintClient } from './FingerprintClient.js';
import { ImpersClient } from './ImpersClient.js';
import { SofaScore } from './SofaScore.js';

const altenar = new Altenar();
const sofaScore = new SofaScore();
const sharedProfile = process.argv.includes('--shared-profile');
const clientFpc = new FingerprintClient();
const clientTls = sharedProfile
  ? new TlsClient(clientFpc.userAgent, { ...clientFpc.headers }) : new TlsClient();
const clientImpers = new ImpersClient(sharedProfile
  ? { headerMode: 'provided', headers: { ...clientFpc.headers } } : {});
if (sharedProfile) console.log('[Comparación] Headers compartidos de Fingerprint; Impers conserva su motor TLS nativo.');

try {
  for (const [name, client] of [['TLS', clientTls], ['Fingerprint', clientFpc], ['Impers', clientImpers]] as const) {

    try {
      if (client instanceof ImpersClient) {
        await client.ready();
        console.log('[' + name + '] Perfil nativo:', client.impersonate);
        if (client.headerMode === 'provided') console.log('[' + name + '] User-Agent compartido:', client.headers['user-agent']);
      } else {
        console.log('[' + name + '] User-Agent:', client.userAgent);
        console.log('[' + name + '] TLS:', client.tlsOptions);
      }
      // Cada cliente obtiene su token y lo utiliza en su propio POST.
      const response = await altenar.getOddsStates(client);
      console.log(`[${name}] Status POST:`, response.status);
      const body = await response.text();
      console.log(`[${name}] Response POST (${Buffer.byteLength(body)} bytes):`,
        body.slice(0, 240).replace(/\s+/g, ' ') + (body.length > 240 ? ' … [truncado]' : ''));
      if (!response.ok) process.exitCode = 1;
    } catch (error) {
      console.error(`[${name}] Error:`, error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
} finally {
  await Promise.all([clientTls.close(), clientFpc.close(), clientImpers.close()]);
}
