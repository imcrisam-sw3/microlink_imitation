import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

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

test('comparison replaces the previous run in one fixed repository directory', async t => {
  const { runCheck } = await runner();
  let phase = 'first';
  const url = await serve(t, (_req, res) => res.end(phase));
  const first = await runCheck({
    request: request(url + '/first'), clients: ['tls', 'utls'], requestsPerClient: 2, reportEvery: 2,
  }, () => {});
  cleanup(t, first.directory);
  assert.equal(first.directory, fileURLToPath(new URL('../results/check-bot', import.meta.url)));
  assert.equal(JSON.parse(await readFile(first.directory + '/tls/000001.json', 'utf8')).body, 'first');

  phase = 'second';
  const second = await runCheck({
    request: request(url + '/second'), clients: ['tls'], requestsPerClient: 1, reportEvery: 1,
  }, () => {});
  cleanup(t, second.directory);
  assert.equal(second.directory, first.directory);
  assert.deepEqual((await readdir(second.directory)).sort(), ['request.json', 'summary.json', 'tls']);
  assert.deepEqual(await readdir(second.directory + '/tls'), ['000001.json']);
  assert.equal(JSON.parse(await readFile(second.directory + '/tls/000001.json', 'utf8')).body, 'second');
  assert.equal(JSON.parse(await readFile(second.directory + '/request.json', 'utf8')).url, url + '/second');
  assert.deepEqual(JSON.parse(await readFile(second.directory + '/summary.json', 'utf8')), second);
});


const resetConfig = { enabled: true, consecutive: 2, statusCodes: [403, 400] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const name of ['tls', 'fingerprint', 'impers', 'utls']) {
  test(name + ' batches execute concurrently and reuse changeProfile only after the batch finishes', { timeout: 10000 }, async t => {
    const { runCheck } = await runner();
    const classes = {
      tls: ['TlsClient', '../src/client/TlsClient.ts'],
      fingerprint: ['FingerprintClient', '../src/client/FingerprintClient.ts'],
      impers: ['ImpersClient', '../src/client/ImpersClient.ts'],
      utls: ['UtlsClient', '../src/client/UtlsClient.ts'],
    };
    const [className, modulePath] = classes[name];
    const Client = (await import(modulePath))[className];
    const original = Client.prototype.changeProfile;
    let calls = 0; let active = 0; let peak = 0; let changes = 0;
    const agents = [];
    const changedProfiles = [];
    const { BotDetector } = await import('../src/tool/BotDetector.ts');
    const detector = t.mock.method(BotDetector.prototype, 'check');
    t.mock.method(Client.prototype, 'changeProfile', async function (...args) {
      assert.equal(active, 0, 'Cambió de perfil con respuestas pendientes');
      assert.equal(args.length, 0, 'El runner debe usar la selección automática existente');
      changes++;
      const next = await original.apply(this, args);
      changedProfiles.push(next.impersonate ?? next.profile ?? next.userAgent);
      return next;
    });
    const url = await serve(t, (req, res) => {
      const index = calls++;
      agents.push(req.headers['user-agent']);
      active++; peak = Math.max(peak, active);
      res.on('close', () => active--);
      setTimeout(() => { res.writeHead(index < 6 ? (index % 2 ? 400 : 403) : 200); res.end(JSON.stringify({ userAgent: req.headers['user-agent'] })); }, index % 3 === 0 ? 35 : 15);
    });
    const logs = [];
    const logCalls = [];
    const summary = await runCheck({
      request: request(url), clients: [name], requestsPerClient: 7, reportEvery: 2,
      concurrency: 3, intervalMs: 0, profileReset: resetConfig,
    }, (...args) => { logCalls.push(args); logs.push(args.join(' ')); });
    cleanup(t, summary.directory);
    assert.equal(calls, 7);
    assert.equal(peak, 3, 'La concurrencia no llegó realmente al servidor');
    assert.equal(changes, 2);
    const stats = summary.clients[0];
    assert.equal(stats.profileChanges, 2);
    assert.equal(stats.profileChangeError, null);
    assert.equal(stats.attempted, 7);
    assert.deepEqual(stats.statusCounts, { 200: 1, 400: 3, 403: 3 });
    assert.equal(stats.errors, 0);
    assert.equal(stats.identityRequests, name === 'impers' ? 3 : 0);
    const generations = [];
    for (let attempt = 1; attempt <= 7; attempt++) {
      const result = JSON.parse(await readFile(summary.directory + '/' + name + '/' + String(attempt).padStart(6, '0') + '.json', 'utf8'));
      generations.push(result.profileGeneration);
      assert.equal(result.userAgent, result.body.userAgent);
    }
    assert.deepEqual(generations, [1, 1, 1, 2, 2, 2, 3]);
    assert.notEqual(agents[0], agents[3]);
    assert.notEqual(agents[3], agents[6]);
    assert.equal(logs.filter(line => line.startsWith('Reporte ')).length, 4);
    const profileLogs = logCalls.filter(args => String(args[0]).startsWith('Cambio de perfil | '));
    assert.equal(profileLogs.length, 2, 'Debe emitir una línea por cada cambio de perfil');
    for (const [index, args] of profileLogs.entries()) {
      assert.equal(args.length, 1, 'El mensaje debe ser una sola cadena');
      const line = args[0];
      assert.doesNotMatch(line, /[\r\n]/);
      const attempt = index === 0 ? 4 : 7;
      const saved = JSON.parse(await readFile(summary.directory + '/' + name + '/' + String(attempt).padStart(6, '0') + '.json', 'utf8'));
      const label = name === 'impers' || name === 'utls' ? changedProfiles[index] : JSON.stringify(saved.userAgent);
      assert.equal(line, 'Cambio de perfil | cliente=' + name + ' | perfil=' + label +
        ' | generación=' + (index + 2) + ' | intento=' + (index === 0 ? 3 : 6) +
        ' | User-Agent=' + JSON.stringify(saved.userAgent) + ' | isbot=' + saved.isBot);
      assert.ok(detector.mock.calls.some(call => call.arguments[0] === saved.userAgent), 'No se evaluó el nuevo User-Agent con isbot');
    }
    assert.equal(logs.filter(line => line.startsWith('Agente:')).length, 1, 'Se debe conservar sólo el bloque inicial de identidad');

  });
}

