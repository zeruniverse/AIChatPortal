import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase } from '../server/db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'package.json', 'vite.config.js', 'frontend/index.html',
  'frontend/src/main.js', 'frontend/src/state.js', 'frontend/src/api.js', 'frontend/src/id.js', 'frontend/src/keyboard-submit.js',
  'frontend/src/views/LoginPage.vue', 'frontend/src/views/NewChat.vue',
  'frontend/src/views/HistoryPage.vue', 'frontend/src/views/ChatDetail.vue',
  'frontend/src/views/PublicShare.vue', 'frontend/src/components/FilePicker.vue',
  'frontend/src/components/CopyTextButton.vue', 'frontend/src/components/ModelAnswer.vue',
  'frontend/src/components/StatusPill.vue', 'frontend/src/clipboard.js',
  'frontend/src/answer-format.js', 'frontend/src/styles.css',
  'server/app.js', 'server/auth.js', 'server/config.js', 'server/db.js',
  'server/storage.js', 'server/archive.js', 'server/worker.js',
  'server/provider.js', 'server/prompts.js', 'server/cleanup.js',
  'server/assets/a.jpg', 'server/assets/x.jpg', 'chat/sqlite.db', 'config.json', 'config.example.json',
  'Dockerfile', 'docker-compose.yml', 'README.md', 'AUDIT.md',
];
for (const relative of required) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`缺少文件：${relative}`);
}

const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const config = JSON.parse(read('config.json'));
if (!Array.isArray(config.models) || config.models.length < 1 || config.models.length > 10) throw new Error('config.json 必须配置 1-10 个模型');
if (!Array.isArray(config.auth?.users) || config.auth.users.length < 1) throw new Error('config.json 至少需要一个登录 token');
if (new Set(config.auth.users.map((user) => user.id)).size !== config.auth.users.length) throw new Error('登录用户 id 重复');
if (new Set(config.auth.users.map((user) => user.token)).size !== config.auth.users.length) throw new Error('登录 token 重复');
if (String(config.auth.sessionSecret || '').length < 32) throw new Error('sessionSecret 少于 32 个字符');
if (config.limits.maxParallelTasks > 10) throw new Error('全局并行任务上限超过 10');
if (config.limits.maxCompressedAttachmentBytes > 70_000_000) throw new Error('压缩附件上限超过 70,000,000 字节');
for (const model of config.models) {
  if (!model.id || !model.label || typeof model.request !== 'object') throw new Error('模型配置缺少 id、label 或 request');
}

const packageJson = JSON.parse(read('package.json'));
if (packageJson.version !== '5.3.2') throw new Error('项目版本必须为 5.3.2');
for (const [name, version] of Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies })) {
  if (/^[~^*]|\bx\b/i.test(version)) throw new Error(`依赖 ${name} 没有固定版本：${version}`);
}
if (packageJson.dependencies?.archiver) throw new Error('不应残留未使用的 archiver 依赖');

const sources = Object.fromEntries([
  'html', 'frontend/index.html',
  'main', 'frontend/src/main.js',
  'state', 'frontend/src/state.js',
  'api', 'frontend/src/api.js',
  'id', 'frontend/src/id.js',
  'keyboardSubmit', 'frontend/src/keyboard-submit.js',
  'login', 'frontend/src/views/LoginPage.vue',
  'picker', 'frontend/src/components/FilePicker.vue',
  'newChat', 'frontend/src/views/NewChat.vue',
  'history', 'frontend/src/views/HistoryPage.vue',
  'detail', 'frontend/src/views/ChatDetail.vue',
  'publicShare', 'frontend/src/views/PublicShare.vue',
  'copyButton', 'frontend/src/components/CopyTextButton.vue',
  'modelAnswer', 'frontend/src/components/ModelAnswer.vue',
  'clipboard', 'frontend/src/clipboard.js',
  'answerFormat', 'frontend/src/answer-format.js',
  'css', 'frontend/src/styles.css',
  'app', 'server/app.js',
  'auth', 'server/auth.js',
  'runtimeConfig', 'server/config.js',
  'db', 'server/db.js',
  'storage', 'server/storage.js',
  'archive', 'server/archive.js',
  'worker', 'server/worker.js',
  'provider', 'server/provider.js',
  'prompts', 'server/prompts.js',
  'cleanup', 'server/cleanup.js',
  'filenames', 'server/filenames.js',
  'readme', 'README.md',
  'audit', 'AUDIT.md',
  'dockerfile', 'Dockerfile',
].reduce((result, item, index, all) => {
  if (index % 2 === 0) result.push([item, read(all[index + 1])]);
  return result;
}, []));

