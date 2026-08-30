# OpenAI-compatible 文件聊天 Web App v6

Node.js 后端、Vue 3 前端、SQLite 索引和文件存储。应用可直接通过普通 HTTP 访问，后端可以调用 HTTP 或 HTTPS 的 OpenAI-compatible `/chat/completions` provider。

## 本版修复重点

- 无附件轮次不再创建空 ZIP。三轮中只有第一、三轮有附件时，临时聚合包只包含 `1.zip` 和 `3.zip`。
- 每轮附件永久保存为独立 ZIP，下载本轮附件时直接发送该文件。
- 已删除“下载全部轮次附件”功能和接口。
- 调用 provider 前临时创建外层 `att.zip`，请求体发送完毕后立即删除；失败或取消时也会删除。
- 追问和编辑均可选择与此前不同的模型。
- 用户选择附件后立即上传；所有文件上传完成前禁止提交。
- 已提交的原始上传文件在本轮 ZIP 生成后立即删除；未提交的上传暂存 24 小时后删除。
- CSP 允许回答中的远程 HTTP/HTTPS 图片。
- 支持任意数量的 `<think>...</think>`，每个思考段按原始位置独立折叠；复制回答只复制所有非思考段，并用换行连接。
- 编辑不再使用 `structuredClone`，避免 Vue Proxy 导致 `DataCloneError`。
- 旧版外层附件包会在首次启动时迁移为逐轮附件；空的编号 ZIP 会被丢弃。

## 部署

### 1. 备份旧数据

升级前必须停止旧容器：

```bash
docker compose down
cp -a chat chat.backup-before-v6
cp config.json config.json.backup-before-v6
```

不要让旧版和新版同时访问同一个 `chat/` 目录。

### 2. 配置

复制示例配置并编辑：

```bash
cp config.example.json config.json
```

至少替换：

- `auth.sessionSecret`
- `auth.users[].token`
- `provider.url`
- `provider.key`
- `models`

示例：

```json
{
  "host": "0.0.0.0",
  "port": 3000,
  "auth": {
    "sessionSecret": "至少32字符的随机会话密钥",
    "cookieName": "chat_session",
    "legacyOwnerId": "user-1",
    "users": [
      { "id": "user-1", "label": "用户一", "token": "足够长的登录token-1" },
      { "id": "user-2", "label": "用户二", "token": "足够长的登录token-2" }
    ]
  },
  "provider": {
    "url": "https://provider.example.com/v1/chat/completions",
    "key": "provider-key",
    "headers": {},
    "extraBody": {}
  },
  "models": [
    { "id": "model-a", "label": "模型 A" },
    { "id": "model-b", "label": "模型 B" }
  ]
}
```

模型数量允许 **1–10 个**。`legacyOwnerId` 决定无法识别所有者的旧历史归属于哪个用户；通常填写第一个用户的稳定 `id`。

### 3. 启动

```bash
mkdir -p chat
docker compose up -d --build
```

访问：

```text
http://服务器IP:3000
```

日志：

```bash
docker compose logs -f
```

健康检查：

```text
http://服务器IP:3000/api/health
```

## 当前存储结构

```text
chat/
├── sqlite.db
├── sqlite.db-wal                 # SQLite 运行时可能存在
├── sqlite.db-shm                 # SQLite 运行时可能存在
├── <conversation-id>.text.bin
├── <conversation-id>.turn-1.attachments.bin
├── <conversation-id>.turn-3.attachments.bin
├── .uploads/                     # 未提交或尚未压缩的原始上传
└── .work/                        # 临时聚合 ZIP，启动时会清空
```

`.attachments.bin` 的内容是标准 ZIP。没有附件的轮次没有对应文件。

SQLite 仅保存用户归属、轮次索引、模型、状态、分享状态和附件元数据；问题和回答正文保存在 `.text.bin`。

## 附件处理流程

1. 用户选择文件后，浏览器立即逐个上传。
2. 所有文件完成前，提交按钮禁用。
3. 点击提交后，服务器立即创建问题和 pending 回答并返回问题 URL。
4. 后台执行等价于 `zip -9 -r` 的逐轮压缩。
5. 逐轮 ZIP 原子写入 `chat/<id>.turn-N.attachments.bin`，此时本轮下载按钮启用。
6. 原始上传目录立即删除。
7. 后台临时复制已有逐轮 ZIP 为 `1.zip、3.zip……`，再生成外层 `att.zip`。
8. 请求字节等价于：

   ```bash
   cat x.jpg att.zip > xa.jpg
   ```

9. provider 已读取完请求体后即可删除临时外层 ZIP，不需要等待首 token；失败、编辑取消任务或删除对话时也会删除。

`maxRawUploadBytesPerTurn` 默认为 `0`（不额外限制原始文件总量）；最终逐轮 ZIP 和临时外层 ZIP 仍必须符合 70MB 限制。每次临时外层 ZIP 的实际大小不得超过 `70,000,000` 字节。载体 `a.jpg`/`x.jpg` 是 10×10 彩色 JPEG。

