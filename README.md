# Microlink imitation

App de consola para hacer una petición a través de Microlink, guardar una referencia y reproducirla directamente desde Node en el Dev Container.

## Entorno

Trabajar en la terminal del Dev Container, desde `/workspace`. La configuración existente usa Node 24 y pnpm; la app no necesita servicios adicionales.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
```

Completar `.env`:

```dotenv
MICROLINK_ENDPOINT=https://api.microlink.io
MICROLINK_API_KEY=
ALTENAR_AUTHORIZATION=
```

La autorización se envía exactamente como se configura, sin añadir `Bearer`. El token pegado en la conversación no está incluido en los archivos.

La app usa `https://api.microlink.io` por defecto y no le envía `x-api-key`, aunque exista una clave en el entorno o en `.env`. Los perfiles `get-free` y `public` no usan cabeceras personalizadas. La disponibilidad y los límites de Functions dependen del plan.

`get-free` usa la misma URL de Altenar que `get`, pero sin las cabeceras de la petición original. Para reproducir esas cabeceras o probar POST, selecciona explícitamente `MICROLINK_ENDPOINT=https://pro.microlink.io` y completa `MICROLINK_API_KEY`. La app valida estas restricciones antes de hacer llamadas.

## Uso

```bash
# Endpoint gratuito: captura o comparación sin cabeceras personalizadas
pnpm capture --profile get-free
pnpm compare --profile get-free
pnpm compare --profile public

# Sin --profile también usa get-free
pnpm compare

# Peticiones originales con cabeceras: endpoint Pro explícito y clave en .env
MICROLINK_ENDPOINT=https://pro.microlink.io pnpm capture --profile get
MICROLINK_ENDPOINT=https://pro.microlink.io pnpm compare --profile get
MICROLINK_ENDPOINT=https://pro.microlink.io pnpm compare --profile post

# Repetir una captura sin volver a consultar Microlink
pnpm replay --capture results/<ejecucion>/capture.json

# Elegir un archivo o directorio de salida
pnpm compare --profile profiles/otro-endpoint.json --out results

pnpm capture --help
```

La app carga `.env` usando Node; las variables ya definidas en el entorno tienen prioridad.

## Cambiar la request

Editar `profiles/get-free.json` para el gratuito, `profiles/get.json` o `profiles/post.json` para Pro, o crear otro perfil con esta forma:

```json
{
  "url": "https://example.com/api/items",
  "method": "POST",
  "headers": {
    "accept": "application/json",
    "authorization": "${ALTENAR_AUTHORIZATION}",
    "content-type": "application/json"
  },
  "body": {
    "limit": 10
  },
  "timeoutMs": 30000
}
```

- `url`: URL completa con sus parámetros.
- `method`: GET o POST.
- `headers`: cabeceras de la API destino. Los nombres se normalizan a minúsculas. Se admiten referencias `${VARIABLE}` en sus valores.
- `body`: objeto/array/valor JSON, string ya serializado o null. Los objetos se serializan una sola vez; un string se transmite sin volver a codificar. GET exige body ausente o null.
- `timeoutMs`: de 1 a 60000; default 30000. El servicio puede aplicar un límite menor.

El GET de ejemplo corresponde al endpoint de integración. El POST conserva el body de GetOddsStates y sus IDs de ejemplo, que pueden dejar de estar disponibles. Ambos perfiles son independientes: no hay renovación automática ni transferencia del token entre ellos.

## Qué compara

**GET nativo:** solicita `data.content.attr=json`, desactiva metadata, prerender y ping, y usa una Function para obtener las cabeceras disponibles en el contexto. Todo se pide en una sola llamada a Microlink.

**POST Function:** ejecuta un fetch dentro de una Function, devuelve la petición configurada y su respuesta. El body viaja en una cabecera auxiliar codificada para evitar incluirlo en la URL de Microlink; la Function elimina esa cabecera antes de consultar el destino. Esto requiere una clave y está sujeto a límites de tamaño de cabeceras.

El POST no prueba la ruta nativa de proxies de Microlink. Las cabeceras de la Function representan la configuración de fetch; no son una captura completa de los bytes enviados por el transporte.

**Replay:** usa URL, método, body y cabeceras disponibles de la captura. Node calcula Host, Content-Length y cabeceras de transporte. No reenvía las cabeceras de autenticación de Microlink. La IP, TLS y valores implícitos del transporte pueden diferir.

Cada `compare` envía una llamada a Microlink y una petición local. La app no reintenta ni sigue redirecciones locales. Microlink puede realizar redirecciones y operaciones internas adicionales; `retry=0` y `force=true` solicitan una referencia fresca.

## Resultados

`capture.json` contiene la request reproducible, cabeceras observables, respuesta del servicio, respuesta remota y diagnóstico. Cada replay crea su propio subdirectorio con `local.json` y `comparison.json`.

El resumen muestra:

- `accessWorks`: ambos lados devolvieron HTTP 2xx y JSON válido. Puede ser null si falta el estado remoto.
- `jsonEqual`: igualdad semántica, sin depender del orden de claves. Una huella del JSON original permite detectar cambios incluso en valores ocultos; las diferencias sensibles no se muestran.
- Estados HTTP, tipos de contenido, tiempos y hasta 50 diferencias del JSON.
- Errores del servicio, bloqueos del destino, HTML, JSON inválido y timeouts.

Una diferencia en cuotas no significa que haya fallado el acceso. Las credenciales conocidas se ocultan antes de guardar o mostrar resultados; pueden aparecer referencias como `${ALTENAR_AUTHORIZATION}`. Los archivos siguen conteniendo los demás datos devueltos por la API.

Si una credencial conocida aparece en el body, la captura guarda marcadores y referencias explícitas al entorno. Replay restaura únicamente esos marcadores, conservando los bytes y el escape JSON; cualquier variable que falte detiene el envío.

Los resultados y `.env` están ignorados por Git. Se crean directorios privados y archivos con modo 0600 en Linux. Si un perfil incluía credenciales literales, replay solicitará una variable como `REPLAY_AUTHORIZATION`; es preferible usar referencias desde el perfil inicial.

Código de salida: 0 para acceso comprobado, 1 para fallo y 2 para comparación inconclusa.

## Verificación

```bash
pnpm test
pnpm typecheck
pnpm build
node dist/cli.js --help
```

Las pruebas levantan servidores HTTP locales: no consultan Altenar ni consumen cuota de Microlink. Cubren GET/POST, una sola llamada al servicio, replay independiente, .env, redacción de credenciales, errores y timeouts.

`MICROLINK_ENDPOINT` selecciona el endpoint del servicio. Por defecto es `https://api.microlink.io`, que nunca recibe la clave. `https://pro.microlink.io` requiere `MICROLINK_API_KEY`. Los endpoints alternativos explícitos (por ejemplo, servidores locales de prueba) reciben la clave configurada.

Referencias oficiales: [JSON endpoints](https://microlink.io/use-cases/scraping/json-endpoints), [Functions](https://microlink.io/docs/api/parameters/function), [cabeceras](https://microlink.io/docs/api/parameters/headers), [arquitectura de Functions](https://microlink.io/blog/optimizing-microlink-functions).
