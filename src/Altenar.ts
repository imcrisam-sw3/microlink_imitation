type HttpResponse = {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
};

type HttpClient = {
  get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
  post(url: string, body: unknown, headers?: Record<string, string>): Promise<HttpResponse>;
};

export class Altenar {
  getRequest = {
    url: 'https://sb2integration-altenar2.biahosted.com/api/M1pYSjBlV2hxYm5Oa0lHMHNMbU1nYW/Y21GdVpHOXRJR0oxYkd4emFHbDBJR2R2?culture=es-ES&timezoneOffset=300&integration=ondabet&deviceType=1&numFormat=en-GB&ge3F6uCFVIZiI=ondabet',
    method: 'GET',
    headers: {
      accept: '*/*',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      'accept-language': 'es-ES,es;q=0.8',
      priority: 'u=1, i',
      Origin: 'https://divinoplay.com',
      Referer: 'https://divinoplay.com/',
    },
  };

  postRequest = {
    url: 'https://sb2frontend-altenar2.biahosted.com/api/Widget/GetOddsStates',
    method: 'POST',
    headers: {
      accept: '*/*',
      'accept-language': 'es-ES,es;q=0.8',
      authorization: process.env.ALTENAR_AUTHORIZATION || '',
      'content-type': 'application/json',
      priority: 'u=1, i',
      Origin: 'https://divinoplay.com',
      Referer: 'https://divinoplay.com/',
    },
    body: {
      culture: 'es-ES',
      timezoneOffset: 300,
      integration: 'ondabet',
      deviceType: 1,
      numFormat: 'en-GB',
      countryCode: 'CO',
      odds: [
        {
          oddId: 4634506256,
          price: 2.4286,
          eventId: 17996917,
          marketTypeId: 1,
          selectionTypeId: 1,
          sportTypeId: 1,
          isBoost: false,
          marketSliceType: 0,
          intSelectionId: 3179,
        },
      ],
    },
  };

  async getOddsStates(client: HttpClient) {
    const response = await client.get(this.getRequest.url, this.getRequest.headers);
    const body = await response.text();
    if (!response.ok) throw new Error(`GET token devolvió HTTP ${response.status}.`);

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error('GET token no devolvió JSON válido.');
    }
    // Clave observada en la respuesta de bootstrap de Altenar.
    const token = payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)['YUdGb1lTQmtiMjRuZENCbGRtVnVJSFJ5ZVE']
      : undefined;
    if (typeof token !== 'string' || !token.trim()) {
      throw new Error('GET token no devolvió un token válido; no se enviará el POST.');
    }

    return client.post(this.postRequest.url, this.postRequest.body, {
      ...this.postRequest.headers,
      // Autorización literal, con el token obtenido por este mismo cliente.
      authorization: token,
    });
  }
}
