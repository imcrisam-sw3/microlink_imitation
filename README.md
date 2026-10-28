# microlink-imitation

Base sencilla en TypeScript para probar clientes HTTP y analizar User-Agent o respuestas con herramientas independientes.

## Estructura

```text
legacy/                    Proyecto anterior: fuentes, pruebas, README, configuración y resultados
src/
  client/
    TlsClient.ts           Undici con configuración TLS según el User-Agent
    FingerprintClient.ts   Undici con headers generados por fingerprint-generator
    ImpersClient.ts        Sesion nativa de impers/curl-impersonate
    UtlsClient.ts          Worker Go independiente con uTLS
    Microlink.ts           Cliente de la API de Microlink
  tool/
    BotDetector.ts         Reconoce bots por su User-Agent con isbot
    AntibotDetector.ts     Reconoce señales de protección con is-antibot
  types/                   Declaraciones TypeScript para https-tls
  main.ts                  Imports y ejemplos comentados
tests/                    Pruebas locales de clientes y herramientas
```

Los cuatro clientes anteriores conservan sus métodos y comportamiento. El nuevo `UtlsClient` también proporciona `get`, `post`, `ready` y `close`. `TlsClient`, `FingerprintClient` e `ImpersClient` proporcionan `get`, `post` y `close`; `Microlink` proporciona `get` y `post` y devuelve el resultado de su API.

## Entorno y comandos

Usa WSL o el Dev Container del proyecto, con Node.js 24 y pnpm 12.10.1.

```bash
pnpm install --frozen-lockfile
pnpm start
pnpm test
pnpm typecheck
pnpm build
```

`pnpm start` carga `src/main.ts`, que contiene únicamente ejemplos comentados: no crea clientes ni hace peticiónes. Descomenta solo el ejemplo que quieras ejecutar. `.env` se carga si existe; las variables de Microlink se documentan en `.env.example`.

La configuración de VS Code `Depurar app (Dev Container)` apunta al nuevo `main`. Las dependencias nativas permitidas se indican en `pnpm-workspace.yaml`, incluido `re2`, requerido por `is-antibot`.

## Cliente uTLS

