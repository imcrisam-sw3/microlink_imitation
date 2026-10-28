import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

async function createClient(options) {
  let imported;
  try { imported = await import('../src/client/ImpersClient.ts'); }
  catch (error) { assert.fail('Falta ImpersClient: ' + error.message); }
  return new imported.ImpersClient(options);
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
async function echo(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ method: req.method, headers: req.headers, body }));
}
test('ImpersClient sends Safari iPhone GET and JSON POST without Chromium identity headers', async t => {
  const client = await createClient();
  t.after(() => client.close());
  await client.ready();
  const url = await serve(t, echo);
  const headers = {
    Origin: 'https://caller.example', Referer: 'https://caller.example/',
    Authorization: 'literal-test-token', Accept: 'application/json',
    'User-Agent': 'Chrome/153', 'sec-ch-ua': '"Chromium";v="153"',
    'Sec-CH-UA-Mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
  };
  const original = { ...headers };
  const response = await client.get(url, headers);
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const first = await response.json();
  assert.match(first.headers['user-agent'], /iPhone/);
  assert.match(first.headers['user-agent'], /Safari/);
  assert.equal(first.headers['sec-ch-ua'], undefined);
  assert.equal(first.headers['sec-ch-ua-mobile'], undefined);
  assert.equal(first.headers['sec-ch-ua-platform'], undefined);
  assert.equal(first.headers.authorization, 'literal-test-token');
  assert.equal(first.headers.origin, 'https://caller.example');
  assert.equal(first.headers.referer, 'https://caller.example/');
  const body = { odds: [{ id: 1, price: 2.5 }] };
  const post = await (await client.post(url, body, headers)).json();
  assert.equal(post.method, 'POST');
  assert.equal(post.headers['user-agent'], first.headers['user-agent']);
  assert.equal(post.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(post.body), { odds: [{ id: 1, price: 2.5 }] });
  assert.deepEqual(body, { odds: [{ id: 1, price: 2.5 }] });
  assert.deepEqual(headers, original);
});

test('constructor headers merge case-insensitively and an explicit profile is honored', async t => {
  const options = { impersonate: 'chrome124', headers: { 'X-Test': 'default', 'Content-Type': 'application/custom+json' } };
  const client = await createClient(options);
  t.after(() => client.close());
  const url = await serve(t, echo);
  const data = await (await client.post(url, {}, { 'x-test': 'request' })).json();
  assert.equal(data.headers['x-test'], 'request');
  assert.equal(data.headers['content-type'], 'application/custom+json');
  assert.match(data.headers['user-agent'], /Chrome\/124/);
  assert.deepEqual(options.headers, { 'X-Test': 'default', 'Content-Type': 'application/custom+json' });
});

test('cookies persist in one session and are isolated from another instance', async t => {
  const client = await createClient();
  const other = await createClient();
  t.after(async () => { await client.close(); await other.close(); });
  const url = await serve(t, (req, res) => {
    if (req.url === '/set') res.setHeader('set-cookie', 'session=local; Path=/');
    res.end(req.headers.cookie || '');
  });
  await client.get(url + '/set');
  assert.equal(await (await client.get(url)).text(), 'session=local');
  assert.equal(await (await other.get(url)).text(), '');
});

test('redirect modes preserve manual HTTP status and error rejects without following', async t => {
  const client = await createClient();
  t.after(() => client.close());
  let destinationCalls = 0;
  const url = await serve(t, (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/destination' }); res.end(); }
    else { destinationCalls++; res.end('arrived'); }
  });
  const manual = await client.get(url + '/redirect', {}, undefined, 'manual');
  assert.equal(manual.status, 302);
  assert.equal(manual.headers.get('location'), '/destination');
  assert.equal(destinationCalls, 0);
  await assert.rejects(client.get(url + '/redirect', {}, undefined, 'error'), /redirect|redirec/i);
  assert.equal(destinationCalls, 0);
  assert.equal(await (await client.get(url + '/redirect')).text(), 'arrived');
  assert.equal(destinationCalls, 1);
});

