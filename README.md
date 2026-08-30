# OpenAI-compatible 单轮问答 Web App

这是一个可直接用 Docker 部署的单轮问答应用：Node.js + Express 后端，Vue 3 + Vite 前端。应用页面可以通过普通 HTTP 访问，后端可连接 HTTP 或 HTTPS 的 OpenAI-compatible `chat/completions` provider。

所有业务数据都在 `chat/` 目录中，不依赖 MySQL、PostgreSQL、Redis 或其他外部数据库服务。SQLite 仅作为本地索引使用；每个问题始终对应一个文字 bin 和一个附件 bin。

## 功能清单

- `config.json` 中配置恰好 4 个模型。
- `config.json` 中配置多个登录用户，每个用户直接使用一个 token 登录。
- token 登录后写入长期签名 HttpOnly Cookie，同时保存在浏览器 localStorage；关闭浏览器后仍可恢复登录。
- 不同 token 对应不同用户 ID，历史列表、详情、附件、删除和分享操作互相隔离。
- 支持提交时开启公开分享，也可在问题详情页随时开启或关闭。
- 分享地址使用 32 个密码学随机字节生成，即 256 位随机性、43 个 Base64URL 字符。
- 获得分享链接的人无需登录即可查看问题和实时回答，也能下载该问题的全部附件 ZIP。
- 关闭分享或删除问题后，原分享链接立即失效。
- 后端任务独立于浏览器连接；关闭页面不会停止 provider 请求。
- provider 最慢数小时才返回首 token 时，后端仍会继续等待。
- provider 调用失败时，提取并脱敏实际错误原因，直接用错误内容替代回答显示；例如 `insufficient credit`。
- 服务重启后，未完成任务会重新排队并重新调用 provider。
- 全系统最多 10 个上传中、排队中或运行中的任务。
- 自动清理：启动时和每 10 分钟检查一次，始终删除创建超过 7 天的问题；`chat/` 总占用超过 3,000,000,000 字节时，删除创建超过 24 小时的全部问题。
- 不支持追问；每次提交都是一个独立问题。
- 支持任意附件类型和多文件上传。
- 所有附件压缩后的 ZIP 不得超过 `70,000,000` 字节。
- 附件只能整包下载，不提供单文件下载 API。
- 对 provider 的附件提交严格等价于：

```bash
cat a.jpg all_att.zip > xa.jpg
```

- 前端采用移动优先布局，支持小屏幕、刘海安全区、动态视口、多附件选择、逐个删除、上传进度、长文件名换行、代码块和表格横向滚动。

## 数据目录

运行后数据位于：

```text
chat/
├── sqlite.db
├── <chat-id>.text.bin
└── <chat-id>.attachments.bin
```

说明：

- `sqlite.db` 保存问题索引、所属用户 ID、状态和分享状态。
- `<chat-id>.text.bin` 是 JSON Lines，保存问题、回答分片和任务事件。
- `<chat-id>.attachments.bin` 是标准 ZIP 文件，只是使用 `.bin` 扩展名。
- 没有附件的问题也会创建一个合法的空 ZIP，因此每个问题始终有两个 bin。
- SQLite 使用 `DELETE` journal 模式，避免长期保留 `sqlite.db-wal` 和 `sqlite.db-shm`。
- 上传临时文件位于 `chat/.uploads/`，完成、失败或服务重启时会清理。
- 自动清理统计整个 `chat/` 目录的实际文件字节，包括 SQLite、两个 bin 和尚未完成的上传临时文件。

## 配置

复制或修改 `config.json`：

```json
{
  "listen": {
    "host": "0.0.0.0",
    "port": 3000
  },
  "auth": {
    "sessionSecret": "请替换为至少32字符的高强度随机字符串",
    "cookieSecure": false,
    "users": [
      {
        "id": "alice",
        "label": "Alice",
        "token": "请替换为至少16字符且不可猜测的登录token"
      },
      {
        "id": "bob",
        "label": "Bob",
        "token": "另一个不可猜测且不重复的登录token"
      }
    ]
  },
  "provider": {
    "url": "https://provider.example.com/v1/chat/completions",
    "key": "provider-key",
    "extraHeaders": {},
    "systemPrompt": ""
  },
  "models": [
    { "id": "model-1", "label": "模型一", "request": {} },
    { "id": "model-2", "label": "模型二", "request": {} },
    { "id": "model-3", "label": "模型三", "request": {} },
    { "id": "model-4", "label": "模型四", "request": {} }
  ],
  "limits": {
    "maxParallelTasks": 10,
    "maxCompressedAttachmentBytes": 70000000,
    "maxRawUploadBytes": 536870912,
    "maxFiles": 100,
    "maxPromptChars": 100000,
    "maxProviderErrorBytes": 131072,
    "maxAnswerChars": 10000000
  }
}
```

### 登录用户配置

`auth.users` 至少有一个用户。每项包括：

