import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const [name, userAgent, expected] of [
  ['recognizes a declared Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', true],
  ['does not flag a normal browser', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', false],
  ['returns false for an empty User-Agent', '', false],
]) {
  test('BotDetector ' + name, async () => {
    const { BotDetector } = await import('../src/tool/BotDetector.ts');
    assert.equal(new BotDetector().check(userAgent), expected);
  });
}
