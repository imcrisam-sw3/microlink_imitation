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

## Cambiar de perfil desde cero

Los cuatro clientes directos exponen `changeProfile()`. **Sin argumentos, el propio cliente elige al azar un perfil distinto del anterior.** El método cierra el cliente anterior, cancela sus peticiones pendientes y devuelve una **instancia nueva**. Reasigna la variable con `await`; las referencias al cliente anterior quedan cerradas.

```ts
// Cada variable representa un cliente ya creado; declárala con let.
tlsClient = await tlsClient.changeProfile();
fingerprintClient = await fingerprintClient.changeProfile();
impersClient = await impersClient.changeProfile();
utlsClient = await utlsClient.changeProfile();
```

| Cliente | Selección automática |
| --- | --- |
| TlsClient | Otro User-Agent de `top-user-agents`, de una familia TLS distinta a la anterior. |
| FingerprintClient | Otra familia de navegador y un fingerprint generado con SO y dispositivo compatibles; puede elegir escritorio o móvil. |
| ImpersClient | Un perfil del catálogo nativo instalado, de otra familia de navegador; reconoce también los alias del perfil anterior. |
| UtlsClient | Otro de sus cuatro perfiles y un User-Agent con la familia y versión de los perfiles Auto de uTLS v1.8.2. |

