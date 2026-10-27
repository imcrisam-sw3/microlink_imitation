# Prueba simple de Microlink

Archivos en `src/`:

- `Microlink.ts`: cliente con los métodos `get(url, headers)` y `post(url, body, headers)`.
- `TlsClient.ts`: método HTTP directo con `top-user-agents`, `https-tls` y Undici.
- `FingerprintClient.ts`: cliente HTTP independiente con `fingerprint-generator`, Undici y un perfil TLS de `https-tls`, sin heredar de `TlsClient`.
- `ImpersClient.ts`: cliente independiente con `impers` y `curl-impersonate`, con Safari para iPhone como perfil inicial.
- `Altenar.ts`: peticiones editables y `getOddsStates(client)`, que obtiene un token y realiza el POST con ese mismo cliente.
- `main.ts`: punto de entrada para activar las pruebas manuales.
- `JsonFile.ts`: guarda datos en JSON o texto plano con un prefijo opcional y fecha/hora.

## Preparación

En la terminal del devcontainer, desde `/workspace`:

```bash
pnpm install --frozen-lockfile
# Solo si todavía no tienes .env:
cp .env.example .env
pnpm start
```

`pnpm start` carga el `.env` existente y ejecuta las llamadas activas en `src/main.ts`.

## Configuración

```dotenv
MICROLINK_ENDPOINT=https://api.microlink.io
MICROLINK_API_KEY=
ALTENAR_AUTHORIZATION=
```

El endpoint predeterminado es el gratuito y no recibe la clave. Para usar Pro, cambia explícitamente `MICROLINK_ENDPOINT` a `https://pro.microlink.io` y completa `MICROLINK_API_KEY`.

Los ejemplos de Altenar incluyen cabeceras personalizadas, que requieren Pro. Para probar el endpoint gratuito, usa un GET sin cabeceras personalizadas. La autorización de Altenar se envía literalmente, sin añadir `Bearer`.

## Pruebas manuales

Edita las peticiones en `Altenar.ts` y ejecuta `pnpm start`. `main.ts` ejecuta el flujo GET de token y POST `GetOddsStates` una vez con cada cliente: `TlsClient`, `FingerprintClient` e `ImpersClient`. Para los dos primeros muestra el User-Agent y las opciones TLS; para Impers muestra el perfil de navegador y su transporte nativo. También muestra el estado y la respuesta POST, y finaliza los tres clientes al terminar.

GET solicita el JSON del destino. POST envía una Function legible que hace el POST al destino; la llamada a la API de Microlink sigue siendo GET. Ambos métodos devuelven la respuesta JSON completa de Microlink.

Los `console.log` muestran parámetros, URLs, métodos, cabeceras, bodies, Function, estados HTTP y respuestas completas. Los logs remotos del POST aparecen dentro de la respuesta de Microlink.

GET incluye un diagnóstico en `data.function.value`: `userAgent` (cabecera efectiva de la navegación), `statusCode` y `rawBody` (cuerpo original con tokens ocultos). Usa la misma respuesta del navegador de Microlink, sin hacer otro fetch al destino. Si la Function falla, se muestra `Diagnóstico destino no disponible`.

Como Altenar usa nombres de campos opacos, el diagnóstico oculta todos los valores string del JSON con `[REDACTED_TOKEN]`, conservando claves, valores null y formato del cuerpo. También se ocultan los strings de `data.content` antes de registrar o guardar el resultado. En cuerpos no JSON, se ocultan credenciales Bearer y cadenas con formato de token; esta detección es heurística. Los encabezados sensibles del GET se ocultan en los logs.

La verificación local del diagnóstico no contacta a Microlink ni al proveedor:

```bash
node --test tests/microlink-diagnostic.test.mjs
```


```bash
pnpm typecheck
pnpm build
```

## POST de Altenar desde main

Cada llamada a `altenar.getOddsStates(client)` obtiene un token mediante `getRequest`, verifica que la respuesta sea HTTP 200/2xx y contenga un string no vacío en el campo de token observado, y lo envía literalmente en Authorization del POST. Un error HTTP, HTML, JSON inválido o token null impide ese POST. El token no se registra ni se guarda en el objeto compartido; GET y POST reutilizan la misma instancia y su configuración de transporte, con el mismo Origin y Referer.

El cuerpo de la petición conserva `odds`, con `oddId: 4708159870`, `eventId: 18096674`, `intSelectionId: 3179` y `price: 2.4286`. Los demás campos existentes se conservan. `oddStates`, `liveTime`, `score` y los estados de la cuota pertenecen a la respuesta del proveedor. El precio enviado es una referencia de la captura; el precio recibido puede haber cambiado.

