import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const [name, input, expected] of [
  ['detects a Cloudflare challenge from header records', {
    statusCode: 403, headers: { 'cf-mitigated': 'challenge' },
  }, { detected: true, provider: 'cloudflare', detection: 'headers', technique: 'javascript' }],
  ['accepts native Headers', {
    statusCode: 403, headers: new Headers({ 'cf-mitigated': 'challenge' }),
  }, { detected: true, provider: 'cloudflare', detection: 'headers', technique: 'javascript' }],
  ['detects a Cloudflare challenge from HTML', {
    statusCode: 403, html: '<script>window._cf_chl_opt = { cType: "managed" };</script>',
  }, { detected: true, provider: 'cloudflare', detection: 'html', technique: 'javascript' }],
  ['accepts the body and status aliases supported by the library', {
    status: 403, body: '<script>window._cf_chl_opt = { cType: "managed" };</script>',
  }, { detected: true, provider: 'cloudflare', detection: 'html', technique: 'javascript' }],
  ['returns no detection for a normal response', {
    statusCode: 200, headers: { 'content-type': 'text/html' }, html: '<html><h1>Hello</h1></html>', url: 'https://example.com/',
  }, { detected: false, provider: null, detection: null, technique: null }],
  ['does not invent a protection provider for a generic HTTP 403', {
    statusCode: 403, html: 'Forbidden', url: 'https://example.com/',
  }, { detected: false, provider: null, detection: null, technique: null }],
  ['returns no detection when no signals are provided', {},
    { detected: false, provider: null, detection: null, technique: null }],
]) {
  test('AntibotDetector ' + name, async () => {
    const { AntibotDetector } = await import('../src/tool/AntibotDetector.ts');
    assert.deepEqual(new AntibotDetector().check(input), expected);
  });
}
