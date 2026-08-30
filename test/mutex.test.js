import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncMutex } from '../server/mutex.js';

test('互斥提交会严格串行执行，并在异常后释放', async () => {
  const mutex = new AsyncMutex();
  const order = [];
  const first = mutex.runExclusive(async () => {
    order.push('first-start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('first-end');
    throw new Error('expected');
  }).catch(() => {});
  const second = mutex.runExclusive(async () => {
    order.push('second');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});