- `id`：稳定的内部用户标识，仅允许字母、数字、点、下划线和连字符；不要随意修改。
- `label`：前端显示名称。
- `token`：用户在登录页输入的秘密 token，至少 16 字符，建议使用 32 字节以上随机值。

可用以下命令生成 token 和 session secret：

```bash
openssl rand -base64 32
openssl rand -base64 48
```

`auth.sessionSecret` 用于签名长期登录会话，至少 32 字符。更换它会使现有登录 Cookie 失效，但浏览器 localStorage 中仍保存有效登录 token 时，页面会自动重新登录。会话还绑定当前配置中的 token 指纹：更换某个用户的 token 会立即使该用户旧 Cookie 失效；旧 localStorage token 也无法重新登录。

`auth.cookieSecure`：

- 普通 HTTP 部署必须设为 `false`。
- 全站 HTTPS 部署可设为 `true`。
- 设为 `true` 后，浏览器不会在 HTTP 连接发送登录 Cookie。

也可使用环境变量 `SESSION_SECRET` 覆盖 `auth.sessionSecret`，使用 `PROVIDER_KEY` 覆盖 provider key。程序会拒绝使用包内公开的 `replace-with-...` 示例 token 或 session secret 启动，避免误把默认凭据部署到公网。

### 旧版本数据迁移

旧包中没有 `owner_id` 的记录在首次启动时会自动归属给 `auth.users` 的第一个用户。迁移后不要随意更改该用户的 `id`，否则旧记录不会出现在新的用户历史中。

## HTTP 部署

应用自身监听普通 HTTP：

先把 `config.json` 中所有 `replace-with-...` 示例值替换掉，再运行：

```bash
mkdir -p chat
docker compose up -d --build
```

浏览器访问：

```text
http://服务器地址:3000
```

后端的 provider URL 可以同时配置为 HTTPS，例如：

```text
https://api.example.com/v1/chat/completions
```

应用已关闭 HSTS 响应和 CSP 的 `upgrade-insecure-requests`，因此不会把普通 HTTP 页面强制升级为 HTTPS。

纯 HTTP 会让同一网络中的中间设备有机会读取登录 token、问题、回答和附件。公网部署仍建议使用 HTTPS 反向代理；必须使用 HTTP 时，应限制在可信内网、VPN 或受控网络。

## 分享行为

提问页有“开启公开分享”复选框。提交成功后页面总是进入私有问题地址：

```text
/chat/<uuid>
```

开启分享后会生成：

```text
/share/<43字符随机串>
```

该链接：

- 不要求登录。
- 可查看问题、模型回答和实时生成状态。
- 有附件时可下载全部附件，下载结果为一个完整附件 ZIP。
- 不提供删除、修改、关闭分享等权限。
- 关闭分享或删除问题后立即返回不可用。

分享随机串具有 256 位随机性，无法通过顺序枚举合理猜测。但它本质上是访问凭证：不要把链接发给不应访问内容的人，也不要在公开论坛或分析系统中泄露完整 URL。

## Provider 错误显示

调用 provider 失败时，错误不会只显示成通用的“生成失败”。后端会优先从 OpenAI-compatible 错误结构中提取：

- `error.message`
- `error.detail`
- `error.error_description`
- `error.type`
- `error.code`

例如 provider 返回：

```json
{
  "error": {
    "message": "insufficient credit",
    "type": "payment_required",
    "code": "insufficient_credit"
  }
}
```

回答区域会直接显示：

```text
provider HTTP 402：insufficient credit（type: payment_required；code: insufficient_credit）
```

适用于非 2xx HTTP 响应、SSE 中的 `error`、普通 JSON 中的 `error`，以及连接、DNS、TLS 等网络错误。即使 provider 已返回了一部分文字后再失败，最终页面也会以错误原因替换不完整回答。错误会写入 `.text.bin` 和 SQLite 状态字段，并在刷新或 SSE 重连后保持一致。

显示前会移除配置中的 provider key、敏感额外 header 值及 provider URL 中的敏感 token。公开分享页同样会显示这条脱敏错误；因此分享链接持有者可能看到 provider 的状态码、错误类型、额度不足等诊断信息，但不会显示已识别的密钥值。

## 自动清理

自动清理在服务启动、以及服务运行期间每 10 分钟执行一次。年龄按问题的 `created_at` 计算：

1. 无论当前占用多少，删除创建时间超过 7×24 小时的所有问题。
2. 每次检查开始时，如果整个 `chat/` 目录实际占用严格大于 `3,000,000,000` 字节，再删除创建时间超过 24 小时的所有问题。

删除范围包括所有登录 token 所属用户，且会同步处理：

- SQLite 索引记录。
- `<chat-id>.text.bin`。
- `<chat-id>.attachments.bin`。
- 正在排队或调用 provider 的旧任务。
- 已开启的公开分享链接和公开附件下载权限。
- 已连接的私有或公开 SSE 页面；页面会收到记录已删除事件。

