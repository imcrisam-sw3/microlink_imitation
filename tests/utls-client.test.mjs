import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

async function createClient(t, options) {
  let imported;
  try { imported = await import('../src/client/UtlsClient.ts'); }
  catch (error) { assert.fail('Falta UtlsClient: ' + error.message); }
  const client = new imported.UtlsClient(options);
  t.after(() => client.close());
  return client;
}
async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return 'http://127.0.0.1:' + server.address().port;
}

test('uTLS starts lazily and reuses one process and connection for GET and JSON POST', async t => {
  const client = await createClient(t, { headers: { 'X-Test': 'default', 'User-Agent': 'Explicit identity' } });
  assert.equal(client.processId, undefined);
  const url = await serve(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, headers: req.headers, body, port: req.socket.remotePort }));
  });
  const requestHeaders = { 'x-test': 'request', Authorization: 'local-token' };
  const first = await (await client.get(url, requestHeaders)).json();
  const pid = client.processId;
  assert.ok(Number.isInteger(pid));
  const body = { odds: [1, 2], text: 'Español 日本語' };
  const response = await client.post(url + '/different-path', body);
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
  assert.match(response.headers.get('content-type'), /json/);
  const second = await response.json();
  assert.equal(first.headers['user-agent'], 'Explicit identity');
  assert.equal(first.headers['x-test'], 'request');
  assert.equal(first.headers.authorization, 'local-token');
  assert.equal(second.headers['x-test'], 'default');
  assert.equal(second.headers['content-type'], 'application/json');
  assert.equal(second.method, 'POST');
  assert.deepEqual(JSON.parse(second.body), body);
  assert.equal(second.port, first.port);
  assert.equal(client.processId, pid);
  assert.deepEqual(requestHeaders, { 'x-test': 'request', Authorization: 'local-token' });
  assert.equal(await response.text(), JSON.stringify(second));
});

test('uTLS isolates cookies between instances and handles concurrent responses by request id', async t => {
  const client = await createClient(t);
  const other = await createClient(t);
  const url = await serve(t, (req, res) => {
    if (req.url === '/set') res.setHeader('set-cookie', 'session=local; Path=/');
    if (req.url === '/slow') setTimeout(() => res.end('slow'), 40);
    else res.end(req.url === '/fast' ? 'fast' : req.headers.cookie || '');
  });
  await client.get(url + '/set');
  assert.equal(await (await client.get(url)).text(), 'session=local');
  assert.equal(await (await other.get(url)).text(), '');
  assert.notEqual(client.processId, other.processId);
  assert.deepEqual(await Promise.all(['/slow', '/fast'].map(async path => (await client.get(url + path)).text())), ['slow', 'fast']);
});

test('uTLS preserves manual redirects and error bodies and follows redirects explicitly', async t => {
  const client = await createClient(t);
  let destinationCalls = 0;
  const url = await serve(t, (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/destination' }); res.end('redirect'); }
    else { destinationCalls++; res.writeHead(403); res.end('<html>denied</html>'); }
  });
  const manual = await client.get(url + '/redirect', {}, undefined, 'manual');
  assert.equal(manual.status, 302);
  assert.equal(destinationCalls, 0);
  await assert.rejects(client.get(url + '/redirect', {}, undefined, 'error'), /redirect|redirec/i);
  assert.equal(destinationCalls, 0);
  const response = await client.get(url + '/redirect');
  assert.equal(response.status, 403);
  assert.equal(response.ok, false);
  assert.equal(response.url, url + '/destination');
  assert.equal(await response.text(), '<html>denied</html>');
  await assert.rejects(response.json());
});

for (const phase of ['headers', 'body']) {
  test('uTLS cancels while waiting for ' + phase + ' and keeps the worker usable', async t => {
    const client = await createClient(t);
    await client.ready();
    let arrived;
    const arrival = new Promise(resolve => { arrived = resolve; });
    const url = await serve(t, (req, res) => {
      if (req.url === '/ok') { res.end('ok'); return; }
      if (phase === 'body') { res.writeHead(200); res.write('partial'); }
      arrived();
    });
    const controller = new AbortController();
    const pending = assert.rejects(client.get(url, {}, controller.signal), /abort/i);
    await arrival;
    controller.abort();
    await pending;
    assert.equal(await (await client.get(url + '/ok')).text(), 'ok');
  });
}
test('uTLS enforces a timeout for a buffered body', async t => {
  const client = await createClient(t, { timeoutMs: 60 });
  await client.ready();
  const url = await serve(t, (_req, res) => { res.writeHead(200); res.write('partial'); });
  await assert.rejects(client.get(url), /timeout|timed out/i);
});

test('uTLS close cancels pending work, terminates its process and is idempotent', async t => {
  const client = await createClient(t);
  await client.ready();
  const pid = client.processId;
  let arrived; const arrival = new Promise(resolve => { arrived = resolve; });
  const url = await serve(t, () => arrived());
  const pending = assert.rejects(client.get(url), /closed|cerrad|abort/i);
  await arrival;
  await client.close();
  await client.close();
  await pending;
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  await assert.rejects(client.get(url), /closed|cerrad/i);
  await assert.rejects(client.ready(), /closed|cerrad/i);
});

test('uTLS reports a missing executable and an unexpected worker exit', async t => {
  const missing = await createClient(t, { binaryPath: '/does-not-exist/utls-worker' });
  await assert.rejects(missing.ready(), /utls|ENOENT/i);
  const client = await createClient(t);
  await client.ready();
  let arrived; const arrival = new Promise(resolve => { arrived = resolve; });
  const url = await serve(t, () => arrived());
  const pending = assert.rejects(client.get(url), /worker|proceso|exit|termin/i);
  await arrival;
  process.kill(client.processId, 'SIGKILL');
  await pending;
  await assert.rejects(client.get(url), /worker|proceso|exit|termin/i);
});

test('uTLS pre-aborted signals and invalid URLs never start a worker', async t => {
  const client = await createClient(t);
  await assert.rejects(client.get('http://127.0.0.1', {}, AbortSignal.abort()), /abort/i);
  await assert.rejects(client.get('file:///etc/passwd'), /http|URL/i);
  assert.equal(client.processId, undefined);
});

test('uTLS loads independently and closes unused clients without a binary', () => {
  const script = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (['impers', 'undici', 'https-tls', 'fingerprint-generator'].includes(specifier) ||
          /(?:TlsClient|FingerprintClient|ImpersClient)\\.(?:ts|js)$/.test(specifier)) {
        throw new Error('Unexpected dependency: ' + specifier);
      }
      return nextResolve(specifier, context);
    }});
    const { UtlsClient } = await import('./src/client/UtlsClient.ts');
    const client = new UtlsClient({ binaryPath: '/does-not-exist/utls-worker' });
    await client.close();
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
});
