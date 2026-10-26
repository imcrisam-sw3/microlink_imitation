# Prueba simple de Microlink

Archivos en `src/`:

- `Microlink.ts`: cliente con los métodos `get(url, headers)` y `post(url, body, headers)`.
- `TlsClient.ts`: método HTTP directo con `top-user-agents`, `https-tls` y Undici.
- `FingerprintClient.ts`: cliente HTTP independiente con `fingerprint-generator` de Apify y Undici; usa el TLS predeterminado de Node, sin `TlsClient` ni `https-tls`.
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

Edita las peticiones en `Altenar.ts` y ejecuta `pnpm start`. `main.ts` ejecuta el flujo GET de token y POST `GetOddsStates` una vez con `TlsClient` y una vez con `FingerprintClient`. Muestra el User-Agent, TLS, estado HTTP y respuesta POST de cada cliente, y cierra ambos Agents al terminar.

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

Cada llamada a `altenar.getOddsStates(client)` obtiene un token mediante `getRequest`, verifica que la respuesta sea HTTP 200/2xx y contenga un string no vacío en el campo de token observado, y lo envía literalmente en Authorization del POST. Un error HTTP, HTML, JSON inválido o token null impide ese POST. El token no se registra ni se guarda en el objeto compartido; GET y POST reutilizan el User-Agent y Agent de la instancia, con el mismo Origin y Referer.

El cuerpo de la petición conserva `odds`, con `oddId: 4708159870`, `eventId: 18096674`, `intSelectionId: 3179` y `price: 2.4286`. Los demás campos existentes se conservan. `oddStates`, `liveTime`, `score` y los estados de la cuota pertenecen a la respuesta del proveedor. El precio enviado es una referencia de la captura; el precio recibido puede haber cambiado.

```bash
pnpm start
```

Si un cliente falla, se muestra su error y se prueba el siguiente; el proceso finaliza con código 1 si hubo algún fallo. No hay reintentos automáticos. `getOddsStates` devuelve el Response del POST para que puedas leerlo o guardarlo.

## Dos métodos HTTP directos

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
  console.log('TLS:', 'tlsOptions' in client ? client.tlsOptions : 'Predeterminado de Node/Undici');
  const response = await client.get(url, headers);
  console.log('Status:', response.status);
  const body = await response.text();
  // El body puede contener un token. Evita publicarlo en logs compartidos.
} finally {
  await client.close();
}
```

Cada instancia conserva su User-Agent y su Agent para GET y POST. Los headers específicos de la petición prevalecen sobre los generados, incluidos Origin, Referer y Authorization. El User-Agent de la instancia prevalece siempre sobre el de la petición. En `TlsClient` se usa para configurar TLS; en `FingerprintClient` mantiene la correspondencia con los headers generados. Si necesitas uno concreto en el método TLS, usa `new TlsClient(userAgent)`.

`FingerprintClient` genera una vez el fingerprint y sus headers; puedes inspeccionarlos en `client.fingerprint` y `client.headers`. Usa un perfil HTTP/1 para el transporte HTTP/1.1 de este Agent. Las propiedades JavaScript del fingerprint son datos: no se inyectan en un navegador porque estas clases usan HTTP directo. `FingerprintClient` no hereda de `TlsClient` ni carga `https-tls`: crea su propio Agent sin opciones TLS personalizadas. La suite genera el fingerprint y sus headers; Undici envía las peticiones con el TLS predeterminado de Node. Esto no reproduce exactamente el TLS de un navegador. Referencia: [fingerprint-suite](https://github.com/apify/fingerprint-suite).

En la versión anterior del 26 de octubre de 2026, ambas clases usaban `https-tls` y obtuvieron HTTP 200 en las consultas GET y POST. Después de independizar `FingerprintClient` y usar el TLS predeterminado, una consulta real devolvió HTTP 403 en el GET del token; el POST se omitió. Las pruebas locales verifican el funcionamiento y la independencia de las clases, sin acreditar acceso al proveedor. Se ejecutan así:

```bash
node --import tsx --test tests/*.test.mjs
```

## Debug en VS Code

Con el proyecto abierto dentro del devcontainer:

1. Abre `src/main.ts` y pon un breakpoint con F9 en una línea ejecutable.
2. Abre **Ejecutar y depurar** y selecciona **Depurar app (Dev Container)**.
3. Pulsa F5. La app carga `.env` y se detiene al entrar en `main.ts`.
4. Usa F10 para avanzar una línea, F11 para entrar en un método y F5 para continuar.

Los logs aparecen en la terminal integrada. Para entrar en `get` o `post`, descomenta la llamada correspondiente en `main.ts`; los ejemplos comentados no se ejecutan.

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
