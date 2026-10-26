import { Altenar } from './Altenar.js';
import { TlsClient } from './TlsClient.js';
import { FingerprintClient } from './FingerprintClient.js';

const altenar = new Altenar();
const clientTls = new TlsClient();
const clientFpc = new FingerprintClient();

try {
  for (const [name, client] of [['TLS', clientTls], ['Fingerprint', clientFpc]] as const) {
    console.log(`[${name}] User-Agent:`, client.userAgent);
    console.log(`[${name}] TLS:`, 'tlsOptions' in client ? client.tlsOptions : 'Predeterminado de Node/Undici');
    try {
      // Cada cliente obtiene su token y lo utiliza en su propio POST.
      const response = await altenar.getOddsStates(client);
      console.log(`[${name}] Status POST:`, response.status);
      console.log(`[${name}] Response POST:`, await response.text());
      if (!response.ok) process.exitCode = 1;
    } catch (error) {
      console.error(`[${name}] Error:`, error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
} finally {
  await Promise.all([clientTls.close(), clientFpc.close()]);
}
