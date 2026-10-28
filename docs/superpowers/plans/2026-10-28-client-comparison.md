# Client Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reemplazar el CLI anterior por el flujo configurable solicitado de comparación de clientes.
**Architecture:** Configuración editable al inicio de check-bot.ts; registro pequeño de cinco clientes, adaptador para Microlink, ejecución secuencial y persistencia temporal por petición.
**Tech Stack:** TypeScript, clientes y detectores existentes, fs/promises, os.tmpdir.
**Spec:** Especificación del usuario en esta conversación: objetos GET/POST, clientes seleccionados/disponibles, logs por agente, reportes cada N, cantidad configurable, conteos de todos los status, resultados temporales separados y resumen final.

## Global Constraints
- No cambiar los otros clientes ni la reorganización local.
- Contar N peticiones al destino por cliente; la captura local de identidad Impers se informa aparte.
- No hacer peticiones externas durante implementación y pruebas.
- Errores sin respuesta no se convierten en status HTTP inventados.
- User-Agent/isbot desconocidos se registran como null.
- Archivos temporales únicos por ejecución, un JSON por petición y summary.json final.

## Review Focus
- Errores de un cliente no abortan los siguientes.
- Reporte final cuando N no es múltiplo del intervalo.
- Identidad nativa de Impers observada, no inferida por el nombre del perfil.
- Microlink distingue status del destino del estado de su API.
- POST, cabeceras, body y estado HTTP permanecen intactos; se ocultan credenciales conocidas en los resultados.

### Task 1: Flujo y pruebas
- [x] Sustituir tests/check-bot.test.mjs por pruebas del flujo pedido y comprobar RED.
- [x] Reescribir src/check-bot.ts con constantes iniciales, runCheck y registro de clientes.
- [x] Comprobar GET/POST reales locales, reportes, errores y archivos separados.
### Task 2: Cierre
- [x] Actualizar README para la configuración editable.
- [x] Suite completa, typecheck, build y ejecución local del código compilado.
