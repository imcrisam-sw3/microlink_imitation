import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {loadProfile} from '../src/profile.js';
import {compareResponses} from '../src/compare.js';

async function profile(t: test.TestContext, value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'microlink-profile-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const path = join(directory, 'request.json');
  await writeFile(path, JSON.stringify(value));
  return path;
}
test('POST preserves literal authorization and serializes JSON only once', async t => {
  const path = await profile(t, {url:'https://example.com/odds?a=1', method:'POST', headers:{Authorization:'${TOKEN}', 'Content-Type':'application/json'}, body:{odds:[{price:1.07}]}});
  const result = await loadProfile(path, {TOKEN:'opaque-token'});
  assert.equal(result.request.headers.authorization, 'opaque-token');
  assert.equal(result.request.body, '{"odds":[{"price":1.07}]}');
  assert.equal(result.template.headers.authorization, '${TOKEN}');
});
test('a missing credential fails before any request can be sent', async t => {
  const path = await profile(t, {url:'https://example.com', method:'GET', headers:{authorization:'${TOKEN}'}});
  await assert.rejects(() => loadProfile(path, {}), /TOKEN/);
});
test('GET rejects a non-null body', async t => {
  const path = await profile(t, {url:'https://example.com', method:'GET', body:{unexpected:true}});
  await assert.rejects(() => loadProfile(path, {}), /GET/);
});
test('raw POST strings are preserved without double JSON encoding', async t => {
  const path = await profile(t, {url:'https://example.com', method:'POST', body:'{"culture":"es-ES"}'});
  assert.equal((await loadProfile(path, {})).request.body, '{"culture":"es-ES"}');
});
test('JSON equality ignores object key order and supports null', () => {
  const response = (body:string) => ({status:200,headers:{'content-type':'application/json'},body,durationMs:1});
  assert.equal(compareResponses(response('{"a":1,"b":null}'),response('{"b":null,"a":1}')).jsonEqual,true);
  assert.equal(compareResponses(response('null'),response('null')).jsonEqual,true);
});
test('changing odds are successful access with a separate JSON difference', () => {
  const response = (body:string) => ({status:200,headers:{'content-type':'application/json'},body,durationMs:1});
  const result = compareResponses(response('{"price":1.07}'),response('{"price":1.08}'));
  assert.equal(result.accessWorks,true);
  assert.equal(result.jsonEqual,false);
  assert.deepEqual(result.differences,[{path:'$.price',remote:1.07,local:1.08}]);
});
test('HTML 403 is an upstream access failure even if both bodies match', () => {
  const result=compareResponses({status:403,headers:{'content-type':'text/html'},body:'<html>blocked</html>',durationMs:1},{status:403,headers:{'content-type':'text/html'},body:'<html>blocked</html>',durationMs:1});
  assert.equal(result.accessWorks,false);
  assert.equal(result.remoteOutcome,'http-error');
});
