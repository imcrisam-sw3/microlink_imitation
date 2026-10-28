# Cliente uTLS independiente

Aprobado en la conversación: añadir un cliente nuevo; compilar Go con Docker y ejecutar el binario automáticamente desde Node, sin instalar Go en Windows, WSL o el contenedor Node.

## Diseño
- `src/client/UtlsClient.ts`: misma interfaz get/post/close y ready opcional. Un proceso Go por instancia, iniciado bajo demanda; JSON por líneas en stdin/stdout y logs por stderr.
- `native/utls/`: módulo Go independiente con uTLS v1.8.2 y transporte HTTP/1.1 o HTTP/2 según ALPN. Sesión de cookies y conexiones propia; verificación de certificados activa, con CA adicional opcional.
- Perfil TLS seleccionable (chrome/firefox/safari/ios). El perfil no genera headers de navegador; los headers son explícitos e independientes.
- Cancelación, timeout, redirecciones, errores de proceso y cierre idempotente. Respuestas almacenadas en memoria hasta 16 MiB.
- Etapa de compilación Docker, binario estático en /usr/local/bin del Dev Container y comando de compilación desde WSL para el contenedor actual.

## Alternativas
Proceso persistente por instancia (elegido en la propuesta aceptada) conserva sesión sin crear puertos. Un servicio HTTP local añade despliegue y una interfaz de red innecesarios. Un proceso por petición pierde continuidad y reutilización.

## Límites
No modificar los otros clientes, legacy, ni el arranque manual actual. No ejecutar peticiones a proveedores externos. HTTP/2 funcional no implica reproducir la huella HTTP/2 de un navegador. Conexiones directas, sin soporte de proxy en esta versión.

Se trabaja en el checkout actual porque contiene la reorganización local no confirmada de la que depende la integración; no se cambia de rama ni se incluyen cambios ajenos en commits.
