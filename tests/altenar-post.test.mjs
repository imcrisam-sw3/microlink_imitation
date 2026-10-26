import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Altenar } from '../src/Altenar.ts';
import { TlsClient } from '../src/TlsClient.ts';
import { FingerprintClient } from '../src/FingerprintClient.ts';

for (const Client of [TlsClient, FingerprintClient]) {
  test(`${Client.name} obtains its own token before posting the updated odds`, async () => {
    const received = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      received.push({ method: req.method, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.method === 'GET'
        ? { YUdGb1lTQmtiMjRuZENCbGRtVnVJSFJ5ZVE: 'literal-test-token' }
        : { oddStates: [{ id: 4708159870, intEventId: 18096674, intSelectionId: 3179, price: 2.4286 }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new Client();
    try {
      const altenar = new Altenar();
      const url = `http://127.0.0.1:${server.address().port}`;
      altenar.getRequest.url = url;
      altenar.postRequest.url = url;
      const response = await altenar.getOddsStates(client);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.oddStates[0].id, 4708159870);
      assert.deepEqual(received.map(item => item.method), ['GET', 'POST']);
      assert.equal(received[1].headers.authorization, 'literal-test-token');
      assert.equal(received[1].headers['user-agent'], received[0].headers['user-agent']);
      assert.equal(received[1].headers.origin, received[0].headers.origin);
      assert.equal(received[1].headers.referer, received[0].headers.referer);
      const posted = JSON.parse(received[1].body);
      assert.equal(posted.integration, 'ondabet');
      assert.equal(posted.odds[0].oddId, 4708159870);
      assert.equal(posted.odds[0].eventId, 18096674);
      assert.equal(posted.odds[0].intSelectionId, 3179);
      assert.equal(posted.odds[0].price, 2.4286);
      assert.equal('oddStates' in posted, false);
      assert.equal(altenar.postRequest.headers.authorization.includes('literal-test-token'), false);
    } finally {
      await client.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

for (const [name, status, body] of [
  ['null token', 200, '{"YUdGb1lTQmtiMjRuZENCbGRtVnVJSFJ5ZVE":null}'],
  ['unexpected JSON shape', 200, '{"message":"not a token"}'],
  ['HTML denial', 403, '<html>Blocked</html>'],
  ['non-JSON response', 200, '<html>Unexpected</html>'],
]) {
  test(`does not POST after ${name}`, async () => {
    let calls = 0;
    const server = createServer((req, res) => { calls++; res.statusCode = status; res.end(body); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new TlsClient();
    try {
      const altenar = new Altenar();
      const url = `http://127.0.0.1:${server.address().port}`;
      altenar.getRequest.url = url;
      altenar.postRequest.url = url;
      await assert.rejects(() => altenar.getOddsStates(client), /token/i);
      assert.equal(calls, 1);
    } finally {
      await client.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
