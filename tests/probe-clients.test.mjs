import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { TlsClient } from '../src/TlsClient.ts';
import { FingerprintClient } from '../src/FingerprintClient.ts';
import { ImpersClient } from '../src/ImpersClient.ts';

let probe = {};
try { probe = await import('../src/probe-clients.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

function options(baseUrl, extra = {}) {
  assert.equal(typeof probe.parseProbeOptions, 'function', 'Falta el script comparativo.');
  return { ...probe.parseProbeOptions(['--base-url', baseUrl]), intervalMs: 0, ...extra };
}
async function localServer(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return 'http://127.0.0.1:' + server.address().port;
}
function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}
const events = [
  { id: 11, homeTeam: { slug: 'home' }, awayTeam: { slug: 'away' }, customId: 'match' },
  { id: 22 }, { id: 11 }, { id: 33 }, { id: 0 }, { id: '44' }, null,
];

test('CLI defaults to SofaScore, allows a base URL override and validates counts', () => {
  assert.equal(typeof probe.parseProbeOptions, 'function', 'Falta el script comparativo.');
  const defaults = probe.parseProbeOptions([]);
  assert.equal(defaults.baseUrl, 'https://www.sofascore.com/');
  assert.throws(() => probe.parseProbeOptions(['--base-url', '']), /base-url/);
  for (const args of [
    ['--client', 'impit'], ['--requests', '0'], ['--requests', '1.5'],
    ['--rotate-every', '-1'], ['--interval-ms', '-1'], ['--timeout-ms', '0'],
    ['--base-url', 'file:///tmp/test'],
  ]) assert.throws(() => probe.parseProbeOptions(['--base-url', 'http://127.0.0.1:1234', ...args]));
  const config = probe.parseProbeOptions(['--base-url', 'http://127.0.0.1:1234']);
  assert.equal(config.baseUrl, 'http://127.0.0.1:1234/');
  assert.equal(config.client, 'tls');
  assert.equal(config.requests, 400);
  assert.equal(config.intervalMs, 500);
  assert.equal(config.rotateEvery, 50);
  assert.equal(config.timeoutMs, 20000);
});

for (const [name, Client] of [['tls', TlsClient], ['fingerprint', FingerprintClient], ['impers', ImpersClient]]) {
  test(name + ' makes exactly 400 requests, rotates every 50 and preserves the global ID round-robin', async t => {
    const seen = [];
    let active = 0, maximumActive = 0;
    const base = await localServer(t, (req, res) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      res.once('finish', () => active--);
      seen.push({ path: req.url, referer: req.headers.referer, ua: req.headers['user-agent'] });
      if (req.url.endsWith('/live')) return json(res, { events });
      const forbidden = seen.length % 10 === 0;
      json(res, forbidden ? { error: 'forbidden' } : { statistics: [] }, forbidden ? 403 : 200);
    });
    const instances = new Map();
    const lifecycle = [];
    const originalGet = Client.prototype.get;
    const originalClose = Client.prototype.close;
    t.mock.method(Client.prototype, 'get', function (...args) {
      if (!instances.has(this)) instances.set(this, instances.size + 1);
      const id = instances.get(this);
      lifecycle.push('get:' + id);
      return originalGet.apply(this, args);
    });
    t.mock.method(Client.prototype, 'close', function (...args) {
      lifecycle.push('close:' + instances.get(this));
      return originalClose.apply(this, args);
    });
    const logs = [];
    const report = await probe.runProbe(options(base, { client: name }), { log: message => logs.push(message) });
    assert.equal(report.reason, 'completed');
    assert.equal(seen.length, 400);
    assert.equal(seen.filter(item => item.path.endsWith('/live')).length, 1);
    assert.deepEqual(report.eventIds, [11, 22, 33]);
    assert.deepEqual(seen.slice(1, 7).map(item => item.path), [
      '/api/v1/event/11/statistics', '/api/v1/event/22/statistics', '/api/v1/event/33/statistics',
      '/api/v1/event/11/statistics', '/api/v1/event/22/statistics', '/api/v1/event/33/statistics',
    ]);
    assert.equal(seen[50].path, '/api/v1/event/22/statistics');
    assert.equal(seen[1].referer, base + '/football/match/home-away/match');
    assert.equal(seen[2].referer, base + '/');
    assert.equal(maximumActive, 1);
    assert.equal(report.counts.attempted, 400);
    assert.equal(report.counts.http200, 360);
    assert.equal(report.counts.http403, 40);
    assert.equal(report.counts.networkErrors, 0);
    assert.equal(report.instances.length, 8);
    assert.equal(instances.size, 8);
    assert.deepEqual(report.instances.map(instance => instance.counts.attempted), [50, 50, 50, 50, 50, 50, 50, 50]);
    for (let id = 1; id <= 8; id++) {
      assert.equal(lifecycle.filter(item => item === 'get:' + id).length, 50);
      assert.equal(lifecycle.filter(item => item === 'close:' + id).length, 1);
      assert.ok(report.instances[id - 1].closedAt);
      if (id < 8) assert.ok(lifecycle.indexOf('close:' + id) < lifecycle.indexOf('get:' + (id + 1)));
    }
    assert.equal(logs.filter(line => line.includes('/400')).length, 8);
    assert.ok(!logs.join('\n').includes('"events"'));
    assert.ok(!JSON.stringify(report).includes('"body"'));
  });

  for (const phase of ['headers', 'body']) {
    test(name + ' GET AbortSignal cancels while waiting for ' + phase, async t => {
      const base = await localServer(t, (_req, res) => {
        if (phase === 'body') { res.writeHead(200); res.write('partial'); }
        setTimeout(() => res.end('late'), 150);
      });
      const client = new Client();
      try {
        const signal = AbortSignal.timeout(25);
        await assert.rejects(async () => {
          const response = await client.get(base, {}, signal);
          await response.text();
        }, error => error.name === 'TimeoutError' || error.name === 'AbortError');
      } finally { await client.close(); }
    });
  }
}

