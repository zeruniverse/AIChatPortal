# 审计记录

版本：3.1.0

## 需求核对

| 需求 | 结果 | 实现位置 |
|---|---|---|
| Node.js 后端、Vue 前端 | 通过 | `server/`、`frontend/` |
| 恰好 4 个可配置模型 | 通过 | `server/config.js` 强制长度为 4 |
| OpenAI-compatible provider URL/key | 通过 | `config.json`、`server/provider.js` |
| 页面可用 HTTP，provider 可用 HTTPS | 通过 | HTTP Express listener；provider 按 URL 选择 `http`/`https`；禁用 HSTS 和 CSP 强制升级 |
| 首 token 最慢约 2 小时 | 通过 | provider 和 Node server 请求超时关闭 |
| 关闭浏览器后继续请求 | 通过 | Worker 与浏览器连接解耦 |
| 服务重启恢复未完成任务 | 通过 | `resetInterrupted()` 后重新排队 |
| 无外部数据库 | 通过 | 仅使用 `chat/sqlite.db` |
| 每个问题两个 bin | 通过 | `.text.bin` 与 `.attachments.bin`，无附件时创建空 ZIP |
| 任意附件类型 | 通过 | 文件选择器无 `accept`；Busboy 不限制 MIME |
| 压缩后不超过 70,000,000 字节 | 通过 | ZIP 输出流按实际压缩字节硬限制 |
| 附件只能整包下载 | 通过 | 仅存在 ZIP 下载接口 |
| `cat a.jpg all_att.zip > xa.jpg` | 通过 | 字节级流式拼接并有测试 |
| 补充附件生成提示词 | 通过 | `ATTACHMENT_INSTRUCTION` system message |
| 最多 10 个并行任务 | 通过 | 上传占位 + SQLite 事务 + Worker 上限 |
| 不允许追问 | 通过 | 无追加消息 API；前端仅能新建问题 |
| 登录页直接输入 token | 通过 | `/login`、`/api/auth/login` |
| token 后端配置多个用户 | 通过 | `auth.users` |
| 长期保持登录 | 通过 | 长期签名 Cookie + localStorage 自动恢复 |
| 不同 token 历史互不可见 | 通过 | 所有私有查询均含 `owner_id` 条件 |
| 提问时可开启分享 | 通过 | 提问复选框和 multipart `shareEnabled` |
| 提交后进入问题 URL | 通过 | 创建成功路由到 `/chat/<uuid>` |
| 分享链接免登录 | 通过 | `/share/<token>` 与 `/api/public/shares/*` 在认证中间件前 |
| 分享随机串不可猜测 | 通过 | `randomBytes(32)`，256 位随机性 |
| 分享用户可下载附件 | 通过 | `/api/public/shares/:shareToken/attachments` |
| 关闭分享后立即失效 | 通过 | DB 清空 token，公开 GET/SSE/附件每次重新校验 |
| 手机和小屏幕支持 | 通过 | 320px 起、动态视口、安全区、16px 表单、44px 触控、多文件和响应式分享控件 |
| provider 调用失败以错误原因替代回答 | 通过 | HTTP/SSE/JSON/网络错误提取、凭据脱敏、私有及公开页面回答区显示 |
| 自动删除 7 天前问题 | 通过 | 启动时和每 10 分钟按 `created_at` 批量删除索引及两个 bin |
| `chat/` 超过 3GB 时删除 1 天前问题 | 通过 | 每次检查开始时统计目录实际字节，超过 `3,000,000,000` 后清理 24 小时前记录 |

## 权限边界

私有接口统一位于 `app.use('/api', auth.requireAuth)` 之后。公开接口仅包括：

- 健康检查。
- 登录、退出和当前用户验证。
- 根据 43 字符分享 token 读取公开问题。
- 根据分享 token 建立公开 SSE。
- 根据分享 token 下载完整附件 ZIP。

私有问题详情、事件流、附件、分享开关、单条删除、历史列表和删除全部均通过 `owner_id` 限制。未授权访问返回 404，避免确认其他用户记录是否存在。

## 登录实现

- 登录 token 只在 `config.json` 和进程内存中存在。
- token 比较前进行 SHA-256，并使用 `timingSafeEqual`。
- SQLite 不保存原始 token 或 token hash，只保存稳定用户 ID。
- 登录成功签发 HMAC-SHA256 签名 Cookie，会话同时绑定当前 token 指纹；更换 token 会使旧 Cookie 失效。
- Cookie 为 `HttpOnly; SameSite=Strict; Path=/`，最长 10 年；浏览器可能自行缩短上限。
- HTTP 模式下 `cookieSecure=false`；HTTPS 模式可设为 `true`。
- localStorage 保留 token，用于浏览器关闭后或 Cookie 失效时自动恢复。
- 运行时拒绝包内公开的示例 token 和 session secret，必须先改配置。

## 分享实现

