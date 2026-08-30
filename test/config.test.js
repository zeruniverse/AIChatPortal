import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';

function baseConfig() {
  return {
    auth: {
      sessionSecret: 'a-session-secret-that-is-longer-than-32-characters',
      cookieSecure: false,
      users: [
        { id: 'u1', label: '用户一', token: 'a-long-login-token-0001' },
        { id: 'u2', label: '用户二', token: 'a-long-login-token-0002' },
      ],
    },
    provider: { url: 'https://provider.example/v1/chat/completions', key: '' },
    models: Array.from({ length: 4 }, (_, index) => ({ id: `m${index + 1}` })),
    limits: {
      maxParallelTasks: 10,
      maxCompressedAttachmentBytes: 70_000_000,
    },
  };
}

function withConfig(config, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-config-test-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const previous = process.env.CONFIG_PATH;
  process.env.CONFIG_PATH = configPath;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('配置拒绝超过 10 个并行任务，而不是静默接受', () => {
  const config = baseConfig();
  config.limits.maxParallelTasks = 11;
  withConfig(config, () => assert.throws(() => loadConfig(), /不能超过 10/));
});

test('配置要求登录 token 唯一且 sessionSecret 足够长', () => {
  const duplicate = baseConfig();
  duplicate.auth.users[1].token = duplicate.auth.users[0].token;
  withConfig(duplicate, () => assert.throws(() => loadConfig(), /不能重复/));

  const weakSecret = baseConfig();
  weakSecret.auth.sessionSecret = 'short';
  withConfig(weakSecret, () => assert.throws(() => loadConfig(), /至少需要 32/));
});

test('HTTP 前端监听与 HTTPS provider 可以同时配置', () => {
  withConfig(baseConfig(), () => {
    const config = loadConfig();
    assert.equal(config.listen.port, 3000);
    assert.equal(new URL(config.provider.url).protocol, 'https:');
    assert.equal(config.auth.cookieSecure, false);
  });
});


test('配置拒绝直接使用公开示例 token 和 sessionSecret', () => {
  const placeholderToken = baseConfig();
  placeholderToken.auth.users[0].token = 'replace-with-a-public-login-token';
  withConfig(placeholderToken, () => assert.throws(() => loadConfig(), /示例占位值/));

  const placeholderSecret = baseConfig();
  placeholderSecret.auth.sessionSecret = 'replace-with-a-public-session-secret-that-is-long-enough';
  withConfig(placeholderSecret, () => assert.throws(() => loadConfig(), /示例占位值/));
});