清理完成后会执行 SQLite `VACUUM` 以回收索引文件空间，并在服务日志中记录删除数量和清理前后的字节数。若 24 小时以内的新问题本身已超过 3GB，程序不会删除这些不足 24 小时的问题，因此目录仍可能暂时高于阈值；下一次检查仍会继续判断。

这里的“3GB”按十进制字节解释，即 `3,000,000,000` 字节，不是 `3 GiB`。

## 长时间 provider 请求

后端使用 Node.js `http`/`https` 客户端直接连接 provider，并设置请求超时为 0。创建任务后，provider 请求由服务器 Worker 继续执行，不依赖浏览器页面或 SSE 连接。

浏览器关闭后：

- 上传已经完成并收到问题 ID：任务继续运行。
- 上传尚未完成：此次提交不会创建任务。
- 重新打开问题 URL：从 `.text.bin` 恢复已有回答，然后继续接收新分片。

服务进程重启会断开原 provider TCP 连接。启动时，原 `running` 任务会恢复为 `queued`，然后从头重新请求 provider；这可能导致 provider 侧重复计费。

## 附件传输格式和兼容性限制

服务器先把所有附件压缩为 ZIP，再把字节流构造成：

```text
[a.jpg 的完整字节][all_att.zip 的完整字节]
```

随后以 `data:image/jpeg;base64,...` 的 OpenAI-compatible `image_url` 形式提交。系统提示会告诉模型该图片由以下方式生成：

```bash
cat a.jpg all_att.zip > xa.jpg
```

重要限制：很多 provider 会解码或重新编码 JPEG，只把像素发送给模型，并丢弃 JPEG EOI 后面的 ZIP 数据。这种 provider 无法读取附件，即使请求格式本身正确。使用前必须确认 provider 能访问原始图片字节及 JPEG 尾随数据。

70,000,000 字节 ZIP 经过 Base64 后约为 93.3 MB，JSON 请求会略大。provider、反向代理、WAF 和出口代理都必须允许至少约 95 MB 的请求体。

## 反向代理注意事项

即使浏览器断开也不会停止后台任务，但反向代理仍应允许大文件上传：

```nginx
client_max_body_size 520m;
proxy_request_buffering off;
proxy_buffering off;
proxy_read_timeout 2h;
```

公开分享和私有问题页面使用 SSE 获取实时结果；禁用响应缓冲能更及时地显示 token。SSE 断开不会影响服务器后台任务。

## 单实例要求

**只运行一个应用实例。**

不要使用以下部署方式：

- PM2 cluster。
- Node cluster。
- 多个 Docker 副本共享同一个 `chat/`。
- 多台服务器同时挂载同一个 SQLite 文件。

Worker 队列在单个 Node 进程内维护。多实例会造成任务重复执行、删除竞争或文件写入冲突。

## 手机和小屏幕支持

已针对 320px 以上宽度设计，重点包括：

- `viewport-fit=cover` 和 `env(safe-area-inset-*)`。
- `100dvh`，适配手机地址栏动态高度。
- 移动端固定顶部栏和底部导航，不遮挡正文或提交按钮。
- 登录框、模型选择、问题输入和分享链接输入使用至少 16px 字号，避免 iOS 聚焦自动放大。
- 主要触控按钮和附件删除按钮至少约 44px。
- 原生多文件选择器，不设置 `accept`，允许系统文件 App 中的任意类型。
- 选中文件可逐个移除或全部清空。
- 长文件名、长问题和 provider 错误会换行，不撑破页面。
- Markdown 代码块和表格可独立横向滚动。
- 分享控制在 390px 以下改成单列，公开附件下载按钮占满宽度。
- 深色模式和减少动画偏好。

移动系统最终允许选择哪些位置和文件，仍受 iOS、Android 和浏览器自身权限限制。

## 本地运行

要求 Node.js 24 或更高版本：

```bash
npm install
npm run build
npm start
```

开发模式：

```bash
npm install
npm run dev
```

运行检查：

```bash
npm run verify
```

## 安全提示

- 首次部署必须替换示例登录 token、`sessionSecret` 和 provider key。
- 不要把真实 `config.json` 提交到公开代码仓库。
- 登录 token 会保存在浏览器 localStorage，以实现长期恢复登录；共享设备上应主动退出并清除站点数据。
- 分享链接等同于只读访问凭证，持有者可以下载附件。
- Markdown 输出经过受限渲染，不允许原始 HTML。
- ZIP 文件名会移除路径穿越和危险字符。
- provider 返回的错误会隐藏配置中的 provider key 和敏感 header；私有页和公开分享页都会显示脱敏后的实际错误原因。分享前应确认可以向链接持有者公开这些诊断信息。
- 本应用没有注册、找回密码、速率限制或公网防爆破服务；公网应在反向代理、防火墙或 VPN 层增加访问控制和限速。