function sequenceClient(statuses, delays = []) {
  const state = { sent: 0, changes: 0, active: 0, closed: [] };
  const make = generation => ({
    userAgent: 'local-test/' + generation, identityRequests: 0,
    async send() {
      const index = state.sent++;
      state.active++;
      try {
        if (delays[index]) await pause(delays[index]);
        if (statuses[index] === null) throw new Error('local transport failure');
        return { status: statuses[index], headers: new Headers(), text: async () => 'attempt-' + (index + 1) };
      } finally { state.active--; }
    },
    async changeProfile() {
      assert.equal(state.active, 0);
      state.changes++;
      return make(generation + 1);
    },
    close() { state.closed.push(generation); },
  });
  return { client: make(1), state };
}

for (const scenario of [
  { label: 'uses attempt order instead of completion order', statuses: [403, 200, 400, 200], delays: [5, 35, 10], concurrency: 3, threshold: 2, changes: 0 },
  { label: 'retains a streak across batches', statuses: [200, 403, 400, 403, 200], concurrency: 2, threshold: 3, changes: 1 },
  { label: 'resets the streak after a transport error', statuses: [403, null, 400, 200], concurrency: 1, threshold: 2, changes: 0 },
  { label: 'latches one change despite a later success in the same batch', statuses: [403, 400, 200, 200], concurrency: 3, threshold: 2, changes: 1 },
  { label: 'does not change profiles after the final batch', statuses: [403, 400], concurrency: 2, threshold: 1, changes: 0 },
]) {
  test('profile reset ' + scenario.label, async t => {
    const { runCheck, AVAILABLE_CLIENTS } = await runner();
    const fixture = sequenceClient(scenario.statuses, scenario.delays);
    t.mock.method(AVAILABLE_CLIENTS, 'tls', async () => fixture.client);
    const summary = await runCheck({
      request: request('http://127.0.0.1:1'), clients: ['tls'], requestsPerClient: scenario.statuses.length, reportEvery: 2,
      concurrency: scenario.concurrency, profileReset: { ...resetConfig, consecutive: scenario.threshold },
    }, () => {});
    cleanup(t, summary.directory);
    assert.equal(fixture.state.changes, scenario.changes);
    assert.equal(summary.clients[0].profileChanges, scenario.changes);
    assert.equal(summary.clients[0].attempted, scenario.statuses.length);
    assert.equal(fixture.state.closed.at(-1), scenario.changes + 1);
  });
}

