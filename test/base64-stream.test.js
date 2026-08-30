import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { base64EncodedLength, encodeBase64 } from '../server/base64-stream.js';

async function collect(iterable) {
  let value = '';
  for await (const chunk of iterable) value += chunk;
  return value;
}

test('流式 base64 与一次性编码结果一致，包括跨分片边界', async () => {
  const chunks = [Buffer.from([0, 1]), Buffer.from([2, 3, 4, 5]), Buffer.from([6])];
  const expected = Buffer.concat(chunks).toString('base64');
  const actual = await collect(encodeBase64(Readable.from(chunks)));
  assert.equal(actual, expected);
  assert.equal(actual.length, base64EncodedLength(7));
});