for (const phase of ['headers', 'body']) {
  test('AbortSignal cancels a native transfer waiting for ' + phase, async t => {
    const client = await createClient();
    t.after(() => client.close());
    await client.ready();
    const url = await serve(t, (_req, res) => {
      if (phase === 'body') { res.writeHead(200); res.write('partial'); }
    });
    await assert.rejects(client.get(url, {}, AbortSignal.timeout(40)), /abort|timeout/i);
  });
}
test('timeoutMs limits a native buffered body download', async t => {
  const client = await createClient({ timeoutMs: 40 });
  t.after(() => client.close());
  await client.ready();
  const url = await serve(t, (_req, res) => { res.writeHead(200); res.write('partial'); });
  await assert.rejects(client.get(url), /timeout|timed out/i);
});
test('close cancels in-flight requests, is idempotent and rejects subsequent operations', async t => {
  const client = await createClient();
  await client.ready();
  let received;
  const arrival = new Promise(resolve => { received = resolve; });
  const url = await serve(t, () => received());
  const pending = client.get(url);
  const rejected = assert.rejects(pending, /abort|closed|cerrad/i);
  await arrival;
  await client.close();
  await client.close();
  await rejected;
  await assert.rejects(client.get(url), /closed|cerrad/i);
  await assert.rejects(client.post(url, {}), /closed|cerrad/i);
  await assert.rejects(client.ready(), /closed|cerrad/i);
});
test('HTTP error bodies remain readable and invalid JSON rejects only json()', async t => {
  const client = await createClient();
  t.after(() => client.close());
  const url = await serve(t, (_req, res) => { res.writeHead(403); res.end('<html>denied</html>'); });
  const response = await client.get(url);
  assert.equal(response.status, 403);
  assert.equal(response.ok, false);
  assert.equal(await response.text(), '<html>denied</html>');
  await assert.rejects(response.json());
});
test('pre-aborted signals and unsupported profiles make no HTTP request', async t => {
  const client = await createClient();
  const invalid = await createClient({ impersonate: 'no-such-profile' });
  t.after(async () => { await client.close(); await invalid.close(); });
  let calls = 0;
  const url = await serve(t, (_req, res) => { calls++; res.end('unexpected'); });
  await assert.rejects(client.get(url, {}, AbortSignal.abort()), /abort/i);
  await assert.rejects(invalid.get(url), /impersonat|supported/i);
  assert.equal(calls, 0);
});
test('constructing and closing an unused client does not load the native engine', () => {
  const script = String.raw`
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === 'impers' || ['undici', 'https-tls', 'fingerprint-generator'].includes(specifier)) {
        throw new Error('Unexpected runtime dependency: ' + specifier);
      }
      return nextResolve(specifier, context);
    }});
    const { ImpersClient } = await import('./src/client/ImpersClient.ts');
    const client = new ImpersClient();
    await client.close();
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test('ready rejects a conventional libcurl before constructing a session', () => {
  const source = 'export class Curl { static hasImpersonateSupport() { return false; } } export class Session { constructor() { throw new Error("must not create session"); } }';
  const script = 'import assert from "node:assert/strict"; import { registerHooks } from "node:module"; const source = ' +
    JSON.stringify(source) + '; registerHooks({ resolve(specifier, context, nextResolve) {' +
    'if (specifier === "impers") return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };' +
    'return nextResolve(specifier, context); }}); const { ImpersClient } = await import("./src/client/ImpersClient.ts");' +
    'const client = new ImpersClient(); await assert.rejects(client.ready(), /libcurl.*impersonaci/); await client.close();';
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
});
test('connection failures are propagated as errors', async t => {
  const client = await createClient();
  t.after(() => client.close());
  const url = await serve(t, req => req.socket.destroy());
  await assert.rejects(client.get(url));
});

test('provided header mode preserves the reference identity and functional request overrides', async t => {
  const headers = { 'User-Agent': 'Reference iPhone Safari', 'Accept-Encoding': 'gzip, deflate, br, zstd', 'X-Test': 'default' };
  const client = await createClient({ headerMode: 'provided', headers });
  t.after(() => client.close());
  const url = await serve(t, echo);
  const request = { 'user-agent': 'must-not-replace-reference', 'sec-ch-ua': '"Chromium";v="153"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"', 'x-test': 'request', Origin: 'https://caller.example', Referer: 'https://caller.example/', Authorization: 'local-token' };
  const data = await (await client.post(url, { value: 7 }, request)).json();
  assert.equal(data.headers['user-agent'], 'Reference iPhone Safari');
  assert.equal(data.headers['accept-encoding'], 'gzip, deflate, br, zstd');
  assert.equal(data.headers['sec-ch-ua'], '"Chromium";v="153"');
  assert.equal(data.headers['sec-ch-ua-mobile'], '?0');
  assert.equal(data.headers['sec-ch-ua-platform'], '"Windows"');
  assert.equal(data.headers['x-test'], 'request');
  assert.equal(data.headers.origin, 'https://caller.example');
  assert.equal(data.headers.referer, 'https://caller.example/');
  assert.equal(data.headers.authorization, 'local-token');
  assert.deepEqual(JSON.parse(data.body), { value: 7 });
  assert.deepEqual(headers, { 'User-Agent': 'Reference iPhone Safari', 'Accept-Encoding': 'gzip, deflate, br, zstd', 'X-Test': 'default' });
  assert.equal(request['user-agent'], 'must-not-replace-reference');
});
for (const [encoding, compressor] of [['zstd', 'zstdCompressSync'], ['gzip', 'gzipSync'], ['br', 'brotliCompressSync'], ['deflate', 'deflateSync']]) {
test('provided headers decode advertised ' + encoding + ' responses exactly once', async t => {
  const zlib = await import('node:zlib');
  const client = await createClient({ headerMode: 'provided', headers: { 'User-Agent': 'Reference Safari', 'Accept-Encoding': 'gzip, deflate, br, zstd' } });
  t.after(() => client.close());
  const url = await serve(t, (req, res) => {
    assert.match(req.headers['accept-encoding'], /zstd/);
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding });
    res.end(zlib[compressor](Buffer.from('{"value":"decoded"}')));
  });
  const response = await client.get(url);
  assert.equal(await response.text(), '{"value":"decoded"}');
  assert.deepEqual(await response.json(), { value: 'decoded' });
});

}


test('maxConnections controls real concurrency and survives automatic profile changes', async t => {
  const clients = [await createClient({ maxConnections: 3 })];
  t.after(() => Promise.all(clients.map(client => client.close())));
  let active = 0; let peak = 0;
  const url = await serve(t, (_req, res) => {
    active++; peak = Math.max(peak, active);
    res.on('close', () => active--);
    setTimeout(() => res.end('ok'), 25);
  });
  for (let generation = 0; generation < 2; generation++) {
    const client = clients.at(-1);
    peak = 0;
    assert.deepEqual(await Promise.all(Array.from({ length: 3 }, async () => (await client.get(url)).text())), ['ok', 'ok', 'ok']);
    assert.equal(peak, 3);
    assert.equal(client.maxConnections, 3);
    if (generation === 0) clients.push(await client.changeProfile());
  }
});

test('maxConnections defaults to one and rejects invalid values', async () => {
  const client = await createClient();
  assert.equal(client.maxConnections, 1);
  await client.close();
  for (const maxConnections of [0, -1, 1.5, Infinity, 2147483648]) {
    await assert.rejects(createClient({ maxConnections }), /maxConnections/);
  }
});
