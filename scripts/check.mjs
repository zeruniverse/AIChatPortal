import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'server/app.js',
  'server/auth.js',
  'server/config.js',
  'server/cleanup.js',
  'server/db.js',
  'server/provider.js',
  'server/worker.js',
  'server/filenames.js',
  'server/jsonl.js',
  'server/redact.js',
  'server/mutex.js',
  'server/assets/a.jpg',
  'frontend/index.html',
  'frontend/src/App.vue',
  'frontend/src/api.js',
  'frontend/src/state.js',
  'frontend/src/views/LoginPage.vue',
  'frontend/src/views/NewChat.vue',
  'frontend/src/views/HistoryPage.vue',
  'frontend/src/views/ChatDetail.vue',
  'frontend/src/views/PublicShare.vue',
  'frontend/src/components/FilePicker.vue',
  'frontend/src/styles.css',
  'chat/sqlite.db',
  'config.json',
  'config.example.json',
  'Dockerfile',
  'docker-compose.yml',
  'README.md',
  'AUDIT.md',
];
for (const relative of required) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`缺少文件：${relative}`);
}

const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
if (!Array.isArray(config.models) || config.models.length !== 4) {
  throw new Error('config.json 必须配置 4 个模型');
}
if (!Array.isArray(config.auth?.users) || config.auth.users.length < 1) {
  throw new Error('config.json 必须至少配置一个登录用户');
}
if (new Set(config.auth.users.map((user) => user.id)).size !== config.auth.users.length) {
  throw new Error('config.json 用户 id 重复');
}
if (new Set(config.auth.users.map((user) => user.token)).size !== config.auth.users.length) {
  throw new Error('config.json 用户 token 重复');
}
if (String(config.auth.sessionSecret || '').length < 32) {
  throw new Error('config.json sessionSecret 太短');
}
if (config.limits.maxCompressedAttachmentBytes > 70_000_000) {
  throw new Error('压缩附件上限超过 70,000,000 字节');
}
if (config.limits.maxParallelTasks > 10) {
  throw new Error('并行任务上限超过 10');
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const [name, version] of Object.entries({
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
})) {
  if (/^[~^*]|\bx\b/i.test(version)) throw new Error(`依赖 ${name} 未固定版本：${version}`);
}

const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('frontend/index.html');
const appVue = read('frontend/src/App.vue');
const main = read('frontend/src/main.js');
const api = read('frontend/src/api.js');
const state = read('frontend/src/state.js');
const picker = read('frontend/src/components/FilePicker.vue');
const newChat = read('frontend/src/views/NewChat.vue');
const history = read('frontend/src/views/HistoryPage.vue');
const detail = read('frontend/src/views/ChatDetail.vue');
const publicShare = read('frontend/src/views/PublicShare.vue');
const css = read('frontend/src/styles.css');
const server = read('server/app.js');
const auth = read('server/auth.js');
const runtimeConfig = read('server/config.js');
const db = read('server/db.js');
const cleanup = read('server/cleanup.js');
const provider = read('server/provider.js');
const worker = read('server/worker.js');
const filenames = read('server/filenames.js');
const jsonl = read('server/jsonl.js');
const readme = read('README.md');

