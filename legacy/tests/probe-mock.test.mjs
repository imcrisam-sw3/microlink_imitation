import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { TlsClient } from '../src/TlsClient.ts';
import { FingerprintClient } from '../src/FingerprintClient.ts';
import { ImpersClient } from '../src/ImpersClient.ts';

let mock = {};
try { mock = await import('../src/mock/main.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

function options(extra = {}) {
  assert.equal(typeof mock.parseMockOptions, 'function', 'Falta la simulación local.');
  return { ...mock.parseMockOptions([]), intervalMs: 0, ...extra };
}

test('mock CLI has a ten-instance ceiling and accepts no external destination', () => {
  assert.equal(typeof mock.parseMockOptions, 'function', 'Falta la simulación local.');
  const defaults = mock.parseMockOptions([]);
  assert.equal(defaults.client, 'tls');
  assert.equal(defaults.maxInstances, 10);
  assert.equal(defaults.blockedInstances, 3);
  assert.equal(defaults.blockStatus, 'mixed');
  assert.equal(defaults.intervalMs, 500);
  for (const args of [
    ['--base-url', 'https://www.sofascore.com'],
    ['--max-instances', '11'], ['--max-instances', '0'],
    ['--blocked-instances', '-1'], ['--blocked-instances', '11'],
    ['--client', 'impit'], ['--block-status', '500'],
    ['--interval-ms', '-1'], ['--timeout-ms', '0'],
  ]) assert.throws(() => mock.parseMockOptions(args));
});

for (const [name, Client] of [['tls', TlsClient], ['fingerprint', FingerprintClient], ['impers', ImpersClient]]) {
  test(name + ' retries the same local request with fresh closed instances until success', async t => {
    const objects = new Set(), lifecycle = [], urls = [];
    const originalGet = Client.prototype.get, originalClose = Client.prototype.close;
    const ids = new Map();
    t.mock.method(Client.prototype, 'get', function (url, ...rest) {
      assert.equal(new URL(url).hostname, '127.0.0.1');
      objects.add(this);
      if (!ids.has(this)) ids.set(this, ids.size + 1);
      lifecycle.push('get:' + ids.get(this));
      urls.push(url);
      return originalGet.call(this, url, ...rest);
    });
    t.mock.method(Client.prototype, 'close', function (...args) {
      lifecycle.push('close:' + ids.get(this));
      return originalClose.apply(this, args);
    });
    const logs = [];
    const report = await mock.runMockProbe(options({ client: name }), { log: line => logs.push(line) });
    assert.equal(report.mode, 'local-mock');
    assert.equal(report.reason, 'success');
    assert.deepEqual(report.attempts.map(row => row.status), [403, 429, 403, 200]);
    assert.equal(report.counts.attempted, 4);
    assert.equal(report.counts.http200, 1);
    assert.equal(report.counts.http403, 2);
    assert.equal(report.counts.http429, 1);
    assert.equal(objects.size, 4);
    assert.equal(new Set(urls).size, 1);
    assert.equal(urls[0], report.mockBaseUrl + '/api/v1/event/11/statistics');
    assert.deepEqual(lifecycle, ['get:1', 'close:1', 'get:2', 'close:2', 'get:3', 'close:3', 'get:4', 'close:4']);
    assert.ok(report.attempts.every(row => row.closedAt));
    assert.equal(report.mockServerClosed, true);
    await assert.rejects(fetch(report.mockBaseUrl));
    assert.ok(logs.some(line => line.includes('403')));
    assert.ok(logs.some(line => line.includes('429')));
    assert.ok(!JSON.stringify(report).includes('mock-response-body'));
  });
}

for (const status of ['403', '429']) {
  test('ten local ' + status + ' responses stop without an eleventh instance', async () => {
    const report = await mock.runMockProbe(options({ blockedInstances: 10, blockStatus: status }), { log() {} });
    assert.equal(report.reason, 'max_instances');
    assert.equal(report.attempts.length, 10);
    assert.equal(report.counts.attempted, 10);
    assert.equal(report.counts.http200, 0);
    assert.equal(report.counts[status === '403' ? 'http403' : 'http429'], 10);
    assert.deepEqual(report.attempts.map(row => row.instanceId), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.ok(report.attempts.every(row => row.closedAt));
    assert.equal(report.mockServerClosed, true);
  });
}

test('a first-attempt success creates just one instance', async () => {
  const report = await mock.runMockProbe(options({ blockedInstances: 0 }), { log() {} });
  assert.equal(report.reason, 'success');
  assert.equal(report.attempts.length, 1);
  assert.equal(report.counts.http200, 1);
  assert.ok(report.attempts[0].closedAt);
});

test('a lower instance limit and cancellation stop further local attempts', async t => {
  const limited = await mock.runMockProbe(options({ maxInstances: 3, blockedInstances: 10 }), { log() {} });
  assert.equal(limited.reason, 'max_instances');
  assert.deepEqual(limited.attempts.map(row => row.status), [403, 429, 403]);

  const controller = new AbortController();
  const originalGet = TlsClient.prototype.get;
  t.mock.method(TlsClient.prototype, 'get', async function (...args) {
    const response = await originalGet.apply(this, args);
    setTimeout(() => controller.abort(), 30);
    return response;
  });
  const cancelled = await mock.runMockProbe(options({ intervalMs: 500 }), { signal: controller.signal, log() {} });
  assert.equal(cancelled.reason, 'cancelled');
  assert.equal(cancelled.attempts.length, 1);
  assert.ok(cancelled.attempts[0].closedAt);
  assert.equal(cancelled.mockServerClosed, true);
});

async function cli(t, args, interrupt = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'probe-mock-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const child = spawn(process.execPath, [
    '--import', import.meta.resolve('tsx'),
    fileURLToPath(new URL('../src/mock/main.ts', import.meta.url)),
    '--interval-ms', interrupt ? '500' : '0', ...args,
  ], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', sent = false;
  child.stdout.on('data', data => {
    stdout += data;
    if (interrupt && !sent && stdout.includes('HTTP 403')) { sent = true; child.kill('SIGINT'); }
  });
  child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  const names = await readdir(join(cwd, 'results'));
  assert.equal(names.length, 1, stderr);
  const report = JSON.parse(await readFile(join(cwd, 'results', names[0]), 'utf8'));
  return { ...result, report, stdout, stderr };
}

for (const [name, args, code, reason] of [
  ['recovery', [], 0, 'success'],
  ['ten failures', ['--blocked-instances', '10'], 2, 'max_instances'],
]) {
  test('mock CLI saves a local-only report after ' + name, async t => {
    const result = await cli(t, args);
    assert.equal(result.code, code, result.stderr);
    assert.equal(result.report.reason, reason);
    assert.equal(new URL(result.report.mockBaseUrl).hostname, '127.0.0.1');
    assert.equal(result.report.mockServerClosed, true);
    assert.ok(!result.stdout.includes('mock-response-body'));
    assert.ok(!JSON.stringify(result.report).includes('mock-response-body'));
  });
}

test('mock CLI SIGINT writes the partial report and closes its server', async t => {
  const result = await cli(t, [], true);
  assert.equal(result.code, 130, result.stderr);
  assert.equal(result.report.reason, 'cancelled');
  assert.equal(result.report.attempts.length, 1);
  assert.ok(result.report.attempts[0].closedAt);
  assert.equal(result.report.mockServerClosed, true);
});

test('mock CLI accepts impers and records the selected profile', async () => {
  assert.equal(mock.parseMockOptions(['--client', 'impers']).client, 'impers');
  const report = await mock.runMockProbe(options({ client: 'impers', blockedInstances: 0 }), { log() {} });
  assert.equal(report.reason, 'success');
  assert.equal(report.attempts[0].impersonate, 'safari_ios');
  assert.equal(report.attempts[0].userAgent, undefined);
});

test('impers mock CLI writes its report and releases its native session', async t => {
  const result = await cli(t, ['--client', 'impers']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.report.reason, 'success');
  assert.equal(result.report.attempts[0].impersonate, 'safari_ios');
  assert.ok(result.report.attempts.every(row => row.closedAt));
});