const checks = [
  [sources.runtimeConfig.includes('MIN_MODELS = 1') && sources.runtimeConfig.includes('MAX_MODELS = 10'), '模型数量没有改为 1-10 个范围'],
  [sources.newChat.includes('createClientConversationId') && !sources.newChat.includes('crypto.randomUUID'), '普通 HTTP 下仍直接依赖 crypto.randomUUID'],
  [sources.id.includes('getRandomValues') && sources.id.includes('fallbackBytes'), '缺少 HTTP/旧浏览器可用的客户端 ID 回退'],
  [sources.clipboard.includes("document.execCommand('copy')") && !sources.clipboard.includes('window.prompt') && !sources.clipboard.includes('prompt('), '普通 HTTP 复制仍会弹窗或缺少无弹窗回退'],
  [sources.detail.includes('复制链接') && sources.detail.includes('复制问题') && sources.detail.includes('复制回答'), '私有问题页复制功能不完整'],
  [sources.publicShare.includes('复制问题') && sources.publicShare.includes('复制回答'), '分享页缺少问题或回答复制按钮'],
  [sources.modelAnswer.includes('查看思考过程') && sources.modelAnswer.includes('隐藏思考过程'), '回答组件缺少思考过程展开/隐藏链接'],
  [sources.answerFormat.includes('COMPLETE_THINK') && sources.answerFormat.includes('stripAnswerPrefix'), '缺少多段 think 解析或 Answer/回答 前缀清理'],
  [sources.keyboardSubmit.includes("event.key !== 'Enter'") && sources.keyboardSubmit.includes('event.shiftKey') && sources.keyboardSubmit.includes('event.ctrlKey || event.metaKey') && sources.keyboardSubmit.includes('event.isComposing'), 'Ctrl/Cmd+Enter 提交快捷键规则不完整'],
  [sources.newChat.includes('@keydown="handlePromptKeydown"') && sources.detail.includes('@keydown="handleFollowUpKeydown"'), '首次提问或追问输入框没有绑定快捷提交'],
  [sources.html.includes('viewport-fit=cover'), '缺少手机安全区 viewport 配置'],
  [/type="file"[\s\S]*multiple/.test(sources.picker), '附件选择器没有开启多选'],
  [!sources.picker.includes('accept='), '附件选择器不应限制文件类型'],
  [sources.css.includes('100dvh'), '缺少手机动态视口支持'],
  [sources.css.includes('safe-area-inset-bottom'), '缺少 iPhone 底部安全区支持'],
  [sources.css.includes('@media (max-width: 767px)'), '缺少手机断点'],
  [sources.css.includes('font-size: 16px'), '手机表单字号不足 16px'],
  [sources.css.includes('min-height: 44px'), '主要触控区域未达到约 44px'],
  [sources.css.includes('overflow-wrap: anywhere'), '长文件名或错误文字可能撑破小屏'],

  [sources.main.includes("name: 'login'") && sources.main.includes('ensureAuthenticated'), '首页/提问页没有登录保护'],
  [sources.login.includes('autocomplete="username"') && sources.login.includes('auth-username-sentinel'), 'token 登录表单缺少辅助 username 字段'],
  [sources.main.includes("name: 'share'") && sources.main.includes("meta: { public: true"), '公开分享页没有免登录'],
  [sources.state.includes('localStorage') || sources.api.includes('localStorage'), '登录 token 没有持久化到浏览器'],
  [sources.auth.includes('timingSafeEqual'), '登录 token 没有恒定时间比较'],
  [sources.auth.includes('HttpOnly') && sources.auth.includes('SameSite=Strict'), '登录 Cookie 安全属性不完整'],
  [sources.db.includes('WHERE id=? AND owner_id=?') && sources.db.includes('WHERE owner_id=? ORDER BY created_at DESC'), '不同 token 的历史/详情没有 owner 隔离'],

  [sources.app.includes("app.post('/api/chats/:id/turns'"), '缺少追问接口'],
  [sources.app.includes("app.put('/api/chats/:id/turns/:turnNo'"), '缺少任意轮编辑接口'],
  [sources.db.includes('CREATE TABLE IF NOT EXISTS turns') && sources.db.includes('PRIMARY KEY(chat_id, turn_no)'), 'SQLite 缺少逐轮索引表'],
  [sources.db.includes('deleteTurnsAfter') && sources.db.includes('updateEditedTurn'), '编辑没有截断后续轮次'],
  [sources.detail.includes('submitFollowUp') && sources.detail.includes('followFiles'), '前端追问缺少新附件上传'],
  [sources.detail.includes('submitEdit(turn)') && sources.detail.includes('本轮附件不可编辑'), '前端任意轮编辑或附件锁定缺失'],
  [sources.detail.includes("status: 'uploading'") && sources.newChat.includes('startPendingChat'), '点击提交后没有立即显示 pending 问题'],
  [sources.detail.includes('thinking-dots') && sources.detail.includes('spinner'), 'pending 回答缺少加载动画'],

  [sources.archive.includes("spawn('zip', ['-9', '-r'") && sources.archive.includes("'--', ...names"), '附件没有安全地执行 zip -9 -r'],
  [sources.storage.includes('`${number}.zip`') && sources.storage.includes('attachmentBinPath(chatDir, chatId)'), '外层附件包没有按轮次保存 1.zip、2.zip…'],
  [sources.storage.includes('completed = true') && sources.storage.includes('if (completed)'), '压缩失败时可能丢失原始附件'],
  [sources.worker.includes('compressPendingTurnAttachments') && sources.worker.indexOf('compressPendingTurnAttachments') < sources.worker.indexOf('callProvider'), '模型调用前没有异步压缩附件'],
  [sources.prompts.includes('这是一次用户的追问，内容是') && sources.prompts.includes('之前的提问/回答历史为'), '追问 prompt 格式不符合要求'],
  [sources.prompts.includes('cat x.jpg att.zip > xa.jpg') && sources.provider.includes('cat x.jpg att.zip > xa.jpg'), '附图生成方式说明不一致'],
  [sources.provider.includes("assets', 'a.jpg") && sources.provider.includes('concatenateBinarySources'), 'provider 图片没有使用彩色 a.jpg 载体并拼接 att.zip'],
  [sources.app.includes('/turns/:turnNo/attachments') && sources.app.includes('/api/public/shares/:shareToken/turns/:turnNo/attachments'), '私有或分享用户缺少逐轮附件下载'],
  [sources.publicShare.includes('下载本轮全部附件') && sources.publicShare.includes('下载全部轮次附件'), '分享页面附件下载入口不完整'],
  [sources.app.includes('附件仍在压缩，暂时不能下载'), '压缩完成前没有阻止附件下载'],

  [sources.app.includes('if (adopted && id)') && !sources.app.includes('if (id) await deleteChatFiles(config.chatDir, id)'), '客户端 ID 碰撞可能误删已有对话'],
  [sources.app.includes('edit-backup-') && sources.app.includes('restoreFiles'), '编辑操作缺少文件回滚保护'],
  [sources.storage.includes('rewriteConversationText') && sources.storage.includes('truncateConversationArchive'), '编辑没有永久重写文字并截断附件'],
  [sources.storage.includes("fsp.rm(textBinPath(chatDir, id)") && sources.storage.includes("fsp.rm(attachmentBinPath(chatDir, id)"), '删除/清理没有按对话删除两个永久 bin'],
  [sources.cleanup.includes('3_000_000_000') && sources.cleanup.includes('7 * 24 * 60 * 60 * 1000') && sources.cleanup.includes('24 * 60 * 60 * 1000'), '自动清理阈值不符合 3GB/1天/7天要求'],
  [sources.cleanup.includes('workers.cancelMany') && sources.cleanup.includes('deleteChatFiles'), '自动清理没有取消任务并彻底删除对话文件'],

  [sources.app.includes('randomBytes(32).toString') && sources.app.includes('/api/public/shares/:shareToken'), '分享随机串不足 256 位或缺少公开接口'],
  [sources.app.includes("app.use('/api', auth.requireAuth)"), '私有 API 没有统一要求登录'],
  [sources.app.includes('strictTransportSecurity: false') && sources.app.includes('upgradeInsecureRequests: null'), '应用自身会阻止普通 HTTP 访问'],
  [sources.app.includes('crossOriginOpenerPolicy: false') && sources.app.includes('originAgentCluster: false') && sources.app.includes("removeHeader('Cross-Origin-Opener-Policy')") && sources.app.includes("removeHeader('Origin-Agent-Cluster')"), '普通 HTTP 下仍发送 COOP 或 Origin-Agent-Cluster 头'],
  [sources.app.includes('authenticated: false, user: null') && sources.state.includes('result?.authenticated'), '匿名登录状态检查仍依赖 401'],
  [sources.provider.includes("target.protocol === 'https:' ? https : http"), '后端 provider 不同时支持 HTTP/HTTPS'],
  [sources.app.includes('server.requestTimeout = 0') && sources.provider.includes('timeout: 0'), '长时间等待可能被服务器或 provider 请求超时中止'],
  [sources.worker.includes('resetInterrupted') && sources.worker.includes('listUnfinishedTasks'), '服务重启后没有恢复未完成任务'],
  [sources.provider.includes('formatProviderError') && sources.worker.includes('markFailed') && sources.detail.includes("turn.answer = payload.error || '模型调用失败'"), 'provider 错误原因没有代替回答'],
  [sources.archive.includes('服务器缺少 zip 命令') && sources.dockerfile.includes('zip unzip'), 'zip/unzip 运行依赖没有声明'],
  [sources.readme.includes('只运行一个应用实例'), 'README 缺少单实例约束'],
  [sources.readme.includes('追问') && sources.readme.includes('编辑') && sources.readme.includes('1.zip'), 'README 没有说明多轮及附件格式'],
];
for (const [ok, message] of checks) if (!ok) throw new Error(message);

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

