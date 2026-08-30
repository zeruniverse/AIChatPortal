import test from 'node:test';
import assert from 'node:assert/strict';
import { redactProviderSecrets } from '../server/redact.js';

test('provider 主 key、自定义敏感 header 和 URL token 不会写入错误记录', () => {
  const config = {
    provider: {
      url: 'https://user:pass@example.test/path?token=query-secret&mode=x',
      key: 'main-secret',
      extraHeaders: {
        'X-API-Key': 'custom-secret',
        Authorization: 'Bearer bearer-secret',
        'X-Region': 'region-1',
      },
    },
  };
  const redacted = redactProviderSecrets(
    'main-secret custom-secret Bearer bearer-secret query-secret user pass region-1',
    config,
  );
  assert.equal(redacted.includes('main-secret'), false);
  assert.equal(redacted.includes('custom-secret'), false);
  assert.equal(redacted.includes('bearer-secret'), false);
  assert.equal(redacted.includes('query-secret'), false);
  assert.equal(redacted.includes('user'), false);
  assert.equal(redacted.includes('pass'), false);
  assert.equal(redacted.includes('region-1'), true);
});