const assertions = [
  [html.includes('viewport-fit=cover'), '缺少移动端 viewport-fit=cover'],
  [/type="file"[\s\S]*multiple/.test(picker), '附件选择器必须支持 multiple'],
  [!picker.includes('accept='), '附件选择器不应限制文件类型'],
  [picker.includes('手机可直接打开系统文件选择器'), '附件选择器缺少手机端说明'],
  [css.includes('100dvh'), '缺少动态视口高度支持'],
  [css.includes('safe-area-inset-bottom'), '缺少手机安全区适配'],
  [css.includes('@media (max-width: 767px)'), '缺少移动端断点'],
  [css.includes('font-size: 16px'), '移动端表单字号不足，iOS 可能自动放大'],
  [css.includes('min-height: 44px') || css.includes('width: 44px'), '缺少移动端触控尺寸适配'],
  [css.includes('overflow-wrap: anywhere'), '缺少长文本或长文件名换行保护'],
  [css.includes('focus-visible'), '缺少键盘焦点样式'],
  [main.includes("name: 'login'") && main.includes('ensureAuthenticated'), '首页缺少登录路由保护'],
  [main.includes("name: 'share'") && main.includes("meta: { public: true"), '分享页面未设置为免登录'],
  [state.includes('localStorage') || api.includes('localStorage'), '登录 token 未持久保存在浏览器'],
  [auth.includes('timingSafeEqual'), '登录 token 未使用恒定时间比较'],
  [auth.includes('HttpOnly') && auth.includes('SameSite=Strict'), '登录会话 Cookie 缺少安全属性'],
  [auth.includes('tokenFingerprint'), '登录会话未绑定当前配置 token，轮换 token 后旧会话仍可能有效'],
  [runtimeConfig.includes('looksLikePlaceholder'), '运行时未拒绝公开示例登录凭据'],
  [server.includes("app.use('/api', auth.requireAuth)"), '私有 API 缺少统一登录保护'],
  [db.includes('WHERE id = ? AND owner_id = ?'), '详情访问缺少用户归属隔离'],
  [db.includes('WHERE owner_id=? ORDER BY created_at DESC'), '历史列表缺少用户归属隔离'],
  [server.includes('database.deleteOwnedAll(ownerId)'), '删除全部没有按当前用户隔离'],
  [server.includes('randomBytes(32).toString'), '分享随机串不足 256 位'],
  [server.includes('/api/public/shares/:shareToken/attachments'), '公开分享缺少附件整包下载接口'],
  [server.includes("error: chat.error"), '公开分享未返回脱敏后的 provider 错误原因'],
  [detail.includes("answer.value = payload.error || '模型调用失败'") && publicShare.includes("answer.value = payload.error || '模型调用失败'"), '调用失败时错误原因未替代回答'],
  [detail.includes("'answer-error': chat.status === 'failed'") && publicShare.includes("'answer-error': chat.status === 'failed'"), '失败回答缺少明确错误样式'],
  [publicShare.includes('下载全部附件'), '公开分享前端缺少附件下载入口'],
  [publicShare.includes('verifyShareAccess') && publicShare.includes('checkError.status === 404'), '公开分享断线重连时未重新确认链接是否仍有效'],
  [newChat.includes('shareEnabled'), '提问页缺少开启分享选项'],
  [detail.includes('setSharing') && detail.includes('复制链接'), '问题详情页缺少分享开关或复制链接'],
  [server.includes('strictTransportSecurity: false'), 'HTTP 访问可能被 HSTS 强制升级'],
  [server.includes('upgradeInsecureRequests: null'), 'HTTP 页面资源可能被 CSP 强制升级为 HTTPS'],
  [server.includes('server.requestTimeout = 0'), '服务器请求超时未关闭'],
  [provider.includes('timeout: 0'), 'provider 请求超时未关闭'],
  [provider.includes("target.protocol === 'https:' ? https : http"), 'provider 未同时支持 HTTP/HTTPS'],
  [provider.includes('maxAnswerChars'), 'provider 流式回答缺少长度限制'],
  [provider.includes('formatProviderError') && provider.includes('providerErrorDetail'), 'provider 错误缺少可读原因提取'],
  [worker.includes('this.database.resetInterrupted()'), '缺少重启任务恢复'],
  [provider.includes('cat a.jpg all_att.zip > xa.jpg'), '缺少附件生成说明'],
  [worker.includes('sequence: deltaSequence'), '流式分片缺少去重序号'],
  [server.includes('deltaSequence: text.deltaSequence'), 'SSE 快照缺少分片序号'],
  [server.includes('commitMutex.runExclusive'), '提交与删除全部缺少互斥提交保护'],
  [server.includes('submissionsInProgress'), '上传阶段未计入并发槽位'],
  [server.includes('generationAtStart !== generationFor(ownerId)'), '删除全部未使当前用户的旧上传提交失效'],
  [detail.includes('currentDeltaSequence') && publicShare.includes('currentDeltaSequence'), '前端 SSE 重连缺少分片去重'],
  [history.includes('加载更多'), '历史页缺少分页加载'],
  [filenames.includes("replace(/\\\\/g, '/')"), 'ZIP 文件名未处理 Windows 路径分隔符'],
  [jsonl.includes('ensureTrailingNewline'), '缺少崩溃后 JSONL 尾行修复'],
  [db.includes('PRAGMA journal_mode = DELETE'), 'SQLite 未使用单文件友好的 DELETE journal 模式'],
  [cleanup.includes('3_000_000_000') && cleanup.includes('7 * 24 * 60 * 60 * 1000') && cleanup.includes('24 * 60 * 60 * 1000'), '自动清理阈值或保留期不符合要求'],
  [cleanup.includes('setInterval') && server.includes("cleanup.run('startup')") && server.includes('cleanup.start()'), '自动清理未在启动时和定时执行'],
  [db.includes('listIdsCreatedBefore') && db.includes('deleteInternalIds'), '数据库缺少按时间批量清理能力'],
  [readme.includes('只运行一个应用实例'), 'README 缺少单实例部署限制'],
  [readme.includes('公开分享') && readme.includes('下载全部附件'), 'README 缺少分享附件权限说明'],
];
for (const [ok, message] of assertions) if (!ok) throw new Error(message);

