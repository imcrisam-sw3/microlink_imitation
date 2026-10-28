import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, rm } from 'node:fs/promises';
import { test } from 'node:test';

async function runner() {
  const imported = await import('../src/check-bot.ts');
  assert.equal(typeof imported.runCheck, 'function', 'Falta runCheck para el flujo configurable');
  return imported;
}
async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return 'http://127.0.0.1:' + server.address().port;
}
function cleanup(t, directory) {
  t.after(() => rm(directory, { recursive: true, force: true }));
}
const request = url => ({ method: 'GET', url, headers: {} });

test('comparison counts every HTTP status, writes results by client and reports every configured interval', async t => {
  const { runCheck } = await runner();
  const codes = [200, 403, 429, 418, 200];
  let calls = 0;
  const url = await serve(t, (_req, res) => {
    const status = codes[calls++ % codes.length];
    res.writeHead(status, status === 403 ? { 'cf-mitigated': 'challenge' } : { 'content-type': 'application/json' });
    res.end('{"status":' + status + '}');
  });
  const logs = [];
  const summary = await runCheck({
    request: request(url), clients: ['utls', 'tls'], requestsPerClient: 5, reportEvery: 2,
  }, (...args) => logs.push(args.join(' ')));
  cleanup(t, summary.directory);
  assert.equal(calls, 10);
  assert.equal(summary.clients.length, 2);
  for (const client of summary.clients) {
    assert.equal(client.attempted, 5);
    assert.deepEqual(client.statusCounts, { 200: 2, 403: 1, 429: 1, 418: 1 });
    assert.equal(client.errors, 0);
    assert.equal(client.antibotDetections, 1);
    const files = await readdir(summary.directory + '/' + client.client);
    assert.equal(files.filter(file => /^\d+\.json$/.test(file)).length, 5);
    const first = JSON.parse(await readFile(summary.directory + '/' + client.client + '/000001.json', 'utf8'));
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { status: 200 });
    assert.ok(first.userAgent);
    assert.equal(typeof first.isBot, 'boolean');
  }
  for (const client of ['utls', 'tls']) {
    for (const count of [2, 4, 5]) assert.ok(logs.includes('Reporte ' + client + ' ' + count + '/5'));
  }
  assert.equal(logs.filter(line => line.startsWith('Reporte ')).length, 6);
  assert.ok(logs.some(line => line.includes('Resumen final')));
  assert.deepEqual(JSON.parse(await readFile(summary.directory + '/summary.json', 'utf8')), summary);
});

test('comparison sends POST objects unchanged and stores text responses without assuming JSON', async t => {
  const { runCheck } = await runner();
  let received;
  const url = await serve(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received = { method: req.method, headers: req.headers, body: JSON.parse(body) };
    res.writeHead(201, { 'set-cookie': 'private-session=do-not-save' });
    res.end('plain response');
  });
  const configured = { method: 'POST', url, headers: { Authorization: 'Bearer private-key', 'X-Test': 'keep' }, body: { value: [1, 2] } };
  const original = structuredClone(configured);
  const summary = await runCheck({ request: configured, clients: ['utls'], requestsPerClient: 1, reportEvery: 5 }, () => {});
  cleanup(t, summary.directory);
  assert.equal(received.method, 'POST');
  assert.equal(received.headers.authorization, 'Bearer private-key');
  assert.deepEqual(received.body, { value: [1, 2] });
  assert.deepEqual(configured, original);
  const result = JSON.parse(await readFile(summary.directory + '/utls/000001.json', 'utf8'));
  assert.equal(result.status, 201);
  assert.equal(result.body, 'plain response');
  assert.equal(result.headers['set-cookie'], '[REDACTED]');
  const savedConfig = await readFile(summary.directory + '/request.json', 'utf8');
  assert.doesNotMatch(savedConfig, /private-key/);
});

