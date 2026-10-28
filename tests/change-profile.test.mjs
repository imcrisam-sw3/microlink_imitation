import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { test } from 'node:test';
import { TlsClient } from '../src/client/TlsClient.ts';
import { FingerprintClient } from '../src/client/FingerprintClient.ts';
import { ImpersClient } from '../src/client/ImpersClient.ts';
import { UtlsClient } from '../src/client/UtlsClient.ts';

const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';
const firefox = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0';
const previousHeaders = { Authorization: 'previous-token', 'X-Previous': 'old', 'sec-ch-ua-platform': '"iOS"' };
const fingerprintOptions = { browsers: ['firefox'], operatingSystems: ['windows'], devices: ['desktop'], locales: ['en-US'] };
const cases = [
  {
    name: 'TlsClient',
    create: () => new TlsClient(safari, { ...previousHeaders, Cookie: 'manual=old' }),
    change: client => client.changeProfile(firefox, { 'X-New': 'new' }),
    invalid: client => client.changeProfile(''),
    userAgent: /Firefox\/135/,
  },
  {
    name: 'FingerprintClient',
    create: () => new FingerprintClient({ browsers: ['safari'], operatingSystems: ['ios'], devices: ['mobile'] }),
    change: client => client.changeProfile(fingerprintOptions),
    invalid: client => client.changeProfile({ browsers: ['not-a-browser'], strict: true }),
    userAgent: /Firefox/,
  },
  {
    name: 'ImpersClient',
    create: () => new ImpersClient({ impersonate: 'chrome124', headerMode: 'provided', httpsTlsUserAgent: safari, headers: previousHeaders }),
    change: client => client.changeProfile({ impersonate: 'safari_ios' }),
    invalid: client => client.changeProfile({ impersonate: '' }),
    userAgent: /iPhone.*Safari/,
    cookies: true,
  },
  {
    name: 'UtlsClient',
    create: () => new UtlsClient({ profile: 'chrome', headers: { ...previousHeaders, 'User-Agent': safari } }),
    change: client => client.changeProfile({ profile: 'firefox', headers: { 'User-Agent': firefox, 'X-New': 'new' } }),
    invalid: client => client.changeProfile({ profile: 'invalid' }),
    userAgent: /Firefox\/135/,
    cookies: true,
  },
];

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
  if (req.url === '/set') res.setHeader('set-cookie', 'session=previous; Path=/');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ headers: req.headers, port: req.socket.remotePort, method: req.method, body }));
}