`UtlsClient` usa [uTLS](https://github.com/refraction-networking/utls) v1.8.2 desde un ejecutable Go propio. No utiliza los otros clientes, Undici, https-tls, fingerprint-generator ni impers.

La imagen del Dev Container compila el ejecutable en una etapa Go y lo copia a `/usr/local/bin/utls-worker`. Go no se instala en el contenedor Node. Para disponer del binario en el contenedor actual, sin reconstruirlo, ejecuta desde **WSL**, con Docker disponible:

```bash
cd /home/sw3/test/microlink_imitation
sh scripts/build-utls.sh
```

Esto compila y prueba el módulo dentro de Docker y exporta `bin/utls-worker`. La carpeta está montada también en `/workspace/bin` del Dev Container. `pnpm build:utls` hace lo mismo cuando Node/pnpm y Docker están disponibles en el entorno que ejecuta el comando. El comando no necesita el socket Docker dentro del contenedor Node: ejecútalo desde WSL.

```ts
import { UtlsClient } from './client/UtlsClient.js';

const client = new UtlsClient({
  profile: 'chrome',
  headers: { Accept: 'application/json' },
  timeoutMs: 20_000,
});
try {
  const response = await client.get('https://example.com/');
  console.log(response.status, response.httpVersion, await response.text());
  // Usa el mismo proceso Go y conserva cookies y conexiones de esta instancia.
  await client.post('https://example.com/', { value: 1 });
} finally {
  await client.close();
}
```

El constructor no arranca procesos. La primera petición o `ready()` inicia uno; `close()` cancela peticiones, cierra la sesión y espera su terminación. Una caída del worker rechaza las peticiones pendientes; crea otra instancia para abrir una sesión nueva. Node y Go intercambian JSON por stdin/stdout sin abrir puertos; los diagnósticos de Go van a stderr. `processId` permite identificar el proceso.

Opciones:
- `profile`: `chrome` (predeterminado), `firefox`, `safari` o `ios`; selecciona el ClientHello incluido en la versión fijada de uTLS.
- `headers`: headers propios de la instancia, con overrides por petición. El perfil sólo configura TLS: no genera un User-Agent de navegador ni simula JavaScript o un dispositivo. El User-Agent predeterminado es `utls-client/1.0`.
- `binaryPath`: ejecutable explícito. En su ausencia se busca `bin/utls-worker`, después `UTLS_BINARY_PATH` y finalmente `/usr/local/bin/utls-worker`.
- `caFile`: certificados CA adicionales en PEM; la verificación TLS permanece activa.

`get(url, headers?, signal?, redirect?)` admite cancelación y `follow`, `manual` o `error`. `post(url, body, headers?)` envía JSON. El timeout incluye el arranque y la lectura completa del cuerpo. Las respuestas exponen `status`, `ok`, `headers`, `url`, `httpVersion`, `text()` y `json()`. El cuerpo se almacena en memoria; las peticiones y respuestas se limitan a 16 MiB. El transporte descomprime gzip, deflate, Brotli y zstd, también cuando proporcionas Accept-Encoding explícitamente; el límite se aplica al cuerpo descomprimido. Las cookies respetan los límites públicos entre dominios.

Soporta conexiones directas HTTP/1.1 y HTTPS con HTTP/1.1 o HTTP/2 según ALPN. HTTP/2 funcional no reproduce por sí mismo los ajustes HTTP/2 de un navegador. Esta versión no configura proxies ni HTTP/3.

Las pruebas nuevas utilizan servidores loopback y el binario real; no hacen peticiones a proveedores. Para probar Go con detección de carreras sin instalarlo:

```bash
docker run --rm \
  --mount type=bind,source="$PWD/native/utls",target=/src \
  -w /src golang:1.26-bookworm go test -race ./...
```

## Comparar clientes y detectar señales de bots

Edita la configuración al inicio de `src/check-bot.ts` y ejecuta en el Dev Container:

```bash
pnpm check:bot
```

```ts
export const GET_REQUEST = { method: 'GET', url: 'https://tu-destino/', headers: {} };
export const POST_REQUEST = { method: 'POST', url: 'https://tu-destino/', headers: {}, body: { value: 1 } };
export const REQUEST_TO_USE = GET_REQUEST; // O POST_REQUEST.
export const CLIENTS_TO_USE = ['tls', 'fingerprint', 'impers', 'utls'];
export const REQUESTS_PER_CLIENT = 20;
export const REPORT_EVERY = 5;
```

La URL inicial está vacía para que configures tu destino. `AVAILABLE_CLIENTS` contiene las factorías de `tls`, `fingerprint`, `impers`, `utls` y `microlink`; sólo se crean los seleccionados. Microlink se selecciona explícitamente porque utiliza su API remota.

La cantidad es por cliente: 20 con cuatro clientes son 80 llamadas al destino. Los clientes se ejecutan secuencialmente y conservan su instancia. El script muestra la URL, el agente, su User-Agent efectivo y `isbot`; por petición muestra el status, las señales antibot y el tiempo. Cada `REPORT_EVERY` peticiones informa los conteos de todos los status observados. También informa el último bloque incompleto y un resumen final por cliente. Los errores de conexión se cuentan aparte, sin inventar un status 0.

La detección usa las respuestas del propio conteo, sin una petición previa al destino. Para conocer el User-Agent nativo de Impers se hace una petición a un servidor loopback temporal; aparece como `identityRequests` y se informa fuera del conteo al destino. Microlink usa el diagnóstico que devuelve su API: se cuenta el status del destino, y un User-Agent no disponible queda como `null`/`desconocido`.

GET usa redirecciones manuales en los clientes directos. POST conserva el comportamiento de cada cliente, incluidas sus redirecciones. Las cantidades representan llamadas a get/post; los detalles internos de navegación de Microlink dependen del servicio.

Cada ejecución crea una carpeta única en el directorio temporal del entorno donde corre Node y muestra su ruta:

```text
/tmp/client-bot-.../
  request.json
  tls/
    000001.json
    000002.json
  utls/
    000001.json
  summary.json
```

Cada archivo conserva status, headers, cuerpo JSON o texto, identidad, detección, duración y error si existe. Las credenciales reconocibles de headers y campos sensibles se ocultan al guardar. Los archivos permanecen tras finalizar para inspeccionarlos y se pueden borrar después; si ejecutas en el Dev Container estarán dentro de él.

`isbot` sólo evalúa el User-Agent. `has antibot=false` significa que no se encontraron señales conocidas en esa respuesta; no demuestra ausencia de protección. El resumen distingue los errores de transporte de los estados HTTP. Las pruebas usan servidores locales y una API Microlink simulada.

## Detectar un bot

```ts
import { BotDetector } from './tool/BotDetector.js';

const detector = new BotDetector();
const detected = detector.check('Googlebot/2.1 (+http://www.google.com/bot.html)');
console.log(detected); // true
```

`check(userAgent: string): boolean` usa los patrones de [isbot](https://github.com/omrilotan/isbot). `false` significa que no reconoció un patron de bot; no confirma que el cliente sea una persona.

## Detectar protección antibot

```ts
import { AntibotDetector } from './tool/AntibotDetector.js';

const detector = new AntibotDetector();
const result = detector.check({
  statusCode: 403,
  headers: { 'cf-mitigated': 'challenge' },
  html: '',
  url: 'https://example.com/',
});
console.log(result);
// { detected: true, provider: 'cloudflare', detection: 'headers', technique: 'javascript' }
```

`check(input: isAntibot.Input): isAntibot.Result` conserva la entrada y salida de [is-antibot](https://github.com/microlinkhq/is-antibot), incluidos sus alias `body` y `status`. Las cabeceras pueden ser un objeto `Headers` o un registro compatible con la libreria.

La herramienta analiza los datos que le pases. Para analizar una respuesta de un cliente, lee su cuerpo una vez con `await response.text()` y pasa el texto como `html`, las cabeceras como `headers` y el estado como `statusCode`. `src/main.ts` incluye este ejemplo comentado con `TlsClient`.

`detected: false` significa que no encontró señales conocidas en esos datos; no demuestra que el sitio carezca de protección. Un HTTP 403 generico tampoco identifica por si solo al proveedor. Las herramientas se invocan de forma explícita y no cambian las respuestas de los clientes.

## Proyecto anterior

`legacy` conserva el estado anterior a la reorganizacion, incluidas las modificaciones locales y copias manuales. Su README, manifiestos y configuración originales se mantienen sin cambios. Altenar, SofaScore, probes, mocks y `JsonFile` permanecen alli.

`.git`, `node_modules`, `.env` y los metadatos locales de trabajo permanecen en la raíz. Los archivos generados de `dist` se regeneran con la estructura nueva; los resultados anteriores estan en `legacy/results` y siguen ignorados por Git. La configuración activa de TypeScript compila solo `src`.

Consulta `legacy/ARCHIVE.md` para los comandos anteriores. Las pruebas activas usan servidores locales y no requieren peticiónes a los proveedores.
