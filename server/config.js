import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HARD_MAX_COMPRESSED_BYTES = 70_000_000;
const HARD_MAX_PARALLEL = 10;

function looksLikePlaceholder(value) {
  return /^(?:replace-with|change-me|请替换)/i.test(String(value || '').trim());
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} 必须是 JSON 对象`);
  }
}

function asPositiveInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return parsed;
}

function readAuthUsers(rawAuth) {
  assertPlainObject(rawAuth, 'auth');
  const source = rawAuth.users ?? rawAuth.tokens;
  if (!Array.isArray(source) || source.length < 1) {
    throw new Error('auth.users 必须至少配置一个用户 token');
  }

  const ids = new Set();
  const tokens = new Set();
  return source.map((entry, index) => {
    const user = typeof entry === 'string'
      ? { id: `user-${index + 1}`, label: `用户 ${index + 1}`, token: entry }
      : entry;
    assertPlainObject(user, `auth.users[${index}]`);
    const id = String(user.id || '').trim();
    const label = String(user.label || id).trim();
    const token = String(user.token || '').trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
      throw new Error(`auth.users[${index}].id 仅允许 1-64 位字母、数字、点、下划线或连字符`);
    }
    if (!label) throw new Error(`auth.users[${index}].label 不能为空`);
    if (token.length < 16) throw new Error(`auth.users[${index}].token 至少需要 16 个字符`);
    if (looksLikePlaceholder(token)) throw new Error(`auth.users[${index}].token 仍是示例占位值，请替换后再启动`);
    if (ids.has(id)) throw new Error(`用户 id 重复：${id}`);
    if (tokens.has(token)) throw new Error('用户 token 不能重复');
    ids.add(id);
    tokens.add(token);
    return { id, label, token };
  });
}

export function loadConfig() {
  const configPath = path.resolve(process.env.CONFIG_PATH || path.join(ROOT, 'config.json'));
  if (!fs.existsSync(configPath)) {
    throw new Error(`找不到配置文件：${configPath}`);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`config.json 无法解析：${error.message}`);
  }

  assertPlainObject(raw, '配置');
  assertPlainObject(raw.provider, 'provider');
  if (raw.provider.extraHeaders !== undefined) {
    assertPlainObject(raw.provider.extraHeaders, 'provider.extraHeaders');
  }

  const providerUrl = String(raw.provider.url || '').trim();
  if (!providerUrl) throw new Error('provider.url 不能为空');
  let parsedUrl;
  try {
    parsedUrl = new URL(providerUrl);
  } catch {
    throw new Error('provider.url 不是有效 URL');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('provider.url 仅支持 http 或 https');
  }

  const authUsers = readAuthUsers(raw.auth);
  if (raw.auth.cookieSecure !== undefined && typeof raw.auth.cookieSecure !== 'boolean') {
    throw new Error('auth.cookieSecure 必须是布尔值');
  }
  const sessionSecret = String(process.env.SESSION_SECRET || raw.auth.sessionSecret || '').trim();
  if (sessionSecret.length < 32) throw new Error('auth.sessionSecret 至少需要 32 个字符');
  if (looksLikePlaceholder(sessionSecret)) throw new Error('auth.sessionSecret 仍是示例占位值，请替换后再启动');

  if (!Array.isArray(raw.models) || raw.models.length !== 4) {
    throw new Error('models 必须且只能配置 4 个模型');
  }

  const seen = new Set();
  const models = raw.models.map((model, index) => {
    assertPlainObject(model, `models[${index}]`);
    const id = String(model.id || '').trim();
    const label = String(model.label || id).trim();
    if (!id) throw new Error(`models[${index}].id 不能为空`);
    if (seen.has(id)) throw new Error(`模型 id 重复：${id}`);
    seen.add(id);
    if (model.request !== undefined) assertPlainObject(model.request, `models[${index}].request`);
    return { id, label: label || id, request: model.request || {} };
  });

  const limits = raw.limits || {};
  const maxParallelTasks = asPositiveInteger(
    limits.maxParallelTasks,
    HARD_MAX_PARALLEL,
    'limits.maxParallelTasks',
  );
  if (maxParallelTasks > HARD_MAX_PARALLEL) {
    throw new Error('limits.maxParallelTasks 不能超过 10');
  }
  const configuredCompressed = asPositiveInteger(
    limits.maxCompressedAttachmentBytes,
    HARD_MAX_COMPRESSED_BYTES,
    'limits.maxCompressedAttachmentBytes',
  );
  if (configuredCompressed > HARD_MAX_COMPRESSED_BYTES) {
    throw new Error('limits.maxCompressedAttachmentBytes 不能超过 70000000 字节');
  }

  const listen = raw.listen || {};
  const port = asPositiveInteger(process.env.PORT || listen.port, 3000, 'listen.port');
  if (port > 65535) throw new Error('listen.port 必须小于等于 65535');

  return Object.freeze({
    rootDir: ROOT,
    configPath,
    chatDir: path.resolve(process.env.CHAT_DIR || path.join(ROOT, 'chat')),
    distDir: path.resolve(path.join(ROOT, 'dist')),
    listen: {
      host: String(process.env.HOST || listen.host || '0.0.0.0'),
      port,
    },
    auth: {
      users: authUsers,
      sessionSecret,
      cookieSecure: Boolean(raw.auth.cookieSecure),
    },
    provider: {
      url: providerUrl,
      key: String(process.env.PROVIDER_KEY || raw.provider.key || ''),
      extraHeaders: raw.provider.extraHeaders || {},
      systemPrompt: String(raw.provider.systemPrompt || '').trim(),
    },
    models,
    limits: {
      maxParallelTasks,
      maxCompressedAttachmentBytes: configuredCompressed,
      maxRawUploadBytes: asPositiveInteger(
        limits.maxRawUploadBytes,
        512 * 1024 * 1024,
        'limits.maxRawUploadBytes',
      ),
      maxFiles: asPositiveInteger(limits.maxFiles, 100, 'limits.maxFiles'),
      maxPromptChars: asPositiveInteger(limits.maxPromptChars, 100_000, 'limits.maxPromptChars'),
      maxAnswerChars: asPositiveInteger(limits.maxAnswerChars, 10_000_000, 'limits.maxAnswerChars'),
      maxProviderErrorBytes: asPositiveInteger(
        limits.maxProviderErrorBytes,
        128 * 1024,
        'limits.maxProviderErrorBytes',
      ),
    },
  });
}
