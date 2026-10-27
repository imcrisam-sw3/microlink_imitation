import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { TlsClient } from '../src/TlsClient.ts';
import { FingerprintClient } from '../src/FingerprintClient.ts';

for (const [name, createClient] of [
  ['TlsClient', () => new TlsClient('Mozilla/5.0 Chrome/153.0.0.0 Safari/537.36')],
  ['FingerprintClient', () => new FingerprintClient({ browsers: ['chrome'] })],
]) {
test(`${name} emits the configured Chrome signature algorithms in its ClientHello`, { timeout: 5000 }, async () => {
  let signatures;
  let parseError;
  const server = createServer(socket => {
    let bytes = Buffer.alloc(0);
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 5 || bytes.length < 5 + bytes.readUInt16BE(3)) return;
      try {
        assert.equal(bytes[0], 22); // TLS handshake record.
        assert.equal(bytes[5], 1); // ClientHello.
        let offset = 5 + 4 + 2 + 32;
        offset += 1 + bytes[offset]; // Session ID.
        offset += 2 + bytes.readUInt16BE(offset); // Cipher suites.
        offset += 1 + bytes[offset]; // Compression methods.
        const end = offset + 2 + bytes.readUInt16BE(offset);
        offset += 2;
        while (offset + 4 <= end) {
          const type = bytes.readUInt16BE(offset);
          const length = bytes.readUInt16BE(offset + 2);
          offset += 4;
          if (type === 13) {
            signatures = [];
            for (let i = offset + 2; i < offset + length; i += 2) signatures.push(bytes.readUInt16BE(i));
          }
          offset += length;
        }
      } catch (error) { parseError = error; }
      finally { socket.destroy(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = createClient();
  try {
    // El servidor captura el ClientHello y cierra sin completar TLS.
    await assert.rejects(client.get(`https://127.0.0.1:${server.address().port}`));
    assert.ifError(parseError);
    assert.deepEqual(signatures, [0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601]);
  } finally {
    await client.close();
    await new Promise(resolve => server.close(resolve));
  }
});
}

test('ImpersClient emits a native Safari ClientHello with GREASE and HTTP/2 ALPN', { timeout: 5000 }, async () => {
  const { createServer } = await import('node:net');
  const { ImpersClient } = await import('../src/ImpersClient.ts');
  const client = new ImpersClient();
  await client.ready();
  let captured;
  let parseError;
  const server = createServer(socket => {
    let bytes = Buffer.alloc(0);
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 5 || bytes.length < 5 + bytes.readUInt16BE(3)) return;
      try {
        assert.equal(bytes[0], 22);
        assert.equal(bytes[5], 1);
        let offset = 5 + 4 + 2 + 32;
        offset += 1 + bytes[offset];
        const cipherEnd = offset + 2 + bytes.readUInt16BE(offset);
        const ciphers = [];
        for (offset += 2; offset < cipherEnd; offset += 2) ciphers.push(bytes.readUInt16BE(offset));
        offset += 1 + bytes[offset];
        const end = offset + 2 + bytes.readUInt16BE(offset);
        offset += 2;
        const alpn = [];
        while (offset + 4 <= end) {
          const type = bytes.readUInt16BE(offset);
          const length = bytes.readUInt16BE(offset + 2);
          offset += 4;
          if (type === 16) {
            let cursor = offset + 2;
            while (cursor < offset + length) {
              const size = bytes[cursor++];
              alpn.push(bytes.subarray(cursor, cursor + size).toString());
              cursor += size;
            }
          }
          offset += length;
        }
        captured = { ciphers, alpn };
      } catch (error) { parseError = error; }
      finally { socket.destroy(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(client.get('https://127.0.0.1:' + server.address().port));
    assert.ifError(parseError);
    assert.ok(captured, 'No se recibió ClientHello');
    assert.ok(captured.ciphers.some(value => (value & 0x0f0f) === 0x0a0a), 'Falta GREASE del perfil nativo');
    assert.ok(captured.alpn.includes('h2'), 'Falta ALPN HTTP/2 del perfil Safari');
  } finally {
    await client.close();
    await new Promise(resolve => server.close(resolve));
  }
});
