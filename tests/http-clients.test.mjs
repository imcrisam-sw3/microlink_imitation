import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

for (const name of ['TlsClient', 'FingerprintClient']) {
  test(`${name} sends GET and JSON POST with a stable User-Agent and preserves caller headers`, async () => {
    let imported;
    try { imported = await import(`../src/${name}.ts`); }
    catch (error) { assert.fail(`${name} must be implemented: ${error.message}`); }
    const Client = imported[name];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, headers: req.headers, body }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let client;
    try {
      client = new Client();
      const url = `http://127.0.0.1:${server.address().port}`;
      const headers = { Accept: 'application/json', Origin: 'https://caller.example', Referer: 'https://caller.example/', authorization: 'test-authorization', 'accept-language': 'es-ES', 'User-Agent': 'must-not-conflict-with-tls' };
      const original = { ...headers };
      const firstResponse = await client.get(url, headers);
      assert.equal(firstResponse.status, 200);
      const first = await firstResponse.json();
      assert.equal(first.method, 'GET');
      assert.equal(first.body, '');
      assert.equal(first.headers['user-agent'], client.userAgent);
      assert.notEqual(client.userAgent, 'must-not-conflict-with-tls');
      assert.equal(first.headers.origin, 'https://caller.example');
      assert.equal(first.headers.referer, 'https://caller.example/');
      assert.equal(first.headers.authorization, 'test-authorization');
      assert.equal(first.headers.accept, 'application/json');
      assert.equal(first.headers['accept-language'], 'es-ES');
      assert.deepEqual(headers, original);
      const post = await (await client.post(url, { odds: [1, 2] }, headers)).json();
      assert.equal(post.method, 'POST');
      assert.equal(post.headers['user-agent'], first.headers['user-agent']);
      assert.equal(post.headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(post.body), { odds: [1, 2] });
      const custom = await (await client.post(url, { ok: true }, { 'Content-Type': 'application/problem+json' })).json();
      assert.equal(custom.headers['content-type'], 'application/problem+json');
      if (name === 'FingerprintClient') {
        assert.equal(client.fingerprint.navigator.userAgent, client.userAgent);
        assert.equal(new Headers(client.headers).get('user-agent'), client.userAgent);
        assert.ok(Object.keys(client.headers).length > 1);
      }
      await client.close();
      const closedClient = client;
      client = undefined;
      await assert.rejects(closedClient.get(url));
    } finally {
      if (client) await client.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

// Se bloquean las dependencias durante la carga real del módulo, sin inspeccionar su texto.
test('FingerprintClient runs without loading TlsClient or https-tls', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier.includes('TlsClient') || specifier === 'https-tls') {
        throw new Error('Forbidden FingerprintClient dependency: ' + specifier);
      }
      return nextResolve(specifier, context);
    }});
    const { FingerprintClient } = await import('./src/FingerprintClient.ts');
    const client = new FingerprintClient();
    if (!client.userAgent) throw new Error('Missing generated User-Agent');
    await client.close();
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
