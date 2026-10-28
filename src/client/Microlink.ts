export class Microlink {
  endpoint = process.env.MICROLINK_ENDPOINT || 'https://api.microlink.io';
  apiKey = process.env.MICROLINK_API_KEY || '';

  async get(url: string, headers: Record<string, string> = {}) {
    console.log('[Microlink.get] Inicio');
    console.log('URL destino:', url);
    console.log('Método destino: GET');
    console.log('Cabeceras destino:', JSON.stringify(redactHeaders(headers), null, 2));
    console.log('Body destino:', null);

    // La Function inspecciona la respuesta de la navegación, sin otro fetch al destino.
    const functionCode = `async ({ page, response }) => {
      const redactBody = ${redactBody.toString()};
      const requestHeaders = response.request().headers();
      return {
        userAgent: requestHeaders['user-agent'] ?? requestHeaders['User-Agent'] ?? null,
        statusCode: response.status(),
        rawBody: redactBody(await response.text()),
      };
    }`;

    const params = new URLSearchParams({
      url,
      meta: 'false',
      prerender: 'true',
      retry: '0',
      'data.content.attr': 'json',
      function: functionCode,
    });

    const microlinkUrl = new URL(this.endpoint);
    microlinkUrl.search = params.toString();

    const microlinkHeaders: Record<string, string> = { accept: 'application/json' };
    if (microlinkUrl.hostname === 'pro.microlink.io' && this.apiKey) {
      microlinkHeaders['x-api-key'] = this.apiKey;
    }
    for (const [name, value] of Object.entries(headers)) {
      microlinkHeaders['x-api-header-' + name] = value;
    }

    console.log('URL Microlink:', microlinkUrl.toString());
    console.log('Método Microlink: GET');
    console.log('Cabeceras Microlink:', JSON.stringify(redactHeaders(microlinkHeaders), null, 2));
    console.log('Body Microlink:', null);

    const response = await fetch(microlinkUrl, { method: 'GET', headers: microlinkHeaders });
    console.log('Estado HTTP Microlink:', response.status);
    console.log('Cabeceras respuesta Microlink:', JSON.stringify(redactHeaders(Object.fromEntries(response.headers)), null, 2));

    const data = await response.json();
    if (data.data && 'content' in data.data) {
      data.data.content = JSON.parse(redactBody(JSON.stringify(data.data.content)));
    }
    if (data.headers) data.headers = redactHeaders(data.headers);

    const diagnostic = data.data?.function;
    if (diagnostic?.isFulfilled && typeof diagnostic.value?.rawBody === 'string') {
      diagnostic.value.rawBody = redactBody(diagnostic.value.rawBody);
      console.log('User-Agent efectivo destino:', diagnostic.value.userAgent);
      console.log('Estado HTTP destino:', diagnostic.value.statusCode);
      console.log('Cuerpo original destino (tokens ocultos):', diagnostic.value.rawBody);
    } else {
      console.log('Diagnóstico destino no disponible:', diagnostic?.value ?? data.code ?? data.status);
    }
    console.log('Respuesta completa Microlink:', JSON.stringify(data, null, 2));
    console.log('[Microlink.get] Fin');
    return data;
  }

  async post(url: string, body: unknown, headers: Record<string, string> = {}) {
    console.log('[Microlink.post] Inicio');
    console.log('URL destino:', url);
    console.log('Método destino: POST');
    console.log('Cabeceras destino:', JSON.stringify(headers, null, 2));
    console.log('Body destino:', JSON.stringify(body, null, 2));

    // Microlink recibe un GET; esta Function hace el POST al destino.
    const bodyText = JSON.stringify(body);
    const functionCode = `async ({ url, headers }) => {
      const body = ${JSON.stringify(bodyText)};
      console.log('Petición POST destino:', JSON.stringify({ url, method: 'POST', headers, body }, null, 2));

      const response = await fetch(url, { method: 'POST', headers, body });
      const responseHeaders = Object.fromEntries(response.headers);
      const responseBody = await response.text();

      console.log('Estado HTTP destino:', response.status);
      console.log('Cabeceras respuesta destino:', JSON.stringify(responseHeaders, null, 2));
      console.log('Body respuesta destino:', responseBody);
      return { status: response.status, headers: responseHeaders, body: responseBody };
    }`;
    console.log('Function POST:', functionCode);

    const params = new URLSearchParams({
      url,
      meta: 'false',
      prerender: 'false',
      retry: '0',
      function: functionCode,
    });

    const microlinkUrl = new URL(this.endpoint);
    microlinkUrl.search = params.toString();

    const microlinkHeaders: Record<string, string> = { accept: 'application/json' };
    if (microlinkUrl.hostname === 'pro.microlink.io' && this.apiKey) {
      microlinkHeaders['x-api-key'] = this.apiKey;
    }
    for (const [name, value] of Object.entries(headers)) {
      microlinkHeaders['x-api-header-' + name] = value;
    }

    console.log('URL Microlink:', microlinkUrl.toString());
    console.log('Método Microlink: GET');
    console.log('Cabeceras Microlink:', JSON.stringify(microlinkHeaders, null, 2));
    console.log('Body Microlink:', null);

    const response = await fetch(microlinkUrl, { method: 'GET', headers: microlinkHeaders });
    console.log('Estado HTTP Microlink:', response.status);
    console.log('Cabeceras respuesta Microlink:', JSON.stringify(Object.fromEntries(response.headers), null, 2));

    const data = await response.json();
    console.log('Respuesta completa Microlink:', JSON.stringify(data, null, 2));
    console.log('[Microlink.post] Fin');
    return data;
  }
}

// Los nombres opacos del proveedor impiden identificar el token por su clave.
// Se ocultan todos los valores string del JSON, conservando claves y formato.
function redactBody(body: string): string {
  try {
    JSON.parse(body);
    return body.replace(/"(?:\\.|[^"\\])*"(\s*:)?/g, (match, key) =>
      key ? match : '"[REDACTED_TOKEN]"');
  } catch {
    return body.replace(/\bBearer\s+[^\s"'<>]+|\b[A-Za-z0-9_+/-]{24,}(?:\.[A-Za-z0-9_-]+)*={0,2}|^[A-Za-z0-9_.+/-]+={0,2}$/g, '[REDACTED_TOKEN]');
  }
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    /authorization|cookie|api-key|token/i.test(name) ? '[REDACTED_TOKEN]' : value,
  ]));
}