test('batch interval is measured from its start, waits for slow batches and has no final pause', { timeout: 10000 }, async t => {
  const { runCheck, AVAILABLE_CLIENTS } = await runner();
  let clock = 0;
  const starts = [];
  let firstReported;
  const firstBatch = new Promise(resolve => { firstReported = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(AVAILABLE_CLIENTS, 'tls', async () => ({
    userAgent: 'local-clock', identityRequests: 0, close() {},
    async send() {
      const index = starts.length;
      starts.push(clock);
      await Promise.resolve();
      clock = Math.max(clock, index < 2 ? 2000 : 12000);
      return { status: 200, headers: new Headers(), text: async () => 'ok' };
    },
  }));
  const running = runCheck({
    request: request('http://127.0.0.1:1'), clients: ['tls'], requestsPerClient: 5, reportEvery: 2,
    concurrency: 2, intervalMs: 5000,
  }, (...args) => { if (args[0] === 'Reporte tls 2/5') firstReported(); });
  try {
    await firstBatch;
    assert.equal(starts.length, 2);
    clock = 4999; t.mock.timers.tick(2999);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts.length, 2);
    clock = 5000; t.mock.timers.tick(1);
    for (let poll = 0; poll < 2000 && starts.length < 5; poll++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts.length, 5, 'Debe esperar sólo los 3 segundos restantes del intervalo y no pausar tras el lote lento');
    const summary = await running;
    cleanup(t, summary.directory);
    assert.deepEqual(starts, [0, 0, 5000, 5000, 12000]);
    assert.equal(summary.clients[0].attempted, 5);
  } finally {
    clock = 100000; t.mock.timers.tick(100000);
    const summary = await running;
    cleanup(t, summary.directory);
  }
});

test('profile change failure stops that client, closes it and continues with the next one', async t => {
  const { runCheck, AVAILABLE_CLIENTS } = await runner();
  const first = sequenceClient([403, 400]);
  first.client.changeProfile = async () => { throw new Error('local change failure'); };
  const second = sequenceClient([200, 200, 200, 200]);
  t.mock.method(AVAILABLE_CLIENTS, 'tls', async () => first.client);
  t.mock.method(AVAILABLE_CLIENTS, 'utls', async () => second.client);
  const logs = [];
  const summary = await runCheck({
    request: request('http://127.0.0.1:1'), clients: ['tls', 'utls'], requestsPerClient: 4, reportEvery: 2,
    concurrency: 2, profileReset: resetConfig,
  }, (...args) => logs.push(args.join(' ')));
  cleanup(t, summary.directory);
  assert.equal(first.state.sent, 2);
  assert.deepEqual(first.state.closed, [1]);
  assert.equal(summary.clients[0].profileChanges, 0);
  assert.match(summary.clients[0].profileChangeError, /local change failure/);
  assert.equal(summary.clients[0].errors, 1);
  assert.equal(summary.clients[1].attempted, 4);
  assert.equal(summary.clients[1].errors, 0);
  assert.ok(logs.some(line => line.startsWith('Error al cambiar perfil')));
  assert.equal(logs.filter(line => line.startsWith('Cambio de perfil | ')).length, 0);
});

test('new batch options reject invalid values and nonlocal or unsupported resets before requests', async t => {
  const { runCheck, AVAILABLE_CLIENTS } = await runner();
  let created = 0;
  t.mock.method(AVAILABLE_CLIENTS, 'tls', async () => { created++; throw new Error('must not create'); });
  const valid = { request: request('http://127.0.0.1:1'), clients: ['tls'], requestsPerClient: 1, reportEvery: 1 };
  for (const override of [
    { concurrency: 0 }, { concurrency: 1.5 }, { intervalMs: -1 }, { intervalMs: 2147483648 },
    { profileReset: { ...resetConfig, consecutive: 0 } },
    { profileReset: { ...resetConfig, statusCodes: [] } },
    { profileReset: { ...resetConfig, statusCodes: [600] } },
    { profileReset: resetConfig, clients: ['microlink'] },
    { profileReset: resetConfig, request: request('https://www.sofascore.com/api/v1/event/11/statistics') },
    { profileReset: resetConfig, request: request('http://127.0.0.1.example.com/') },
  ]) await assert.rejects(runCheck({ ...valid, ...override }, () => {}));
  assert.equal(created, 0);
});

test('batch options exported at the top remain usable after local configuration edits', async t => {
  const { runCheck, AVAILABLE_CLIENTS, CONCURRENCY, INTERVAL_MS, PROFILE_RESET, REPORT_EVERY } = await runner();
  const fixture = sequenceClient([200]);
  t.mock.method(AVAILABLE_CLIENTS, 'tls', async () => fixture.client);
  const summary = await runCheck({
    request: request('http://127.0.0.1:1'), clients: ['tls'], requestsPerClient: 1,
    reportEvery: REPORT_EVERY, concurrency: CONCURRENCY, intervalMs: INTERVAL_MS, profileReset: PROFILE_RESET,
  }, () => {});
  cleanup(t, summary.directory);
  assert.equal(fixture.state.sent, 1);
  assert.equal(summary.clients[0].errors, 0);
});


for (const name of ['tls', 'fingerprint', 'impers', 'utls']) {
  for (const enabled of [true, false]) {
    test(name + ' POST redirects stay manual only while local profile resets are enabled=' + enabled, async t => {
      const { runCheck } = await runner();
      let forwarded = 0;
      const destination = await serve(t, async (req, res) => {
        forwarded++;
        let body = ''; for await (const chunk of req) body += chunk;
        assert.equal(req.method, 'POST');
        assert.deepEqual(JSON.parse(body), { local: true });
        res.writeHead(403); res.end('redirected');
      });
      const url = await serve(t, (_req, res) => {
        res.writeHead(307, { location: destination }); res.end();
      });
      // Ambos servidores son loopback; no se consulta ningún destino externo.
      const summary = await runCheck({
        request: { method: 'POST', url, headers: {}, body: { local: true } },
        clients: [name], requestsPerClient: 3, reportEvery: 2, concurrency: 2,
        profileReset: { ...resetConfig, enabled },
      }, () => {});
      cleanup(t, summary.directory);
      assert.equal(forwarded, enabled ? 0 : 3);
      assert.deepEqual(summary.clients[0].statusCounts, enabled ? { 307: 3 } : { 403: 3 });
      assert.equal(summary.clients[0].profileChanges, 0);
      assert.equal(summary.clients[0].errors, 0);
    });
  }
}


for (const [userAgent, isBot] of [[null, null], ['Googlebot/2.1', true]]) {
test('new profile log reports ' + (userAgent ?? 'an unavailable User-Agent') + ' and its isbot result on one line', async t => {
  const { runCheck, AVAILABLE_CLIENTS } = await runner();
  const fixture = sequenceClient([403, 400, 200]);
  const change = fixture.client.changeProfile;
  fixture.client.changeProfile = async () => {
    const next = await change();
    next.userAgent = userAgent;
    return next;
  };
  t.mock.method(AVAILABLE_CLIENTS, 'tls', async () => fixture.client);
  const logs = [];
  const summary = await runCheck({
    request: request('http://127.0.0.1:1'), clients: ['tls'], requestsPerClient: 3, reportEvery: 2,
    concurrency: 2, profileReset: resetConfig,
  }, (...args) => logs.push(args.join(' ')));
  cleanup(t, summary.directory);
  const profileLogs = logs.filter(line => line.startsWith('Cambio de perfil | '));
  assert.deepEqual(profileLogs, [
    'Cambio de perfil | cliente=tls | perfil=' + JSON.stringify(userAgent ?? 'desconocido') +
      ' | generación=2 | intento=2 | User-Agent=' + JSON.stringify(userAgent ?? 'desconocido') + ' | isbot=' + (isBot ?? 'desconocido'),
  ]);
  assert.equal(summary.clients[0].isBot, isBot);
});
}