- 每次首次开启分享生成 32 随机字节并编码为 43 字符 Base64URL。
- 关闭分享会清空数据库中的分享 token。
- 再次开启会生成新的随机串，旧链接不会复活。
- 公开 SSE 在每次推送前重新校验分享状态；关闭分享时现有公开连接会收到不可用事件并关闭。
- 公开 GET 和 SSE 会返回脱敏后的实际 provider 错误，并在回答区域替代不完整回答。
- 公开附件下载在每次请求时重新校验分享状态和附件存在性。
- `Referrer-Policy: no-referrer` 降低分享 URL 被外链请求泄漏的风险。

## 数据和迁移

SQLite 启动时检查并补充：

- `owner_id`
- `share_enabled`
- `share_token`

旧记录自动归属给配置中的第一个用户。SQLite 使用 `DELETE` journal 模式，避免正常运行时长期产生 WAL/SHM 文件。

## 错误处理审计

- 非 2xx HTTP 错误优先解析 OpenAI-compatible JSON，而不是直接显示整段响应体。
- SSE 和普通 JSON 响应中的 `error.message`、`type`、`code` 会组成可读错误。
- DNS、连接拒绝、TLS 等客户端错误保留错误码和原因。
- Worker 在落盘和广播前调用 provider 凭据脱敏。
- 失败状态的 API 快照直接把脱敏错误作为 `answer`；实时失败事件会让前端清除可能存在的部分回答并显示错误。
- 公开分享沿用相同脱敏结果，分享者应把错误诊断视为分享内容的一部分。

## 自动清理审计

- `StorageCleanup` 在服务器开始监听前运行一次，并通过不保持进程存活的定时器每 10 分钟运行。
- 每次运行先统计 `chat/` 目录总字节，再删除超过 7 天的记录；若检查开始时超过 3,000,000,000 字节，继续删除超过 24 小时的记录。
- 批量删除使用应用提交互斥锁，先取消对应 Worker，再在 SQLite 事务中删除记录，随后删除两个 bin、使分享 token 失效并通知 SSE。
- 清理任务带防重入保护；上一次尚未结束时不会再并行启动另一轮。
- 有记录被删除时执行 SQLite `VACUUM`。单实例限制仍然适用。

## 移动端审计

静态检查覆盖：

- `viewport-fit=cover`
- `100dvh`
- iOS/Android 安全区
- 767px 和 390px 断点
- 16px 表单输入
- 44px 触控目标
- 任意类型、多附件原生选择
- 附件逐项删除和清空
- 上传进度
- 长文件名换行
- Markdown 代码与表格滚动
- 分享控件窄屏单列
- 公开附件下载按钮窄屏全宽
- 深色模式与减少动画

## 自动检查

`npm test` 覆盖：

- 流式 Base64 边界。
- 配置并发硬上限。
- 登录配置、重复 token 和 session secret。
- HTTP 前端与 HTTPS provider 并存。
- 公开示例凭据启动拒绝。
- 登录 token 识别。
- 签名 Cookie 恢复、篡改拒绝和 token 轮换失效。
- 全系统并发占位。
- 重启任务恢复。
- 用户历史、详情和删除全部隔离。
- 分享启用、越权修改拒绝和关闭立即失效。
- ZIP 路径穿越与重名处理。
- JSONL 崩溃尾行恢复。
- 互斥锁异常释放。
- SSE 和普通 JSON provider 响应。
- 回答长度限制。
- JPEG + ZIP 字节级拼接。
- provider 凭据脱敏。
- HTTP 与 SSE 的 `insufficient credit` 等错误原因提取。
- 7 天固定保留清理。
- 3GB 压力下 24 小时保留清理及分享失效。

`npm run check` 还检查关键文件、配置、JavaScript 和 Vue `<script setup>` 语法、移动端标记、认证与分享路由、SQLite 字段和完整性。

## 已知限制

1. `JPEG + ZIP` polyglot 是否能被模型读取取决于 provider 是否保留原始图片字节。
2. 服务重启会重新发送未完成请求，不能恢复原 TCP 连接。
3. 只支持单实例；多个进程不得共享同一个 `chat/`。
4. HTTP 访问不具备传输加密，公网使用有凭据和内容泄漏风险。
5. 分享链接是访问凭证；获得链接的人可以查看内容并下载全部附件。
6. 应用没有用户注册、找回 token、IP 限速或防暴力猜测功能，建议由反向代理补充。


## 本次环境中的实测边界

已实际执行并通过 `npm run check`、27 项 Node 内置测试、CSS 解析、JSON 解析、Shell 语法检查、SQLite `integrity_check` 和最终 ZIP 完整性检查。当前执行环境无法连接 npm registry，且未提供 Docker daemon，因此未在本环境完成依赖安装、Vite 生产构建、Docker 镜像构建和真实浏览器视觉回归；部署机联网后应运行 `npm run verify` 或直接执行 Docker 构建。