## 追问和编辑

- 每次追问可以选择新模型并上传新附件。
- 没有新附件时不会生成空的 `N.zip`；此前有附件的轮次仍会发送给 provider。
- 编辑任意一轮时可以修改文字和模型，附件保持只读。
- 提交编辑会保留该轮原附件，删除该轮旧回答，并永久删除之后所有轮次的文字、回答、逐轮附件、上传暂存和后台任务。
- Ctrl+Enter 或 Cmd+Enter 提交首次问题和追问；Enter、Shift+Enter、Ctrl/Cmd+Shift+Enter 不提交。

## `<think>` 展示规则

provider 可返回多组思考过程，例如：

```text
<think>abc</think>## 回答： abcde <think>abc</think>def <think>asd</think> 回答：
```

页面顺序为：

```text
查看思考过程
abcde
查看思考过程
def
查看思考过程
```

每个思考段独立展开或隐藏。复制回答的结果为：

```text
abcde
def
```

每个非思考回答段的开头允许去除：

- `Answer:` / `Answer：`
- `回答:` / `回答：`
- 前面带 1–6 个 Markdown `#` 的同类标题
- 标题前的空白字符

正文中间出现的这些文字不会删除。

## 远程图片

响应头的 CSP 包含：

```text
img-src 'self' data: blob: http: https:
```

因此 Markdown 或 HTML 回答中的远程图片不再被应用自身的 CSP 阻止。HTTPS 页面仍会受到浏览器“禁止 HTTP 混合内容”的规则；本应用直接以 HTTP 部署时不受该限制。

## 登录和分享

- 首页、历史、提问、编辑、私有附件下载都需要 token 登录。
- token 验证后使用长期 HttpOnly Cookie；前端也保留 token 以便 Cookie 失效后自动恢复登录。
- 不同用户 `id` 的历史和附件在后端隔离。
- 分享 URL 使用后端生成的 43 字符随机串。
- 分享访问者无需登录，可以查看问题、回答和下载每轮附件。
- 关闭分享或删除对话后，公开页面、SSE 和附件下载立即失效。
- 公开 API 不返回内部对话 UUID。

## 错误显示

provider 的 HTTP 错误、SSE 错误、普通 JSON 错误、网络错误和空响应会作为该轮回答显示。例如：

```text
provider HTTP 402：insufficient credit；type: payment_required；code: insufficient_credit
```

provider key、登录 token、Authorization 和常见敏感查询参数会在显示前脱敏。

## 自动清理

启动时和每 10 分钟执行：

- 永久删除 7 天前的完整对话。
- 当整个 `chat/` 超过 `3,000,000,000` 字节时，永久删除 24 小时前的完整对话。
- 删除 24 小时未提交的上传暂存。

删除按完整对话执行，包括 SQLite 索引、文字 bin、所有逐轮附件、原始上传、临时工作目录、分享 token、SSE 和后台任务。

## HTTP 兼容

应用不发送以下只适合可信安全来源的响应头：

```text
Cross-Origin-Opener-Policy
Cross-Origin-Embedder-Policy
Origin-Agent-Cluster
Strict-Transport-Security
```

浏览器端不依赖 `crypto.randomUUID()`。普通 IP HTTP 地址可以登录、上传、提交、编辑、分享和复制。

HTTP 不加密 token、问题和附件。公网使用时仍建议在反向代理处启用 HTTPS；必须使用 HTTP 时，应置于可信内网或 VPN。

## 手机和小屏幕

- 最小 320px 布局。
- `100dvh` 和 iPhone 安全区。
- 表单字号至少 16px，避免 iOS 自动放大。
- 原生多文件选择器，选择后立即上传。
- 上传进度、逐个移除、清空附件。
- 主要触控按钮不小于约 44px。
- 长文件名、长错误和分享链接不会撑宽页面。
- Markdown 图片响应式缩放，代码块和表格独立横向滚动。
- 深色模式与减少动画偏好。

## 单实例要求

只允许一个 Node 进程访问同一个 `chat/`：

- 不要使用 PM2 cluster。
- 不要使用 Node cluster。
- 不要启动多个共享同一目录的容器。
- 不要让多台机器共享同一个 SQLite 文件。

## 验证

联网环境：

```bash
npm install
npm run verify
```

后端与核心流程测试不需要第三方后端依赖：

```bash
npm test
```

测试包含 HTTP 登录、立即上传、逐轮压缩与下载、无附件轮次不建 ZIP、临时外层 ZIP 的编号、分享下载、编辑截断、逐轮模型、provider 额度错误、远程图片响应、旧版附件迁移和多段 `<think>` 解析。

## provider 限制

`JPEG + ZIP` 依赖 provider 保留图片的原始上传字节。部分 provider 会重新编码 JPEG，只向模型提供像素，此时 JPEG EOI 后的 ZIP 会丢失。接近 70MB 的 ZIP 转为 Base64 后约 93.3MB，provider、反向代理、CDN 和 WAF 必须允许更大的 JSON 请求体。
