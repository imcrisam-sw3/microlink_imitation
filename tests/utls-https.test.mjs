import assert from 'node:assert/strict';
import { createSecureServer } from 'node:http2';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync, deflateSync, brotliCompressSync, zstdCompressSync } from 'node:zlib';
import { test } from 'node:test';
import { UtlsClient } from '../src/client/UtlsClient.ts';

async function secureServer(t, h2) {
  const directory = await mkdtemp(join(tmpdir(), 'utls-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, 'key.pem');
  const caFile = join(directory, 'cert.pem');
  // Certificado temporal y exclusivamente local; no se desactiva la verificación TLS.
  const certificate = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-keyout', keyFile, '-out', caFile,
  ], { encoding: 'utf8' });
  assert.equal(certificate.status, 0, certificate.stderr);
  const tlsOptions = { key: await readFile(keyFile), cert: await readFile(caFile) };
  const actual = h2
    ? createSecureServer({ ...tlsOptions, allowHTTP1: true })
    : createHttpsServer(tlsOptions);
  const ports = [];
  actual.on('request', (req, res) => {
    ports.push(req.socket.remotePort);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ protocol: req.httpVersion, userAgent: req.headers['user-agent'] }));
  });
  await new Promise(resolve => actual.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    actual.closeAllConnections?.();
    await new Promise(resolve => actual.close(resolve));
  });
  return { url: 'https://127.0.0.1:' + actual.address().port, caFile, ports };
}

for (const h2 of [false, true]) {
  test('uTLS worker verifies a local CA, negotiates ' + (h2 ? 'HTTP/2' : 'HTTP/1.1') + ' and reuses the TLS connection', async t => {
    const { url, caFile, ports } = await secureServer(t, h2);
    const client = new UtlsClient({ caFile, headers: { 'user-agent': 'local-test' } });
    t.after(() => client.close());
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await client.get(url);
      assert.equal(response.httpVersion, h2 ? 'HTTP/2.0' : 'HTTP/1.1');
      assert.deepEqual(await response.json(), { protocol: h2 ? '2.0' : '1.1', userAgent: 'local-test' });
    }
    assert.equal(ports[0], ports[1]);
    const untrusted = new UtlsClient();
    t.after(() => untrusted.close());
    await assert.rejects(untrusted.get(url), /certificate|x509|unknown authority/i);
  });
}

test('uTLS decodes automatically negotiated gzip and rejects an oversized response without losing the session', async t => {
  const client = new UtlsClient();
  t.after(() => client.close());
  const server = createServer((req, res) => {
    if (req.url === '/large') { res.end(Buffer.alloc(16 * 1024 * 1024 + 1)); return; }
    assert.match(req.headers['accept-encoding'], /gzip/);
    res.writeHead(200, { 'content-encoding': 'gzip' });
    res.end(gzipSync(Buffer.from('Español 日本語')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port;
  await assert.rejects(client.get(url + '/large'), /16 MiB/);
  assert.equal(await (await client.get(url)).text(), 'Español 日本語');
});

for (const [encoding, compress] of [
  ['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync], ['zstd', zstdCompressSync],
]) {
  test('uTLS decodes an explicitly advertised ' + encoding + ' response exactly once', async t => {
    const client = new UtlsClient({ headers: { 'Accept-Encoding': encoding } });
    t.after(() => client.close());
    const server = createServer((req, res) => {
      assert.equal(req.headers['accept-encoding'], encoding);
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding });
      res.end(compress(Buffer.from('{"value":"decoded"}')));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const response = await client.get('http://127.0.0.1:' + server.address().port);
    assert.deepEqual(await response.json(), { value: 'decoded' });
    assert.equal(await response.text(), '{"value":"decoded"}');
  });
}

test('uTLS applies the response limit after decompression', async t => {
  const client = new UtlsClient({ headers: { 'Accept-Encoding': 'gzip' } });
  t.after(() => client.close());
  const compressed = gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    res.end(compressed);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(client.get('http://127.0.0.1:' + server.address().port), /16 MiB/);
});

test('uTLS aborts during worker startup and close terminates a worker that never becomes ready', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'utls-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binaryPath = join(directory, 'delayed-worker');
  await writeFile(binaryPath, '#!' + process.execPath + '\nsetInterval(() => {}, 1000);\n', { mode: 0o755 });
  const client = new UtlsClient({ binaryPath, timeoutMs: 40 });
  t.after(() => client.close());
  await assert.rejects(client.get('http://127.0.0.1'), /timeout/i);
  const pid = client.processId;
  assert.ok(pid);
  await client.close();
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
