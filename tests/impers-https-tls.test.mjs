import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { ImpersClient } from '../src/client/ImpersClient.ts';

const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const safariUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const firefoxUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0';
const isGrease = value => (value & 0x0f0f) === 0x0a0a && (value >> 8) === (value & 0xff);
const words = bytes => Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readUInt16BE(i * 2));

async function captureHello(t, options) {
  const client = new ImpersClient(options);
  t.after(() => client.close());
  await client.ready();
  let hello;
  let parseError;
  const server = createServer(socket => {
    let bytes = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 5 || bytes.length < 5 + bytes.readUInt16BE(3)) return;
      try {
        assert.equal(bytes[0], 22);
        assert.equal(bytes[5], 1);
        let offset = 5 + 4 + 2 + 32;
        offset += 1 + bytes[offset];
        const cipherLength = bytes.readUInt16BE(offset);
        const ciphers = words(bytes.subarray(offset + 2, offset + 2 + cipherLength)).filter(value => !isGrease(value));
        offset += 2 + cipherLength;
        offset += 1 + bytes[offset];
        const end = offset + 2 + bytes.readUInt16BE(offset);
        const extensions = new Map();
        for (offset += 2; offset < end;) {
          const type = bytes.readUInt16BE(offset);
          const size = bytes.readUInt16BE(offset + 2);
          extensions.set(type, bytes.subarray(offset + 4, offset + 4 + size));
          offset += 4 + size;
        }
        const alpn = [];
        const protocols = extensions.get(16);
        for (let i = 2; i < protocols.length;) {
          const length = protocols[i++];
          alpn.push(protocols.subarray(i, i + length).toString());
          i += length;
        }
        hello = {
          ciphers, alpn,
          groups: words(extensions.get(10).subarray(2)).filter(value => !isGrease(value)),
          signatures: words(extensions.get(13).subarray(2)),
          versions: words(extensions.get(43).subarray(1)).filter(value => !isGrease(value)),
        };
      } catch (error) { parseError = error; }
      finally { socket.destroy(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  // Se captura el handshake real y se cierra antes de responder con un certificado.
  await assert.rejects(client.get('https://127.0.0.1:' + server.address().port));
  assert.ifError(parseError);
  assert.ok(hello, 'No se recibió un ClientHello; la configuración TLS pudo ser rechazada');
  return hello;
}

for (const headerMode of ['profile', 'provided']) {
  test('https-tls overrides the native Chrome ClientHello in ' + headerMode + ' mode', { timeout: 5000 }, async t => {
    const hello = await captureHello(t, { impersonate: 'chrome124', httpsTlsUserAgent: chromeUA, headerMode });
    assert.deepEqual(hello.groups, [29, 23, 24]);
    assert.deepEqual(hello.signatures, [0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601]);
    assert.deepEqual(hello.ciphers, [0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc013, 0xc014, 0x009c, 0x009d, 0x002f, 0x0035]);
    assert.deepEqual(hello.versions, [0x0304, 0x0303, 0x0302, 0x0301]);
    assert.ok(hello.alpn.includes('h2'), 'El perfil conserva ALPN HTTP/2');
  });
}

test('https-tls translates Safari legacy signature names and TLS version limits', { timeout: 5000 }, async t => {
  const hello = await captureHello(t, { httpsTlsUserAgent: safariUA });
  assert.deepEqual(hello.groups, [29, 23, 24, 25]);
  assert.deepEqual(hello.signatures, [0x0403, 0x0804, 0x0401, 0x0503, 0x0203, 0x0805, 0x0501, 0x0806, 0x0601, 0x0201]);
  assert.deepEqual(hello.versions, [0x0304, 0x0303]);
});

test('https-tls translates Firefox signatures and supported groups', { timeout: 5000 }, async t => {
  const hello = await captureHello(t, { impersonate: 'firefox135', httpsTlsUserAgent: firefoxUA });
  assert.deepEqual(hello.groups, [29, 23, 24, 25, 256, 257]);
  assert.deepEqual(hello.signatures, [0x0403, 0x0503, 0x0603, 0x0804, 0x0805, 0x0806, 0x0401, 0x0501, 0x0601, 0x0203, 0x0201]);
  assert.deepEqual(hello.versions, [0x0304, 0x0303]);
});

for (const headerMode of ['profile', 'provided']) {
  test('https-tls keeps its User-Agent stable for GET/POST and decodes gzip in ' + headerMode + ' mode', async t => {
    const headers = { 'User-Agent': 'ignored constructor UA', 'Accept-Encoding': 'gzip', 'X-Test': 'default' };
    const client = new ImpersClient({ impersonate: 'chrome124', httpsTlsUserAgent: chromeUA, headerMode, headers });
    t.after(() => client.close());
    const server = createHttpServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.from(JSON.stringify({ method: req.method, headers: req.headers, body }))));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const url = 'http://127.0.0.1:' + server.address().port;
    const overrides = { 'user-agent': 'ignored request UA', 'x-test': 'request', Authorization: 'local-only' };
    const get = await (await client.get(url, overrides)).json();
    assert.equal(get.headers['user-agent'], chromeUA);
    assert.equal(get.headers['x-test'], 'request');
    assert.equal(get.headers.authorization, 'local-only');
    const body = { value: [1, 2] };
    const post = await (await client.post(url, body, overrides)).json();
    assert.equal(post.headers['user-agent'], chromeUA);
    assert.equal(post.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(post.body), body);
    assert.equal(headers['User-Agent'], 'ignored constructor UA');
    assert.equal(overrides['user-agent'], 'ignored request UA');
  });
}

test('httpsTlsUserAgent rejects an empty value before starting the native engine', () => {
  for (const httpsTlsUserAgent of ['', '   ']) {
    assert.throws(() => new ImpersClient({ httpsTlsUserAgent }), /httpsTlsUserAgent/);
  }
});