test('comparison records connection errors without inventing a status and continues with the next client', async t => {
  const { runCheck } = await runner();
  let calls = 0;
  const url = await serve(t, (req, res) => {
    calls++;
    if (calls <= 2) req.socket.destroy();
    else res.end('ok');
  });
  const summary = await runCheck({ request: request(url), clients: ['utls', 'tls'], requestsPerClient: 2, reportEvery: 1 }, () => {});
  cleanup(t, summary.directory);
  assert.equal(summary.clients[0].attempted, 2);
  assert.equal(summary.clients[0].errors, 2);
  assert.deepEqual(summary.clients[0].statusCounts, {});
  assert.equal(summary.clients[1].statusCounts[200], 2);
  const failed = JSON.parse(await readFile(summary.directory + '/utls/000001.json', 'utf8'));
  assert.equal(failed.status, null);
  assert.equal(typeof failed.error, 'string');
});

test('comparison observes Impers native User-Agent locally without adding destination requests', async t => {
  const { runCheck } = await runner();
  let agent; let calls = 0;
  const url = await serve(t, (req, res) => { agent = req.headers['user-agent']; calls++; res.end('ok'); });
  const summary = await runCheck({ request: request(url), clients: ['impers'], requestsPerClient: 1, reportEvery: 1 }, () => {});
  cleanup(t, summary.directory);
  assert.equal(calls, 1);
  assert.equal(summary.clients[0].userAgent, agent);
  assert.match(agent, /iPhone/);
  assert.equal(summary.clients[0].identityRequests, 1);
  const result = JSON.parse(await readFile(summary.directory + '/impers/000001.json', 'utf8'));
  assert.equal(result.userAgent, agent);
});

test('comparison lists all existing clients and rejects invalid configuration before requests', async () => {
  const { runCheck, AVAILABLE_CLIENTS } = await runner();
  assert.deepEqual(Object.keys(AVAILABLE_CLIENTS).sort(), ['fingerprint', 'impers', 'microlink', 'tls', 'utls']);
  for (const override of [{ requestsPerClient: 0 }, { reportEvery: 0 }, { clients: ['unknown'] }, { request: request('file:///etc/passwd') }]) {
    await assert.rejects(runCheck({
      request: request('http://127.0.0.1:1'), clients: ['utls'], requestsPerClient: 1, reportEvery: 1, ...override,
    }, () => {}));
  }
});

test('comparison counts Microlink destination statuses instead of its API HTTP 200', async t => {
  const { runCheck } = await runner();
  const previous = process.env.MICROLINK_ENDPOINT;
  t.after(() => { if (previous === undefined) delete process.env.MICROLINK_ENDPOINT; else process.env.MICROLINK_ENDPOINT = previous; });
  let calls = 0;
  const endpoint = await serve(t, (_req, res) => {
    calls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      status: 'success',
      headers: { 'cf-mitigated': 'challenge' },
      data: { function: { isFulfilled: true, value: {
        userAgent: 'Googlebot/2.1', statusCode: 403, rawBody: '<html>challenge</html>',
      } } },
    }));
  });
  process.env.MICROLINK_ENDPOINT = endpoint;
  const summary = await runCheck({
    request: request('https://destination.example/'), clients: ['microlink'], requestsPerClient: 2, reportEvery: 1,
  }, () => {});
  cleanup(t, summary.directory);
  assert.equal(calls, 2);
  assert.deepEqual(summary.clients[0].statusCounts, { 403: 2 });
  assert.equal(summary.clients[0].isBot, true);
  assert.equal(summary.clients[0].antibotDetections, 2);
});

test('comparison accepts Microlink POST result shape and keeps an unavailable User-Agent unknown', async t => {
  const { runCheck } = await runner();
  const previous = process.env.MICROLINK_ENDPOINT;
  t.after(() => { if (previous === undefined) delete process.env.MICROLINK_ENDPOINT; else process.env.MICROLINK_ENDPOINT = previous; });
  process.env.MICROLINK_ENDPOINT = await serve(t, (req, res) => {
    assert.equal(new URL(req.url, 'http://local').searchParams.get('prerender'), 'false');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: { function: { isFulfilled: true, value: {
      status: 202, headers: { 'content-type': 'text/plain' }, body: 'accepted',
    } } } }));
  });
  const summary = await runCheck({
    request: { method: 'POST', url: 'https://destination.example/', headers: {}, body: { value: 1 } },
    clients: ['microlink'], requestsPerClient: 1, reportEvery: 1,
  }, () => {});
  cleanup(t, summary.directory);
  assert.deepEqual(summary.clients[0].statusCounts, { 202: 1 });
  assert.equal(summary.clients[0].userAgent, null);
  assert.equal(summary.clients[0].isBot, null);
  const result = JSON.parse(await readFile(summary.directory + '/microlink/000001.json', 'utf8'));
  assert.equal(result.body, 'accepted');
});