```bash
pnpm start
```

Si un cliente falla, se muestra su error y se prueba el siguiente; el proceso finaliza con código 1 si hubo algún fallo. No hay reintentos automáticos. `getOddsStates` acepta clientes con respuestas estructurales que exponen `status`, `ok`, `text()` y `json()`, y devuelve la respuesta del POST sin convertirla a un Response de Undici.

## Clientes HTTP con Undici

Ambas clases exponen `get(url, headers)`, `post(url, body, headers)` y `close()`. Devuelven el `Response` de Undici: lee `status`, `headers` y `await response.text()` o `await response.json()`. POST serializa el body como JSON y agrega `Content-Type: application/json` si no lo proporcionas.

```ts
import { TlsClient } from './TlsClient.js';
import { FingerprintClient } from './FingerprintClient.js';

const client = new TlsClient();
// Alternativa, activa solo una:
// const client = new FingerprintClient({
//   browsers: ['chrome'],
//   operatingSystems: ['linux'],
//   devices: ['desktop'],
//   locales: ['es-ES', 'es'],
// });

try {
  console.log('User-Agent:', client.userAgent);
  console.log('TLS:', client.tlsOptions);
  const response = await client.get(url, headers);
  console.log('Status:', response.status);
  const body = await response.text();
  // El body puede contener un token. Evita publicarlo en logs compartidos.
} finally {
  await client.close();
}
```

Ambas clases convierten `signatureAlgorithms`, devuelto por `https-tls`, a `sigalgs`, que reconoce Node/Undici. `client.tlsOptions` muestra las opciones adaptadas que se entregan al Agent.

Cada instancia conserva su User-Agent y su Agent para GET y POST. Los headers específicos de la petición prevalecen sobre los generados, incluidos Origin, Referer y Authorization. El User-Agent de la instancia prevalece siempre sobre el de la petición. Ambas clases lo usan para configurar TLS; en `FingerprintClient` también mantiene la correspondencia con los headers generados. Si necesitas uno concreto en el método TLS, usa `new TlsClient(userAgent)`.

