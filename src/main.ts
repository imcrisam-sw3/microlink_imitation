// Descomenta los imports y ejemplos que quieras probar.
// import { TlsClient } from './client/TlsClient.js';
// import { FingerprintClient } from './client/FingerprintClient.js';
// import { ImpersClient } from './client/ImpersClient.js';
// import { UtlsClient } from './client/UtlsClient.js';
// import { Microlink } from './client/Microlink.js';
// import { BotDetector } from './tool/BotDetector.js';
// import { AntibotDetector } from './tool/AntibotDetector.js';

// uTLS: un proceso Go propio que se reutiliza para todas las peticiones.
// const client = new UtlsClient({ profile: 'chrome', headers: { Accept: 'application/json' } });
// try {
//   const response = await client.get('https://example.com/');
//   console.log(response.status, response.httpVersion, await response.text());
// } finally {
//   await client.close();
// }

// Comprobar un User-Agent.
// const botDetector = new BotDetector();
// console.log(botDetector.check('Googlebot/2.1 (+http://www.google.com/bot.html)'));

// Comprobar datos de una respuesta, sin hacer una petición.
// const antibotDetector = new AntibotDetector();
// console.log(antibotDetector.check({
//   statusCode: 403,
//   headers: { 'cf-mitigated': 'challenge' },
//   html: '',
//   url: 'https://example.com/',
// }));

// Pasar manualmente la respuesta de un cliente a la herramienta.
// const client = new TlsClient();
// const detector = new AntibotDetector();
// try {
//   const response = await client.get('https://example.com/');
//   const html = await response.text();
//   console.log(detector.check({
//     statusCode: response.status,
//     headers: response.headers,
//     html,
//     url: response.url,
//   }));
// } finally {
//   await client.close();
// }
