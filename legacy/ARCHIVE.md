# Archivo del proyecto anterior

El contenido original, incluido README, código, pruebas, resultados y configuración, se conserva tal como estaba antes de la reorganizacion. Este documento se agrega como índice; no sustituye el README original.

Los comandos anteriores siguen registrados en `package.json` y explicados en `README.md`:

| Comando anterior | Entrada archivada |
| --- | --- |
| `pnpm start` | `src/main.ts` |
| `pnpm start:sofascore` | `src/main-sofascore.ts` |
| `pnpm probe:clients` | `src/probe-clients.ts` |
| `pnpm probe:mock` | `src/mock/main.ts` |

Estas rutas son relativas a `legacy`. Los scripts conservan sus requisitos originales, incluida la carga de `.env`. El `.env` operativo y las dependencias instaladas permanecen en la raíz del proyecto; no se duplicaron credenciales en este archivo histórico. Los comandos de la raíz usan la estructura nueva.