`FingerprintClient` genera una vez el fingerprint y sus headers; puedes inspeccionarlos en `client.fingerprint` y `client.headers`. Configura su propio Agent con `https-tls` a partir del mismo User-Agent y adapta `signatureAlgorithms` a `sigalgs`. No importa ni hereda de `TlsClient`. Las propiedades JavaScript del fingerprint son datos: no se inyectan en un navegador porque esta clase usa HTTP directo. La suite genera el fingerprint y sus headers; `https-tls` aporta el perfil TLS. Referencia: [fingerprint-suite](https://github.com/apify/fingerprint-suite).

El 26 de octubre de 2026 se verificó que el TLS predeterminado de Node devolvía HTTP 403 en el GET del token. `FingerprintClient` con su propio perfil `https-tls` y `sigalgs` obtuvo token y HTTP 200 en el POST `GetOddsStates`. Ese es un resultado de una prueba concreta. Las pruebas automáticas validan el funcionamiento local, la independencia de `TlsClient` y los algoritmos de firma realmente emitidos en el ClientHello:

```bash
node --import tsx --test tests/*.test.mjs
```

## Cliente nativo con Impers

ImpersClient usa impers 0.1.2 y curl-impersonate dentro del mismo proceso Node; no ejecuta Python ni un navegador. El perfil inicial es safari_ios (Safari para iPhone), configurable con impersonate. Con el paquete instalado ese alias selecciona safari260_ios. La verificación de certificados permanece activa.

En la terminal del Dev Container, desde /workspace:

```bash
pnpm install --frozen-lockfile
# La compilación de koffi está habilitada en pnpm-workspace.yaml.
# Opcional: mantener el binario descargado en la caché del proyecto.
export IMPER_CACHE_DIR="$PWD/node_modules/.cache/impers"
```

La primera carga de Impers descarga curl-impersonate v2.2.2 si no encuentra el motor local. La descarga y el perfil se preparan con ready() antes de medir las peticiones. Para utilizar una instalación propia se puede definir LIBCURL_PATH con la ruta de libcurl-impersonate.so. Una libcurl convencional provoca un error explícito. Las opciones TLS y Fingerprint no inicializan este motor.

```ts
import { ImpersClient } from './ImpersClient.js';

const client = new ImpersClient({
  impersonate: 'safari_ios',
  timeoutMs: 20_000,
  headers: { Accept: 'application/json' },
});

try {
  await client.ready();
  const response = await client.get('http://127.0.0.1:7500/ejemplo');
  console.log('Estado:', response.status);
  console.log('Respuesta:', await response.text());
} finally {
  await client.close();
}
```

La clase ofrece get(url, headers, signal?, redirect?), post(url, body, headers), ready() y close(). Los headers por petición prevalecen sobre los del constructor sin modificar los originales. El perfil nativo aporta el User-Agent; el adaptador elimina cualquier User-Agent o sec-ch-ua* recibido para evitar mezclar identidades. Conserva autorización, Origin, Referer y los demás headers funcionales.

POST serializa el cuerpo como JSON y añade Content-Type solo cuando falta. Las respuestas exponen status, ok, headers.get(), text() y json() asíncronos. El cuerpo se descarga por completo antes de devolver la respuesta; si la descarga falla, no se inventa un estado HTTP parcial. timeoutMs se expresa en milisegundos y se convierte a segundos para el SDK.

Cada instancia conserva sus cookies y su propio gestor de conexiones nativo, con maxConnections: 1. close() cancela las transferencias pendientes, cierra el gestor, es idempotente e impide nuevas peticiones. No se añaden reintentos al adaptador.

### Seleccionar el cliente

Los scripts pnpm start (Altenar) y pnpm start:sofascore comparan TLS, Fingerprint e Impers. Son pruebas manuales contra los destinos configurados.

Los dos probes aceptan --client=tls|fingerprint|impers; tls sigue siendo la opción predeterminada:

```bash
# Simulación local: crea su propio servidor y no consulta proveedores.
pnpm probe:mock --client=impers

# Probe contra un servidor local propio con el contrato de eventos/estadísticas.
pnpm probe:clients --client=impers --base-url=http://127.0.0.1:7500
```

Se mantienen los límites, intervalos y políticas de cierre de cada probe. En los informes de Impers se registra impersonate en lugar de inventar userAgent u opciones TLS de Node. Los informes siguen guardándose en results/.

impers está en fase alfa. Las verificaciones de esta integración utilizan únicamente servidores locales: métodos, cookies, identidad Safari móvil, cancelación, redirecciones, flujo token→POST, límites de los probes y ClientHello con GREASE y ALPN HTTP/2. Esto no constituye una prueba de acceso a un proveedor externo.

## Debug en VS Code

Con el proyecto abierto dentro del devcontainer:

1. Abre `src/main.ts` y pon un breakpoint con F9 en una línea ejecutable.
2. Abre **Ejecutar y depurar** y selecciona **Depurar app (Dev Container)**.
3. Pulsa F5. La app carga `.env` y se detiene al entrar en `main.ts`.
4. Usa F10 para avanzar una línea, F11 para entrar en un método y F5 para continuar.

Los logs aparecen en la terminal integrada. Para entrar en `get` o `post`, usa F11 al ejecutar el flujo del cliente correspondiente.

La depuración usa TypeScript directamente con `tsx`; no necesitas compilar antes.

## Guardar JSON o texto plano

`JsonFile.save(datos, prefijo)` guarda en `results/` y devuelve la ruta. El prefijo es opcional y la fecha/hora usa UTC con milisegundos.

- Objetos serializables y strings con JSON válido: archivo `.json` con formato.
- Texto normal, HTML o JSON inválido: archivo `.txt` con el texto original.
- Datos que JSON no puede serializar, como objetos circulares: archivo `.txt` con una representación legible.

```ts
import { JsonFile } from './JsonFile.js';

const jsonFile = new JsonFile();
await jsonFile.save({ mensaje: 'Prueba' }, 'comparacion');
// results/comparacion-2026-10-26T15-30-10-123Z.json

await jsonFile.save('{"ok":true}', 'api');
// results/api-2026-10-26T15-30-10-123Z.json

await jsonFile.save('<html>403 Forbidden</html>', 'error');
// results/error-2026-10-26T15-30-10-123Z.txt
```

Puedes omitir el prefijo o cambiar la carpeta con `jsonFile.directory = 'otra-carpeta'`. El formato, contenido y ruta se muestran en consola. Si el nombre ya existe, Node devuelve su error normal y el archivo existente se conserva.

Para guardar un cuerpo HTTP que puede ser JSON o HTML, pasa a `save` el resultado de `await response.text()`. Un objeto `Response` de `fetch` se serializa como `{}`; su contenido debe leerse antes.
