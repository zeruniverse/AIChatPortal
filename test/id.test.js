import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientConversationId } from '../frontend/src/id.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function replaceCrypto(value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  };
}

test('HTTP 环境没有 crypto.randomUUID 时仍能生成合法 UUID v4', () => {
  const restore = replaceCrypto(undefined);
  try {
    const first = createClientConversationId();
    const second = createClientConversationId();
    assert.match(first, UUID_V4);
    assert.match(second, UUID_V4);
    assert.notEqual(first, second);
  } finally {
    restore();
  }
});

test('只有 getRandomValues 时不依赖 secure-context randomUUID', () => {
  let calls = 0;
  const restore = replaceCrypto({
    getRandomValues(bytes) {
      calls += 1;
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index + 1;
      return bytes;
    },
  });
  try {
    assert.match(createClientConversationId(), UUID_V4);
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});
