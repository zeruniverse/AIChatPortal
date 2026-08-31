import fs from 'node:fs';
import path from 'node:path';

export function loadConfig(rootDir) {
  const configPath = process.env.CONFIG_PATH || path.join(rootDir, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.host ||= '0.0.0.0';
  config.port = Number(config.port || 3000);
  config.auth ||= {};
  config.auth.cookieName ||= 'chat_session';
  config.provider ||= {};
  config.provider.headers ||= {};
  config.provider.extraBody ||= {};
  config.cors = {
    allowedOrigins: ['http://localhost:5173'],
    ...(config.cors || {})
  };
  config.limits = {
    maxConcurrentTasks: 10,
    maxCompressedAttachmentBytes: 78_000_000,
    maxRawUploadBytesPerTurn: 1_000_000_000,
    maxFilesPerTurn: 100,
    ...(config.limits || {})
  };
  if (config.limits.maxRawUploadBytesPerTurn === 0) config.limits.maxRawUploadBytesPerTurn = 1_000_000_000;
  config.cleanup = {
    maxChatBytes: 3_000_000_000,
    pressureAgeHours: 24,
    maxAgeDays: 7,
    orphanUploadHours: 24,
    intervalMinutes: 10,
    ...(config.cleanup || {})
  };
  validate(config);
  return config;
}

function validate(config) {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('config.port 无效');
  if (!Array.isArray(config.models) || config.models.length < 1 || config.models.length > 10) throw new Error('models 数量必须为 1 到 10');
  const modelIds = new Set();
  for (const model of config.models) {
    if (!model?.id || !model?.label) throw new Error('每个模型必须配置 id 和 label');
    if (modelIds.has(model.id)) throw new Error(`模型 id 重复：${model.id}`);
    modelIds.add(model.id);
  }
  if (!config.provider.url || !/^https?:\/\//i.test(config.provider.url)) throw new Error('provider.url 必须是 HTTP 或 HTTPS URL');
  if (!config.provider.key || /replace-with/i.test(config.provider.key)) throw new Error('provider.key 不能为空且必须替换示例值');
  if (!Array.isArray(config.auth.users) || config.auth.users.length < 1) throw new Error('至少需要配置一个登录用户');
  if (!config.auth.sessionSecret || config.auth.sessionSecret.length < 32 || /replace-with/i.test(config.auth.sessionSecret)) throw new Error('auth.sessionSecret 必须替换为至少 32 字符的随机值');
  const userIds = new Set();
  const tokens = new Set();
  for (const user of config.auth.users) {
    if (!user?.id || !user?.token) throw new Error('每个用户必须配置 id 和 token');
    if (user.token.length < 12 || /replace-with/i.test(user.token)) throw new Error(`用户 ${user.id} 的 token 过短或仍是示例值`);
    if (userIds.has(user.id) || tokens.has(user.token)) throw new Error('用户 id 和 token 必须唯一');
    userIds.add(user.id); tokens.add(user.token);
  }
  if (config.auth.legacyOwnerId && !userIds.has(config.auth.legacyOwnerId)) throw new Error('auth.legacyOwnerId 必须对应 auth.users 中的用户 id');
  if (!Array.isArray(config.cors.allowedOrigins) || config.cors.allowedOrigins.length < 1) throw new Error('cors.allowedOrigins 至少需要配置一个前端 Origin');
  for (const origin of config.cors.allowedOrigins) {
    if (typeof origin !== 'string' || !/^https?:\/\//i.test(origin) || origin.endsWith('/')) throw new Error(`cors.allowedOrigins 无效：${origin}`);
  }
  if (config.limits.maxConcurrentTasks < 1 || config.limits.maxConcurrentTasks > 10) throw new Error('maxConcurrentTasks 必须为 1 到 10');
  if (!Number.isSafeInteger(config.limits.maxCompressedAttachmentBytes) || config.limits.maxCompressedAttachmentBytes < 1 || config.limits.maxCompressedAttachmentBytes > 78_000_000) throw new Error('压缩附件上限必须为 1 到 78,000,000 字节');
  if (!Number.isSafeInteger(config.limits.maxRawUploadBytesPerTurn) || config.limits.maxRawUploadBytesPerTurn < 1 || config.limits.maxRawUploadBytesPerTurn > 1_000_000_000) throw new Error('每轮附件原始总大小上限必须为 1 到 1,000,000,000 字节');
}