const frontendFiles = [];
function collect(directory, matcher, destination) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(full, matcher, destination);
    else if (matcher.test(entry.name)) destination.push(full);
  }
}
collect(path.join(root, 'frontend'), /\.(?:vue|html)$/, frontendFiles);
for (const file of frontendFiles) {
  const source = fs.readFileSync(file, 'utf8');
  if (/\sstyle\s*=/.test(source)) throw new Error(`严格 CSP 下禁止内联 style：${path.relative(root, file)}`);
  if (file.endsWith('.vue')) {
    const match = source.match(/<script setup>([\s\S]*?)<\/script>/);
    if (!match) throw new Error(`Vue 文件缺少 <script setup>：${path.relative(root, file)}`);
    const temporary = path.join(os.tmpdir(), `vue-check-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`);
    fs.writeFileSync(temporary, match[1]);
    try {
      execFileSync(process.execPath, ['--check', temporary], { stdio: 'pipe' });
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}

const jsFiles = [];
collect(path.join(root, 'server'), /\.(?:js|mjs)$/, jsFiles);
collect(path.join(root, 'scripts'), /\.(?:js|mjs)$/, jsFiles);
collect(path.join(root, 'frontend', 'src'), /\.js$/, jsFiles);
for (const file of jsFiles) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
execFileSync('sh', ['-n', path.join(root, 'docker-entrypoint.sh')], { stdio: 'pipe' });

const sqlitePath = path.join(root, 'chat', 'sqlite.db');
const sqlite = new DatabaseSync(sqlitePath);
try {
  const integrity = sqlite.prepare('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') throw new Error(`SQLite integrity_check 失败：${integrity}`);
  const columns = new Set(sqlite.prepare('PRAGMA table_info(chats)').all().map((row) => row.name));
  for (const column of ['owner_id', 'share_enabled', 'share_token']) {
    if (!columns.has(column)) throw new Error(`SQLite 缺少迁移字段：${column}`);
  }
} finally {
  sqlite.close();
}

console.log(`静态检查通过：${required.length} 个关键文件，${jsFiles.length} 个 JavaScript 文件，${frontendFiles.length} 个前端模板。`);