async function captureHello(t, client) {
  let ciphers;
  let parseError;
  const server = createTcpServer(socket => {
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
        const end = offset + 2 + bytes.readUInt16BE(offset);
        ciphers = [];
        for (offset += 2; offset < end; offset += 2) {
          const value = bytes.readUInt16BE(offset);
          if ((value & 0x0f0f) !== 0x0a0a) ciphers.push(value);
        }
      } catch (error) { parseError = error; }
      finally { socket.destroy(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(client.get('https://127.0.0.1:' + server.address().port));
    assert.ifError(parseError);
    assert.ok(ciphers?.length, 'No se recibió el ClientHello');
    return ciphers;
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

for (const entry of cases) {
  test(entry.name + ' changeProfile discards headers, cookies, connections and the previous client', { timeout: 10000 }, async t => {
    const clients = [entry.create()];
    t.after(async () => { for (const client of clients) await client.close(); });
    const original = clients[0];
    assert.equal(typeof original.changeProfile, 'function');
    const url = await serve(t, echo);
    const first = await (await original.get(url + '/set')).json();
    const before = await (await original.get(url)).json();
    const pid = original.processId;
    if (entry.cookies) assert.match(before.headers.cookie, /session=previous/);

    const client = await entry.change(original);
    clients.push(client);
    assert.notEqual(client, original);
    const after = await (await client.post(url, { fresh: true })).json();
    assert.match(after.headers['user-agent'], entry.userAgent);
    assert.notEqual(after.headers['user-agent'], before.headers['user-agent']);
    for (const key of ['authorization', 'cookie', 'x-previous']) assert.equal(after.headers[key], undefined);
    assert.notEqual(after.headers['sec-ch-ua-platform'], '"iOS"');
    assert.ok(![first.port, before.port].includes(after.port), 'Reutilizó una conexión anterior');
    assert.equal(after.method, 'POST');
    assert.deepEqual(JSON.parse(after.body), { fresh: true });
    await assert.rejects(original.get(url));

    if (entry.name === 'ImpersClient') {
      assert.equal(client.headerMode, 'profile');
      assert.equal(client.httpsTlsUserAgent, undefined);
      assert.equal(client.impersonate, 'safari_ios');
    }
    if (entry.name === 'FingerprintClient') {
      assert.notEqual(client.fingerprint, original.fingerprint);
      assert.equal(client.fingerprint.navigator.userAgent, client.userAgent);
    }
    if (pid) {
      assert.notEqual(client.processId, pid);
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    }

    // También se aísla la sesión al repetir la operación con el mismo perfil.
    await (await client.get(url + '/set')).text();
    const next = await entry.change(client);
    clients.push(next);
    const reset = await (await next.get(url)).json();
    assert.equal(reset.headers.cookie, undefined);
    assert.notEqual(reset.port, after.port);
    await assert.rejects(client.get(url));
  });

  for (const phase of ['headers', 'body']) {
    test(entry.name + ' changeProfile cancels the old request waiting for ' + phase, { timeout: 10000 }, async t => {
      const clients = [entry.create()];
      t.after(async () => { for (const client of clients) await client.close(); });
      const original = clients[0];
      assert.equal(typeof original.changeProfile, 'function');
      let arrived;
      const arrival = new Promise(resolve => { arrived = resolve; });
      const url = await serve(t, (req, res) => {
        if (req.url === '/ok') { res.end('ok'); return; }
        if (phase === 'body') { res.writeHead(200); res.write('partial'); }
        arrived();
      });
      const pending = assert.rejects((async () => (await original.get(url)).text())());
      await arrival;
      const client = await entry.change(original);
      clients.push(client);
      await pending;
      assert.equal(await (await client.get(url + '/ok')).text(), 'ok');
    });
  }

  test(entry.name + ' validates the new configuration before closing the current client', { timeout: 10000 }, async t => {
    const client = entry.create();
    t.after(() => client.close());
    assert.equal(typeof client.changeProfile, 'function');
    const url = await serve(t, echo);
    await assert.rejects(async () => entry.invalid(client));
    assert.equal((await client.get(url)).status, 200);
  });

  test(entry.name + ' changeProfile changes the actual TLS ClientHello', { timeout: 10000 }, async t => {
    const clients = [entry.create()];
    t.after(async () => { for (const client of clients) await client.close(); });
    assert.equal(typeof clients[0].changeProfile, 'function');
    const before = await captureHello(t, clients[0]);
    const next = await entry.change(clients[0]);
    clients.push(next);
    assert.notDeepEqual(await captureHello(t, next), before);
  });
}

function family(userAgent) {
  return userAgent.includes('Firefox') ? 'firefox' : userAgent.includes('Chrome') ? 'chrome' : 'safari';
}

const utlsUserAgents = {
  chrome: /Windows NT.*Chrome\/133\./,
  firefox: /Windows NT.*Firefox\/120\./,
  safari: /Macintosh.*Version\/16\.0.*Safari/,
  ios: /iPhone OS 14_0.*Version\/14\.0.*Mobile.*Safari/,
};

for (const entry of cases) {
  test(entry.name + ' automatically chooses a different profile and resets the session without arguments', { timeout: 10000 }, async t => {
    const clients = [entry.create()];
    t.after(() => Promise.all(clients.map(client => client.close())));
    const url = await serve(t, echo);
    let client = clients[0];
    for (let attempt = 0; attempt < 4; attempt++) {
      await (await client.get(url + '/set')).text();
      const before = await (await client.get(url)).json();
      const oldPid = client.processId;
      const previous = client;
      client = await previous.changeProfile();
      clients.push(client);
      assert.notEqual(client, previous);
      const after = await (await client.post(url, { fresh: true })).json();
      assert.ok(after.headers['user-agent']);
      assert.notEqual(after.headers['user-agent'], before.headers['user-agent']);
      for (const key of ['cookie', 'authorization', 'x-previous']) assert.equal(after.headers[key], undefined);
      assert.notEqual(after.port, before.port);
      assert.deepEqual(JSON.parse(after.body), { fresh: true });
      await assert.rejects(previous.get(url));
      if (entry.name === 'TlsClient' || entry.name === 'FingerprintClient') {
        assert.notEqual(family(client.userAgent), family(previous.userAgent), 'Repitió la familia TLS anterior');
        assert.notDeepEqual(client.tlsOptions, previous.tlsOptions);
        assert.equal(after.headers['user-agent'], client.userAgent);
      }
      if (entry.name === 'FingerprintClient') {
        assert.notEqual(client.fingerprint, previous.fingerprint);
        assert.equal(client.fingerprint.navigator.userAgent, client.userAgent);
      }
      if (entry.name === 'ImpersClient') {
        assert.notEqual(client.impersonate.match(/^[a-z]+/i)[0], previous.impersonate.match(/^[a-z]+/i)[0]);
        assert.equal(client.headerMode, 'profile');
        assert.equal(client.httpsTlsUserAgent, undefined);
      }
      if (entry.name === 'UtlsClient') {
        assert.notEqual(client.profile, previous.profile);
        assert.match(after.headers['user-agent'], utlsUserAgents[client.profile]);
        assert.notEqual(client.processId, oldPid);
        assert.throws(() => process.kill(oldPid, 0), /ESRCH/);
      }
    }
  });

  for (const phase of ['headers', 'body']) {
    test(entry.name + ' automatic changeProfile cancels the previous request waiting for ' + phase, { timeout: 10000 }, async t => {
      const clients = [entry.create()];
      t.after(() => Promise.all(clients.map(client => client.close())));
      let arrived;
      const arrival = new Promise(resolve => { arrived = resolve; });
      const url = await serve(t, (req, res) => {
        if (req.url === '/ok') { res.end('ok'); return; }
        if (phase === 'body') { res.writeHead(200); res.write('partial'); }
        arrived();
      });
      const pending = assert.rejects((async () => (await clients[0].get(url)).text())());
      await arrival;
      const next = await clients[0].changeProfile();
      clients.push(next);
      await pending;
      assert.equal(await (await next.get(url + '/ok')).text(), 'ok');
    });
  }
}

test('ImpersClient automatic selection excludes the current native family when it was configured with an alias', async t => {
  const original = new ImpersClient({ impersonate: 'safari_ios' });
  let next;
  t.after(async () => { await original.close(); await next?.close(); });
  next = await original.changeProfile();
  assert.doesNotMatch(next.impersonate, /^safari/);
  const url = await serve(t, echo);
  const data = await (await next.get(url)).json();
  assert.doesNotMatch(data.headers['user-agent'], /Version\/.*Safari\//);
});


for (const entry of cases) {
  test(entry.name + ' automatic selection changes the actual TLS ClientHello', { timeout: 10000 }, async t => {
    // Parte del perfil nativo; los overrides TLS se verifican en los casos de aislamiento.
    const clients = [entry.name === 'ImpersClient' ? new ImpersClient() : entry.create()];
    t.after(() => Promise.all(clients.map(client => client.close())));
    const before = await captureHello(t, clients[0]);
    const next = await clients[0].changeProfile();
    clients.push(next);
    assert.notDeepEqual(await captureHello(t, next), before);
  });
}

test('every native Impers profile in the automatic selection catalogue is supported by the installed engine', async () => {
  const { Curl, NATIVE_IMPERSONATE_TARGETS } = await import('impers');
  assert.ok(NATIVE_IMPERSONATE_TARGETS.length > 1);
  for (const { target_name } of NATIVE_IMPERSONATE_TARGETS) {
    const curl = new Curl();
    try { assert.doesNotThrow(() => curl.impersonate(target_name), target_name); }
    finally { curl.cleanup(); }
  }
});