test('comparison does not invent a destination status when Microlink diagnostics are unavailable', async t => {
  const { runCheck } = await runner();
  const previous = process.env.MICROLINK_ENDPOINT;
  t.after(() => { if (previous === undefined) delete process.env.MICROLINK_ENDPOINT; else process.env.MICROLINK_ENDPOINT = previous; });
  process.env.MICROLINK_ENDPOINT = await serve(t, (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'fail', data: { function: { isFulfilled: false, value: 'unavailable' } } }));
  });
  const summary = await runCheck({
    request: request('https://destination.example/'), clients: ['microlink'], requestsPerClient: 1, reportEvery: 1,
  }, () => {});
  cleanup(t, summary.directory);
  assert.deepEqual(summary.clients[0].statusCounts, {});
  assert.equal(summary.clients[0].errors, 1);
});

test('comparison keeps the observed status and antibot headers when reading the body fails', async t => {
  const { runCheck } = await runner();
  const url = await serve(t, (_req, res) => {
    res.writeHead(403, { 'cf-mitigated': 'challenge' });
    res.write('partial');
    setTimeout(() => res.destroy(), 20);
  });
  const summary = await runCheck({
    request: request(url), clients: ['tls'], requestsPerClient: 1, reportEvery: 1,
  }, () => {});
  cleanup(t, summary.directory);
  assert.deepEqual(summary.clients[0].statusCounts, { 403: 1 });
  assert.equal(summary.clients[0].errors, 1);
  assert.equal(summary.clients[0].antibotDetections, 1);
});

test('comparison reports the User-Agent actually supplied to uTLS in request headers', async t => {
  const { runCheck } = await runner();
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  let observed;
  const url = await serve(t, (req, res) => { observed = req.headers['user-agent']; res.end('ok'); });
  const logs = [];
  const summary = await runCheck({
    request: { method: 'GET', url, headers: { 'User-Agent': userAgent } },
    clients: ['utls'], requestsPerClient: 1, reportEvery: 1,
  }, (...args) => logs.push(args.join(' ')));
  cleanup(t, summary.directory);
  assert.equal(observed, userAgent);
  assert.equal(summary.clients[0].userAgent, userAgent);
  assert.equal(summary.clients[0].isBot, false);
  assert.ok(logs.includes('User-Agent: ' + userAgent));
  const result = JSON.parse(await readFile(summary.directory + '/utls/000001.json', 'utf8'));
  assert.equal(result.userAgent, userAgent);
  assert.equal(result.isBot, false);
});

test('comparison respects fixed identities of TLS and Fingerprint instead of reporting an ignored request User-Agent', async t => {
  const { runCheck } = await runner();
  const observed = [];
  const url = await serve(t, (req, res) => { observed.push(req.headers['user-agent']); res.end('ok'); });
  const summary = await runCheck({
    request: { method: 'GET', url, headers: { 'User-Agent': 'Googlebot/2.1' } },
    clients: ['tls', 'fingerprint'], requestsPerClient: 1, reportEvery: 1,
  }, () => {});
  cleanup(t, summary.directory);
  assert.equal(observed.length, 2);
  for (const [index, client] of summary.clients.entries()) {
    assert.equal(client.userAgent, observed[index]);
    assert.notEqual(client.userAgent, 'Googlebot/2.1');
  }
});

test('comparison redacts URL secrets from errors, logs and saved request results', async t => {
  const { runCheck } = await runner();
  const url = await serve(t, req => req.socket.destroy());
  const logs = [];
  const summary = await runCheck({
    request: request(url + '/?token=FAKE_SECRET_SENTINEL'),
    clients: ['utls'], requestsPerClient: 1, reportEvery: 1,
  }, (...args) => logs.push(args.join(' ')));
  cleanup(t, summary.directory);
  const result = await readFile(summary.directory + '/utls/000001.json', 'utf8');
  assert.doesNotMatch(result, /FAKE_SECRET_SENTINEL/);
  assert.doesNotMatch(logs.join('\n'), /FAKE_SECRET_SENTINEL/);
  assert.match(result, /REDACTED/);
});