test('rotation 0 keeps one instance and interval waits between completed requests', async t => {
  const arrival = [];
  const base = await localServer(t, (req, res) => {
    arrival.push(performance.now());
    json(res, req.url.endsWith('/live') ? { events: [{ id: 11 }] } : { statistics: [] });
  });
  const report = await probe.runProbe(options(base, { requests: 4, rotateEvery: 0, intervalMs: 30 }), { log() {} });
  assert.equal(report.instances.length, 1);
  assert.equal(report.instances[0].counts.attempted, 4);
  assert.ok(report.instances[0].closedAt);
  for (let i = 1; i < arrival.length; i++) assert.ok(arrival[i] - arrival[i - 1] >= 25);
});

test('counts non-200/403 responses, network errors and timeouts without retrying', async t => {
  let calls = 0;
  const base = await localServer(t, (req, res) => {
    calls++;
    if (calls === 1) return json(res, { events: [{ id: 11 }] });
    if (calls === 2) return json(res, {}, 403);
    if (calls === 3) return json(res, {}, 500);
    if (calls === 4) return req.socket.destroy();
    setTimeout(() => json(res, { statistics: [] }), 150);
  });
  const report = await probe.runProbe(options(base, { requests: 5, timeoutMs: 40 }), { log() {} });
  assert.equal(calls, 5);
  assert.equal(report.reason, 'completed');
  assert.equal(report.counts.attempted, 5);
  assert.equal(report.counts.http200, 1);
  assert.equal(report.counts.http403, 1);
  assert.equal(report.counts.otherHttp, 1);
  assert.equal(report.counts.networkErrors, 1);
  assert.equal(report.counts.timeouts, 1);
  assert.deepEqual(report.records.map(row => row.status), [200, 403, 500, null, null]);
});

