# uTLS Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Cliente uTLS independiente, compilado con Docker y administrado desde TypeScript.
**Architecture:** Worker Go persistente con JSON por líneas. Node adapta la respuesta y controla el ciclo de vida.
**Tech Stack:** Node 24, TypeScript, Go 1.26, uTLS 1.8.2, x/net HTTP/2.
**Spec:** docs/superpowers/specs/2026-10-28-utls-client-design.md

## Global Constraints
- Conservar todos los cambios locales y los otros clientes.
- TLS verificado; no peticiones externas en pruebas.
- La creación de un cliente no inicia procesos; get/post/ready sí.
- stdout se reserva para el protocolo; stderr para logs.

## Review Focus
- Cancelación durante arranque o lectura del body.
- Caída del worker con peticiones pendientes.
- Selección ALPN h2 y fallback HTTP/1.1.
- Certificado no confiable y CA adicional.
- Respuesta grande y cierre con peticiones activas.

### Task 1: Worker y transporte
Files: native/utls/go.mod, go.sum, transport.go, transport_test.go, main.go, .devcontainer/workspace.Dockerfile.
Interface: newTransport(profile string, roots *x509.CertPool); RoundTrip y CloseIdleConnections.
- [x] Escribir pruebas de HTTPS, ALPN, reutilización, perfiles y verificación TLS; comprobar RED.
- [x] Implementar transporte y worker con cookies, cancelación, redirecciones y límite de body.
- [x] Compilar y ejecutar go test -race mediante Docker.

### Task 2: Cliente TypeScript
Files: src/client/UtlsClient.ts, tests/utls-client.test.mjs.
Interface: constructor({ profile, headers, timeoutMs, binaryPath, caFile }); get/post/ready/close.
- [x] Escribir pruebas de contrato, sesión, concurrencia, timeout, aborto y fallos de proceso; comprobar RED.
- [x] Implementar el adaptador sin imports de otros clientes o motores.
- [x] Ejecutar pruebas con el binario Go real.

### Task 3: Integración y verificación
Files: scripts/build-utls.sh, package.json, .gitignore, README.md, src/main.ts, .devcontainer/workspace.Dockerfile.
- [x] Añadir compilación con Docker y ejemplo comentado.
- [x] Instalar el binario en el contenedor actual sin recrearlo.
- [x] Ejecutar suite completa, typecheck, build, go test -race y smoke del código compilado.
- [x] Revisar sólo los archivos de esta tarea y registrar el resultado.