const expectedCarrierHash = '00dc2aa48b9ce3d233aa988a4213026c11a42862c8f4366f1d18c195d358f982';
for (const filename of ['a.jpg', 'x.jpg']) {
  const jpeg = fs.readFileSync(path.join(root, 'server/assets', filename));
  const dimensions = jpegDimensions(jpeg);
  if (!dimensions || dimensions.width !== 10 || dimensions.height !== 10 || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) {
    throw new Error(`server/assets/${filename} 必须是完整的 10x10 JPEG`);
  }
  const hash = createHash('sha256').update(jpeg).digest('hex');
  if (hash !== expectedCarrierHash) throw new Error(`server/assets/${filename} 不是内置彩色载体图`);
}

function collect(directory, matcher, output) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(full, matcher, output);
    else if (matcher.test(entry.name)) output.push(full);
  }
}

const frontendTemplates = [];
collect(path.join(root, 'frontend'), /\.(?:vue|html)$/, frontendTemplates);
for (const file of frontendTemplates) {
  const source = fs.readFileSync(file, 'utf8');
  if (/\sstyle\s*=/.test(source)) throw new Error(`严格 CSP 下禁止内联 style：${path.relative(root, file)}`);
  if (file.endsWith('.vue')) {
    const match = source.match(/<script setup>([\s\S]*?)<\/script>/);
    if (!match) throw new Error(`Vue 文件缺少 <script setup>：${path.relative(root, file)}`);
    const temporary = path.join(os.tmpdir(), `vue-check-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`);
    fs.writeFileSync(temporary, match[1]);
    try { execFileSync(process.execPath, ['--check', temporary], { stdio: 'pipe' }); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
}

const jsFiles = [];
collect(path.join(root, 'server'), /\.(?:js|mjs)$/, jsFiles);
collect(path.join(root, 'scripts'), /\.(?:js|mjs)$/, jsFiles);
collect(path.join(root, 'frontend/src'), /\.js$/, jsFiles);
for (const file of jsFiles) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
execFileSync('sh', ['-n', path.join(root, 'docker-entrypoint.sh')], { stdio: 'pipe' });

const migrated = createDatabase(path.join(root, 'chat'), { legacyOwnerId: config.auth.users[0].id });
migrated.close();
const sqlite = new DatabaseSync(path.join(root, 'chat', 'sqlite.db'));
try {
  const integrity = sqlite.prepare('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') throw new Error(`SQLite integrity_check 失败：${integrity}`);
  const chatColumns = new Set(sqlite.prepare('PRAGMA table_info(chats)').all().map((row) => row.name));
  for (const column of ['owner_id', 'share_enabled', 'share_token', 'turn_count', 'archive_version']) {
    if (!chatColumns.has(column)) throw new Error(`SQLite chats 缺少字段：${column}`);
  }
  const turnColumns = new Set(sqlite.prepare('PRAGMA table_info(turns)').all().map((row) => row.name));
  for (const column of ['chat_id', 'turn_no', 'attachment_ready', 'task_token', 'revision']) {
    if (!turnColumns.has(column)) throw new Error(`SQLite turns 缺少字段：${column}`);
  }
  const chatCount = Number(sqlite.prepare('SELECT COUNT(*) AS count FROM chats').get().count);
  const turnCount = Number(sqlite.prepare('SELECT COUNT(*) AS count FROM turns').get().count);
  if (chatCount !== 0 || turnCount !== 0) throw new Error('交付包中的初始 SQLite 必须为空');
} finally {
  sqlite.close();
}

console.log(`静态检查通过：${required.length} 个关键文件，${jsFiles.length} 个 JavaScript 文件，${frontendTemplates.length} 个前端模板。`);