La selección excluye la familia anterior en TLS, Fingerprint e Impers, y el perfil anterior en uTLS. Puede volver a un perfil utilizado en cambios anteriores. La variedad disponible depende de los datos y perfiles instalados. El User-Agent de uTLS se mantiene junto a su cliente; la correspondencia de versiones se documenta en [uTLS v1.8.2](https://github.com/refraction-networking/utls/blob/v1.8.2/u_common.go). Los constructores conservan sus valores predeterminados actuales.

Para elegir manualmente, pasa los argumentos del constructor. Esta vía permite repetir un perfil con una sesión nueva:

```ts
// Cada variable representa un cliente ya creado; declárala con let.
tlsClient = await tlsClient.changeProfile('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0');

fingerprintClient = await fingerprintClient.changeProfile({
  browsers: ['firefox'],
  operatingSystems: ['windows'],
  devices: ['desktop'],
});

impersClient = await impersClient.changeProfile({ impersonate: 'chrome124' });

utlsClient = await utlsClient.changeProfile({
  profile: 'firefox',
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0' },
});
```

Se crea un transporte independiente, sin reutilizar conexiones, sesiones TLS, cookies, fingerprint ni cabeceras de la instancia anterior. uTLS termina el proceso Go anterior y crea otro cuando haces una petición o llamas a `ready()`. TlsClient y FingerprintClient destruyen su Agent anterior; ImpersClient cierra su sesión nativa.

En modo manual, la configuración nueva se pasa completa, con los mismos argumentos que el constructor. En ambos modos se descartan los headers, `headerMode`, `httpsTlsUserAgent`, timeout, certificados adicionales y ruta de binario de la instancia anterior. Los valores operativos omitidos vuelven a sus predeterminados. En FingerprintClient se genera otro fingerprint desde las opciones nuevas. Si necesitas un binario o certificados propios, utiliza la configuración manual.

Las validaciones del constructor se ejecutan antes de cerrar el cliente anterior. La disponibilidad del motor, binario y perfil nativo se comprueba como antes al iniciar o usar el nuevo cliente. En Impers, `maxConnections` conserva el límite de concurrencia durante el cambio automático; en un cambio manual, omitirlo vuelve al valor predeterminado de uno. Las cabeceras que pases después en una petición son responsabilidad del llamador: el método no puede limpiar objetos que conserves fuera del cliente.

Puedes invocar el método manualmente; `check-bot.ts` también lo utiliza al cerrar un lote cuando está habilitado el reinicio por racha contra un mock local. Las pruebas capturan conexiones, cookies, peticiones canceladas y ClientHello contra servidores loopback, tanto en selección manual como automática. También comprueban que el motor nativo admite todos los perfiles del catálogo utilizado.

## Impers con ajustes de https-tls

`ImpersClient` admite `httpsTlsUserAgent` para traducir la configuración de `https-tls` a opciones nativas de libcurl. Es optativo: si lo omites, se conserva el perfil de Impers sin estos overrides.

```ts
import { ImpersClient } from './client/ImpersClient.js';

const client = new ImpersClient({
  impersonate: 'chrome124',
  httpsTlsUserAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});
try {
  const response = await client.get('https://example.com/');
  console.log(response.status, await response.text());
} finally {
  await client.close();
}
```

Este modo carga `https-tls` al iniciar la sesión y aplica sus cifrados, algoritmos de firma, curvas y límites de versión TLS después del perfil nativo. Adapta los nombres de firma antiguos y el formato de libcurl. Envía el mismo User-Agent en GET/POST, aunque los headers de la instancia o petición indiquen otro. Funciona con `headerMode: 'profile'` y `'provided'`, incluida la descompresión del segundo modo; conserva la verificación de certificados.

`impersonate` sigue seleccionando el perfil nativo, incluidos sus ajustes HTTP/2 y los demás parámetros TLS. No se deduce del User-Agent: elige uno compatible con la identidad que quieras usar. `https-tls` utiliza tablas por familia basadas en Chrome 92, Firefox 91 y Safari 14; no obtiene un perfil exacto de la versión declarada. La combinación es experimental y puede reducir la fidelidad del perfil original. No genera un dispositivo ni ejecuta JavaScript.

Las pruebas capturan el ClientHello real contra servidores loopback y comprueban las tres familias, los dos modos de headers y GET/POST sin consultar proveedores.

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
export const REQUESTS_PER_CLIENT = 400;
export const REPORT_EVERY = 40;
export const CONCURRENCY = 10;
export const INTERVAL_MS = 5_000;
export const PROFILE_RESET = {
  enabled: false, // Sólo mocks en loopback: localhost, 127.0.0.0/8 o ::1.
  consecutive: 3,
  statusCodes: [403, 400],
};
```

Configura el destino en `GET_REQUEST` o `POST_REQUEST`. `AVAILABLE_CLIENTS` contiene las factorías de `tls`, `fingerprint`, `impers`, `utls` y `microlink`; sólo se crean los seleccionados. Microlink se selecciona explícitamente porque utiliza su API remota.

La cantidad es por cliente: 400 con cuatro clientes son 1600 llamadas al destino. Los clientes se procesan uno después del otro. Cada cliente lanza lotes de hasta `CONCURRENCY` peticiones simultáneas; el último contiene sólo las restantes. El primer lote comienza inmediatamente. Los siguientes esperan a que termine el anterior y a que transcurra `INTERVAL_MS` desde su inicio: si tarda más, continúan sin acumular lotes pendientes. No hay pausa tras el último lote. Impers recibe el límite de conexiones necesario para permitir esa concurrencia.

El script muestra la URL, el agente, su User-Agent efectivo y `isbot`. Cada `REPORT_EVERY` peticiones informa el estado y tiempo del último intento y los conteos acumulados; también informa el último bloque incompleto y un resumen final por cliente. Los resultados se procesan en orden de intento, aunque las respuestas lleguen desordenadas. Los errores de conexión se cuentan aparte, sin inventar un status 0.

Con `PROFILE_RESET.enabled: true`, cualquier código del conjunto incrementa una misma racha: `403, 400, 403` alcanza `consecutive: 3`. Otro estado o un error sin respuesta corta la racha; ésta puede continuar entre lotes. Alcanzar el umbral programa un solo cambio al finalizar el lote, aunque haya más coincidencias o éxitos en ese lote. Se llama a `changeProfile()` sin argumentos, se usa la instancia nueva y se reinicia la racha. No se cancelan respuestas del lote ni se reenvían intentos. Si ya se completó el total, no se crea otro perfil.

El cambio automático sólo se permite con un destino loopback. Con la URL externa configurada, permanece desactivado. Microlink admite lotes, pero seleccionar Microlink con cambios automáticos activados es un error de configuración. La validación ocurre antes de enviar peticiones o reemplazar los resultados anteriores. Si un cambio falla, se guarda `profileChangeError`, se cierra el cliente y se continúa con el siguiente.

`runCheck` admite `concurrency`, `intervalMs` y `profileReset` en `CheckConfig`. Omitir estas opciones conserva el comportamiento anterior: concurrencia uno, intervalo cero y cambios desactivados. `ImpersClient` admite `maxConnections`, cuyo valor predeterminado sigue siendo uno.

La detección usa las respuestas del propio conteo, sin una petición previa al destino. Para conocer el User-Agent nativo de Impers se hace una petición a un servidor loopback temporal; aparece como `identityRequests` y se informa fuera del conteo al destino. Microlink usa el diagnóstico que devuelve su API: se cuenta el status del destino, y un User-Agent no disponible queda como `null`/`desconocido`.

GET usa redirecciones manuales en los clientes directos. POST también usa redirecciones manuales cuando el cambio automático de perfil está activado, para impedir que un mock redirija fuera de loopback. Con los cambios desactivados, POST conserva su comportamiento anterior de seguir redirecciones. Los cuatro clientes directos aceptan un cuarto argumento opcional `redirect` en `post(url, body, headers, redirect)`, cuyo valor predeterminado es `follow`. Las cantidades representan llamadas a get/post; los detalles internos de navegación de Microlink dependen del servicio.

Cada ejecución guarda en la carpeta fija `results/check-bot/` dentro del repositorio y muestra su ruta. Al comenzar una ejecución válida se elimina el contenido anterior de esa carpeta, incluidos los clientes y archivos que ya no correspondan a la nueva ejecución:

```text
results/check-bot/
  request.json
  tls/
    000001.json
    000002.json
  utls/
    000001.json
  summary.json
```

Cada archivo conserva status, headers, cuerpo JSON o texto, identidad, detección, duración, `profileGeneration` (desde 1) y error si existe. El resumen incluye `profileChanges` y `profileChangeError`; `identityRequests` acumula las comprobaciones locales de identidad, también después de un cambio de Impers. Las credenciales reconocibles de headers y campos sensibles se ocultan al guardar. Los archivos permanecen tras finalizar hasta la próxima ejecución, que los reemplaza. `results/` está ignorada por Git. En el Dev Container se guardan en `/workspace/results/check-bot/`, visible también desde WSL en el repositorio montado.

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