test('a body timeout preserves the received HTTP status and aborts the stream', async t => {
  const base = await localServer(t, (req, res) => {
    if (req.url.endsWith('/live')) return json(res, { events: [{ id: 11 }] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"statistics":[');
    setTimeout(() => res.end(']}'), 150);
  });
  const report = await probe.runProbe(options(base, { requests: 2, timeoutMs: 40 }), { log() {} });
  assert.equal(report.counts.http200, 2);
  assert.equal(report.counts.timeouts, 1);
  assert.equal(report.records[1].status, 200);
  assert.equal(report.records[1].error, 'timeout');
  assert.ok(report.instances[0].closedAt);
});

for (const [name, payload, status, reason] of [
  ['empty events', { events: [] }, 200, 'no_events'],
  ['invalid IDs', { events: [{ id: 0 }, { id: '11' }] }, 200, 'no_events'],
  ['missing events', { message: 'unexpected' }, 200, 'discovery_failed'],
  ['denied discovery', { error: 'forbidden' }, 403, 'discovery_failed'],
  ['invalid JSON', '<html>blocked</html>', 200, 'discovery_failed'],
]) {
  test('stops after ' + name + ' without requesting statistics', async t => {
    let calls = 0;
    const base = await localServer(t, (_req, res) => {
      calls++;
      if (typeof payload === 'string') { res.writeHead(status); res.end(payload); }
      else json(res, payload, status);
    });
    const report = await probe.runProbe(options(base), { log() {} });
    assert.equal(calls, 1);
    assert.equal(report.reason, reason);
    assert.equal(report.counts.attempted, 1);
    assert.ok(report.instances[0].closedAt);
  });
}

for (const limitedAt of [1, 3]) {
  test('stops immediately on 429 at request ' + limitedAt, async t => {
    let calls = 0;
    const base = await localServer(t, (req, res) => {
      calls++;
      if (calls === limitedAt) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
        return res.end('{"error":"rate limit"}');
      }
      json(res, req.url.endsWith('/live') ? { events: [{ id: 11 }] } : { statistics: [] });
    });
    const report = await probe.runProbe(options(base), { log() {} });
    assert.equal(calls, limitedAt);
    assert.equal(report.reason, 'rate_limited');
    assert.equal(report.counts.http429, 1);
    assert.equal(report.records.at(-1).retryAfter, '30');
    assert.ok(report.instances.every(instance => instance.closedAt));
  });
}

test('cancellation during an interval sends no additional request', async t => {
  const controller = new AbortController();
  let calls = 0;
  const base = await localServer(t, (_req, res) => {
    calls++;
    json(res, { events: [{ id: 11 }] });
    setTimeout(() => controller.abort(), 30);
  });
  const report = await probe.runProbe(options(base, { intervalMs: 500 }), { signal: controller.signal, log() {} });
  assert.equal(report.reason, 'cancelled');
  assert.equal(calls, 1);
  assert.equal(report.counts.attempted, 1);
  assert.ok(report.instances[0].closedAt);
});

async function cli(t, base, extra, onChild) {
  const cwd = await mkdtemp(join(tmpdir(), 'probe-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const child = spawn(process.execPath, [
    '--import', import.meta.resolve('tsx'),
    fileURLToPath(new URL('../src/probe-clients.ts', import.meta.url)),
    '--base-url', base, '--interval-ms', '0', ...extra,
  ], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
  t.after(() => { clearTimeout(killTimer); if (child.exitCode === null) child.kill('SIGKILL'); });
  await onChild?.(child);
  const result = await completion;
  clearTimeout(killTimer);
  const names = await readdir(join(cwd, 'results'));
  assert.equal(names.length, 1, stderr);
  const report = JSON.parse(await readFile(join(cwd, 'results', names[0]), 'utf8'));
  return { ...result, report, stdout, stderr };
}

test('CLI writes a body-free report for a completed execution', async t => {
  const base = await localServer(t, (req, res) => json(res, req.url.endsWith('/live')
    ? { events: [{ id: 11 }] } : { statistics: [], secretBodyMarker: 'not-in-report' }));
  const result = await cli(t, base, ['--requests', '3']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.report.reason, 'completed');
  assert.equal(result.report.counts.attempted, 3);
  assert.ok(!result.stdout.includes('not-in-report'));
  assert.ok(!JSON.stringify(result.report).includes('not-in-report'));
});

test('CLI SIGINT cancels a pending body and writes the partial report', async t => {
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  const base = await localServer(t, (req, res) => {
    if (req.url.endsWith('/live')) return json(res, { events: [{ id: 11 }] });
    res.writeHead(200);
    res.write('partial');
    started();
  });
  const result = await cli(t, base, ['--requests', '400'], async child => {
    await pending;
    await new Promise(resolve => setTimeout(resolve, 30));
    child.kill('SIGINT');
  });
  assert.equal(result.code, 130, result.stderr);
  assert.equal(result.report.reason, 'cancelled');
  assert.equal(result.report.counts.attempted, 2);
  assert.equal(result.report.counts.cancelled, 1);
  assert.ok(result.report.instances[0].closedAt);
});

for (const name of ['tls', 'fingerprint']) {
  test(name + ' counts redirects without following them beyond the request budget', async t => {
    const paths = [];
    const base = await localServer(t, (req, res) => {
      paths.push(req.url);
      if (req.url.endsWith('/live')) return json(res, { events: [{ id: 11 }] });
      if (req.url === '/redirect-target') return json(res, { statistics: [] });
      res.writeHead(302, { location: '/redirect-target' });
      res.end();
    });
    const report = await probe.runProbe(options(base, { client: name, requests: 3 }), { log() {} });
    assert.deepEqual(paths, ['/api/v1/sport/football/events/live', '/api/v1/event/11/statistics', '/api/v1/event/11/statistics']);
    assert.equal(report.counts.http200, 1);
    assert.equal(report.counts.otherHttp, 2);
    assert.deepEqual(report.records.map(row => row.status), [200, 302, 302]);
  });
}

test('invalid discovery JSON does not leak body fragments through error messages', async t => {
  const base = await localServer(t, (_req, res) => res.end('SENSITIVE_DISCOVERY_BODY_MARKER'));
  const report = await probe.runProbe(options(base), { log() {} });
  assert.equal(report.reason, 'discovery_failed');
  assert.ok(report.error);
  assert.ok(!JSON.stringify(report).includes('SENSITIVE'), 'El error de JSON.parse filtra el cuerpo original.');
});

for (const [name, Client] of [['tls', TlsClient], ['fingerprint', FingerprintClient], ['impers', ImpersClient]]) {
  test(name + ' existing GET calls keep following redirects by default', async t => {
    const paths = [];
    const base = await localServer(t, (req, res) => {
      paths.push(req.url);
      if (req.url === '/start') { res.writeHead(302, { location: '/end' }); res.end(); }
      else json(res, { ok: true });
    });
    const client = new Client();
    try {
      const response = await client.get(base + '/start');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      assert.deepEqual(paths, ['/start', '/end']);
    } finally { await client.close(); }
  });
}

test('progress explains other HTTP codes and counts them by status without extra body logs', async t => {
  let calls = 0;
  const base = await localServer(t, (req, res) => {
    calls++;
    if (calls === 1) return json(res, { events: [{ id: 11 }] });
    if (calls === 2) return json(res, { message: 'DO_NOT_LOG_THIS_BODY' }, 404);
    if (calls === 3) return json(res, {}, 500);
    if (calls === 4) { res.writeHead(302, { location: '/unused' }); res.end(); return; }
    json(res, { statistics: [] });
  });
  const logs = [];
  const report = await probe.runProbe(options(base, { requests: 50 }), { log: line => logs.push(line) });
  assert.equal(report.counts.otherHttp, 3);
  assert.deepEqual(report.counts.otherHttpByStatus, { 302: 1, 404: 1, 500: 1 });
  assert.deepEqual(report.instances[0].counts.otherHttpByStatus, { 302: 1, 404: 1, 500: 1 });
  const progress = logs.find(line => line.includes('50/50'));
  assert.ok(progress);
  assert.ok(progress.includes('otros=3 [302 Found=1, 404 Not Found=1, 500 Internal Server Error=1]'));
  assert.equal(logs.length, 2, 'Solo se espera la instancia y el resumen de progreso.');
  assert.ok(!logs.join('\n').includes('DO_NOT_LOG_THIS_BODY'));
});

test('impers CLI selection and report preserve native profile without fabricated TLS data', async t => {
  assert.equal(probe.parseProbeOptions(['--client', 'impers']).client, 'impers');
  const base = await localServer(t, (req, res) =>
    json(res, req.url.endsWith('/live') ? { events: [{ id: 11 }] } : { statistics: [] }));
  const report = await probe.runProbe(options(base, { client: 'impers', requests: 2 }), { log() {} });
  assert.equal(report.reason, 'completed');
  assert.equal(report.counts.http200, 2);
  assert.equal(report.instances[0].impersonate, 'safari_ios');
  assert.equal(report.instances[0].userAgent, undefined);
  assert.equal(report.instances[0].tlsOptions, undefined);
});
test('an impers buffered body timeout is counted without an invented HTTP status', async t => {
  let calls = 0;
  const base = await localServer(t, (req, res) => {
    calls++;
    if (req.url.endsWith('/live')) return json(res, { events: [{ id: 11 }] });
    res.writeHead(200); res.write('partial');
  });
  const report = await probe.runProbe(options(base, { client: 'impers', requests: 2, timeoutMs: 30 }), { log() {} });
  assert.equal(calls, 2);
  assert.equal(report.counts.timeouts, 1);
  assert.equal(report.counts.http200, 1);
  assert.equal(report.records[1].status, null);
  assert.equal(report.records[1].error, 'timeout');
});
