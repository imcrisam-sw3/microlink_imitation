import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

for (const [entry, nativeReady, sharedProfile = false] of [['main.ts', true], ['main-sofascore.ts', true], ['main-sofascore.ts', false], ['main.ts', true, true], ['main-sofascore.ts', true, true]]) {
  test(entry + (sharedProfile ? ' shared-profile mode' : '') + (nativeReady ? ' compares all three clients against local fixtures' : ' preserves working clients when native engine is unavailable'), { timeout: 20000 }, async () => {
    const seen = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      seen.push({ path: req.url, method: req.method, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/token'
        ? { YUdGb1lTQmtiMjRuZENCbGRtVnVJSFJ5ZVE: 'local-token' }
        : req.url.endsWith('/live') ? { events: [{ id: 11 }] }
        : req.url === '/odds' ? { oddStates: [] } : { statistics: [] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    // Sustituye solamente la configuración de destinos; ejecuta las clases y clientes reales.
    const fixture = entry === 'main.ts'
      ? 'import { Altenar as Base } from ' + JSON.stringify(new URL('../src/Altenar.ts', import.meta.url).href) +
        '; export class Altenar extends Base { constructor() { super(); this.getRequest.url = ' + JSON.stringify(base + '/token') +
        '; this.postRequest.url = ' + JSON.stringify(base + '/odds') + '; } }'
      : 'import { SofaScore as Base } from ' + JSON.stringify(new URL('../src/SofaScore.ts', import.meta.url).href) +
        '; export class SofaScore extends Base { constructor() { super(); this.getRequest.url = ' +
        JSON.stringify(base + '/api/v1/sport/football/events/live') +
        '; } getStatisticsRequest(...args) { const request = super.getStatisticsRequest(...args); request.url = new URL(new URL(request.url).pathname, ' +
        JSON.stringify(base) + ').href; return request; } }';
    const target = entry === 'main.ts' ? './Altenar.js' : './SofaScore.js';
    const entryUrl = new URL('../src/' + entry, import.meta.url).href;
    const nativeFailureHook = nativeReady ? '' : 'if (specifier === "impers") return { url: ' +
      JSON.stringify('data:text/javascript,' + encodeURIComponent('export class Curl { static hasImpersonateSupport() { return false; } } export class Session {}')) +
      ', shortCircuit: true };';
    const script = 'import { registerHooks } from "node:module"; registerHooks({ resolve(specifier, context, nextResolve) {' +
      nativeFailureHook + 'if (context.parentURL === ' + JSON.stringify(entryUrl) + ' && specifier === ' + JSON.stringify(target) +
      ') return { url: "data:text/javascript," + encodeURIComponent(' + JSON.stringify(fixture) + '), shortCircuit: true };' +
      'return nextResolve(specifier, context); }}); ' + (sharedProfile ? 'process.argv.push("--shared-profile"); ' : '') + 'await import(' + JSON.stringify(entryUrl) + ');';
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(code, nativeReady ? 0 : 1, stderr || stdout);
      if (nativeReady) assert.match(stdout, /\[Impers\] Perfil nativo: safari_ios/);
      else assert.match(stderr, /\[Impers\].*Error/);
      assert.match(stdout, /\[TLS\]/);
      assert.match(stdout, /\[Fingerprint\]/);
      assert.equal(seen.length, nativeReady ? 6 : 4);
      if (entry === 'main.ts') {
        assert.equal(seen.filter(row => row.method === 'POST').length, 3);
        for (const row of seen.filter(row => row.method === 'POST')) assert.equal(row.headers.authorization, 'local-token');
        assert.ok(!stdout.includes('local-token'));
      }
      assert.ok(seen.some(row => /iPhone/.test(row.headers['user-agent'])));
      if (sharedProfile) {
        assert.match(stdout, /Headers compartidos/);
        assert.equal(new Set(seen.map(row => row.headers['user-agent'])).size, 1);
        for (const requestPath of new Set(seen.map(row => row.path))) {
          const rows = seen.filter(row => row.path === requestPath);
          for (const name of ['user-agent', 'accept', 'accept-encoding', 'accept-language', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'referer', 'authorization']) {
            assert.deepEqual(rows.map(row => row.headers[name]), Array(rows.length).fill(rows[1].headers[name]), name);
          }
        }
      }
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
