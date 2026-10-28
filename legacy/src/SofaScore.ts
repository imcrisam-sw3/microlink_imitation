export class SofaScore {
  getRequest = {
    url: 'https://www.sofascore.com/api/v1/sport/football/events/live',
    method: 'GET',
    headers: {
      accept: '*/*',
      'accept-language': 'es-ES,es;q=0.8',
      'cache-control': 'max-age=0',
      priority: 'u=1, i',
      'x-requested-with': '6b2268',
      Referer: 'https://www.sofascore.com/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
      'sec-ch-ua': '"Brave";v="153", "Not_A Brand";v="8", "Chromium";v="153"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'sec-gpc': '1',
    },
  };

  getStatisticsRequest(eventId: number, referer = this.getRequest.headers.Referer) {
    if (!Number.isSafeInteger(eventId) || eventId <= 0) {
      throw new RangeError('eventId debe ser un entero positivo válido.');
    }

    return {
      url: `https://www.sofascore.com/api/v1/event/${eventId}/statistics`,
      method: 'GET',
      headers: {
        ...this.getRequest.headers,
        Referer: referer,
      },
    };
  }
}
