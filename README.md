# OpenAI-compatible 多轮问答 Web App（v5.2）

这是一个可直接部署的 Node.js + Express 后端、Vue 3 + Vite 前端的多轮问答应用。浏览器页面可以使用普通 HTTP，后端可以连接 HTTP 或 HTTPS 的 OpenAI-compatible `chat/completions` provider。

应用不依赖外部数据库服务。所有业务数据都保存在 `chat/` 目录：SQLite 只保存索引和状态；每个对话永久只保留一个文字 bin 和一个附件 bin。

## 主要功能

- `config.json` 中可配置 1-10 个模型；前端模型选择器会自动按配置渲染，不再要求恰好 4 个。
- 可配置多个登录 token；每个 token 对应一个独立用户，不同用户的历史、详情、附件和删除操作互不可见。
- 登录 token 保存在浏览器 localStorage，并由长期签名 HttpOnly Cookie 维持会话；不清除站点数据即可持续使用。
- 点击提交后立即进入 `/chat/<uuid>`，前端立即显示问题和 pending 动画；附件上传被服务器完整接收后，压缩和 provider 调用均由服务器后台继续，关闭浏览器不会中止已保存任务。
- 支持多轮追问，每次追问都可以上传新的任意类型附件。
- 支持编辑任意一次提问；附件不可修改。提交编辑后，该轮旧回答和所有后续轮次的提问、回答、附件都会永久删除，然后从被编辑轮重新生成。
- provider 最慢数小时返回首 token 时仍会持续等待；Node 和 provider 请求超时均关闭。
- 服务重启后，未完成任务会重新排队并从头调用 provider。
- 全系统最多 10 个上传中、排队中、压缩中或调用 provider 的任务。
- provider 调用失败时，脱敏后的实际错误原因直接替代回答，例如 `insufficient credit`。
- 支持公开分享；分享链接由后端生成 43 个 Base64URL 字符的长随机串；它不依赖浏览器安全上下文，因此普通 HTTP 也可创建和访问。
- 分享链接无需登录，可查看全部轮次，并下载每轮附件或全部轮次附件。
- 支持手机和小屏幕：原生多文件选择、上传进度、安全区、动态视口、16px 表单字号、触控尺寸、长文件名换行、代码块和表格横向滚动。
- 分享链接、每轮问题和每轮最终回答都有一键复制按钮；HTTPS 优先使用 Clipboard API，普通 HTTP 自动使用隐藏文本域 + `execCommand('copy')` 的无弹窗回退；失败时只在按钮上提示，不会弹出手工复制窗口。
- provider 回答中的每一组 `<think>...</think>` 会单独显示为“查看思考过程/隐藏思考过程”；最终正文只取最后一个 `</think>` 后的内容，并自动删除开头的 `Answer:` 或 `回答:`。
- 自动清理：始终删除 7 天前的对话；`chat/` 总占用超过 3,000,000,000 字节时，额外删除 24 小时前的对话。

## 数据结构

```text
chat/
├── sqlite.db
├── <conversation-id>.text.bin
└── <conversation-id>.attachments.bin
```

每个对话永久只保留这两个 bin：

- `<conversation-id>.text.bin`：JSON Lines，保存所有轮次的用户问题、回答分片、错误和任务事件。
- `<conversation-id>.attachments.bin`：标准 ZIP，只是扩展名为 `.bin`。它是外层 ZIP，内部按轮保存 `1.zip`、`2.zip`、`3.zip`……。
- 每个编号 ZIP 保存对应轮次上传的全部附件。某轮没有附件时，也会在外层 ZIP 中保留一个合法的空编号 ZIP。
- 没有任何附件的对话仍会创建合法附件 bin，从而保证每个对话始终有两个 bin。
- `sqlite.db` 保存用户归属、对话索引、每轮状态、分享状态和附件压缩状态，不保存登录 token 原文。

压缩过程中可能短暂使用：

```text
chat/.uploads/
chat/.pending/
chat/.work/
chat/.downloads/
```

这些都是临时目录，不是持久对话格式。压缩成功后会清除对应原始上传；如果压缩失败或被编辑操作取消，会暂时保留该轮原始附件，以便同一轮重新提交时不静默丢失。删除对话、自动清理或确认不再需要时会连同这些临时数据一起永久删除。临时目录同样计入 3GB 自动清理阈值。

## 附件处理与 provider 格式

每一轮提交后，后端异步执行等价于：

```bash
zip -9 -r <轮次>.zip <该轮全部附件>
```

然后把所有轮次 ZIP 再打成一个外层 ZIP：

```text
att.zip
├── 1.zip
├── 2.zip
├── 3.zip
└── ...
```

外层 ZIP 的实际大小不得超过：

```text
70,000,000 bytes
```

只有外层 ZIP 原子写入完成后，该轮附件才会变成可下载状态。压缩期间问题已经出现在页面，但附件下载接口返回“仍在压缩”。

向 provider 发送附件时，图片字节严格等价于：

```bash
cat x.jpg att.zip > xa.jpg
```

运行时使用的 `server/assets/a.jpg` 是一张 10×10 彩色 JPEG，不是纯白占位图。项目同时保留字节完全相同的 `server/assets/x.jpg` 别名，因此此前要求的 `cat x.jpg att.zip > xa.jpg` 与实际发送字节完全一致。

后端不会把全部内容一次性读入内存，而是连续流式读取彩色 `a.jpg`（与 `x.jpg` 字节相同）和 `<conversation-id>.attachments.bin` 后进行 Base64 编码。追问 prompt 会包含：

```text
这是一次用户的追问，内容是 {当前追问内容}，如果有附图，附图是一个
cat x.jpg att.zip > xa.jpg 生成的图片，你应该先解压出附件。
附件内部是多个zip，1.zip是用户第一次提问时的附件打包zip，
2.zip是第二次提问时的附件打包zip，以此类推，之前的提问/回答历史为：

第一次提问：
...
第一次回答：
...
第二次提问：
...
```

同时还会增加独立 system message，说明 JPEG 结束标记后包含外层 ZIP，以及无法读取时不得臆测附件内容。

### 兼容性限制

JPEG 尾随 ZIP 是 polyglot 传输方式。很多 provider 会解码或重新编码图片，只把像素交给模型，导致 JPEG 结束标记后的 ZIP 被丢弃。该功能只有在 provider 能访问原始图片字节并读取尾随数据时才可靠。

70,000,000 字节的 ZIP 转为 Base64 后约为 93.3MB，加上 JSON 后还会更大。provider、反向代理、CDN、WAF 和出口代理都必须允许相应请求体大小。

## 多轮追问

当前轮回答完成或 provider 调用失败，并且该轮附件包已经成功形成后，详情页会出现追问输入框。若附件压缩本身失败，为避免后续外层 ZIP 静默缺少该轮，系统会阻止继续追问；此时只能编辑该轮重试或删除整个对话。每次追问：

1. 可以重新选择任意类型、多个附件。
2. 页面先乐观加入新问题并显示上传/压缩/pending 状态。
3. 上传完成后，服务器在后台压缩本轮附件并更新总附件 bin。
4. provider 收到当前追问、之前全部问答历史，以及截至当前轮的外层附件 ZIP。
5. 一个对话同一时间只处理一轮，以确保追问历史包含前一轮最终回答。

## 编辑任意一次提问

每个用户问题旁都有“编辑”按钮。编辑时：

- 原问题会变成预填输入框。
- 原附件不可新增、删除或替换。
- “取消”不会修改任何数据。
- “提交编辑”会取消该轮及后续正在进行的任务。
- 该轮旧回答以及所有后续轮次的提问、回答、SQLite 索引、编号 ZIP 和临时文件都会永久删除。
- 被编辑轮原附件会保留，然后该轮相当于重新提交并重新调用 provider。
- 编辑第一轮时会同步更新历史列表标题。

编辑操作采用对话级互斥和原子附件 ZIP 替换，避免只删 SQLite、未删附件，或只删附件、未删文字的半完成状态。

## 登录与用户隔离

示例配置：

```json
{
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
        "token": "另一个不重复的登录token"
      }
    ]
  }
}
```

- `id` 是稳定内部标识，只允许字母、数字、点、下划线和连字符。
- `token` 至少 16 字符，建议使用 32 字节以上随机值。
- `sessionSecret` 至少 32 字符。
- 程序会拒绝使用包内 `replace-with-...` 示例凭据启动。
- 更换某个用户的 token 会使该用户旧 Cookie 失效。
- 更换 `sessionSecret` 会使全部旧 Cookie 失效。
- 普通 HTTP 部署必须设置 `cookieSecure: false`；全站 HTTPS 才设置为 `true`。

生成随机值：

```bash
openssl rand -base64 32
openssl rand -base64 48
```

纯 HTTP 不提供传输加密。同一网络中的中间设备可能看到登录 token、问题、回答和附件。公网部署建议在反向代理层使用 HTTPS；必须使用 HTTP 时，应限制在可信内网或 VPN。

## 分享

私有页面：

```text
/chat/<uuid>
```

公开页面：

```text
/share/<43字符随机串>
```

分享页面无需登录，可以：

- 查看全部提问和回答。
- 实时查看仍在生成的回答。
- 下载任意已压缩完成轮次的完整附件 ZIP。
- 下载包含全部编号轮次 ZIP 的总附件包。

关闭分享或删除/自动清理整个对话后，公开详情、SSE 和所有附件下载链接立即失效。分享链接本身是访问凭证，请勿泄露给不应访问内容的人。

## Provider 错误显示

后端解析常见 OpenAI-compatible 错误字段：

```text
error.message
error.detail
error.error_description
error.type
error.code
```

例如：

```text
provider HTTP 402：insufficient credit（type: payment_required；code: insufficient_credit）
```

错误会直接作为该轮回答显示，并写入文字 bin 和 SQLite 状态。即使 provider 先返回部分文字后失败，最终也会以错误原因替换不完整回答。provider key、Authorization、敏感额外 header 和 URL 中的 token 会在写入前脱敏。

## 自动清理

自动清理在以下时机运行：

```text
服务启动时
服务运行期间每 10 分钟
```

规则：

1. 无论磁盘占用多少，永久删除创建超过 7×24 小时的所有对话。
2. 若整个 `chat/` 目录在本轮检查开始时严格超过 `3,000,000,000` 字节，再永久删除创建超过 24 小时的所有对话。

清理以整个对话为单位，会一起删除：

- SQLite 中的对话和全部轮次记录。
- 整个文字 bin。
- 整个附件 bin，包含所有 `1.zip、2.zip…`。
- 该对话所有 pending/work/download 临时文件。
- 排队、压缩中和 provider 请求中的任务。
- 分享 token、公开页面和附件下载权限。

有删除发生后会执行 SQLite `VACUUM`。如果不足 24 小时的新对话本身已超过 3GB，程序不会删除这些新对话，所以目录可能暂时仍高于阈值。

## 配置文件

`models` 数组支持 1-10 项。每个模型需要唯一的 `id`，可选 `label` 和 `request` 覆盖项；前端会自动显示全部已配置模型。

完整示例见 `config.example.json`：

```json
{
  "listen": { "host": "0.0.0.0", "port": 3000 },
  "auth": {
    "sessionSecret": "replace-with-a-random-session-secret-at-least-32-characters",
    "cookieSecure": false,
    "users": [
      { "id": "user-1", "label": "用户一", "token": "replace-with-user-1-token-at-least-16-characters" }
    ]
  },
  "provider": {
    "url": "https://api.example.com/v1/chat/completions",
    "key": "replace-with-provider-key",
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

`model.request` 可加入 provider 支持的额外字段，例如 `temperature`、`max_tokens` 等。程序最终会强制设置当前模型 ID、`messages` 和 `stream: true`。


## 从 v4 升级

升级前先停止旧容器，并备份原来的 `config.json` 与整个 `chat/` 目录。然后用本版本源码替换应用代码，继续挂载原来的 `chat/`：

```bash
docker compose down
cp -a chat chat.backup-before-v5
docker compose up -d --build
```

启动时会自动为旧 SQLite 增加多轮 `turns` 索引。旧版每个问题的单层附件 ZIP 会按第一轮附件继续提供下载；首次追问或编辑需要用到附件时，系统会把它升级为外层 `1.zip` 结构。不要让 v4 与 v5 进程同时挂载同一个 `chat/` 目录。

## Docker 部署

先复制并修改配置：

```bash
cp config.example.json config.json
mkdir -p chat
```

替换全部 `replace-with-...` 值，然后运行：

```bash
docker compose up -d --build
```

访问：

```text
http://服务器地址:3000
```

日志：

```bash
docker compose logs -f
```

健康检查：

```text
http://服务器地址:3000/api/health
```

Docker runtime 已安装 `zip` 和 `unzip`。应用页面可以通过 HTTP 访问，provider 可配置为 HTTPS。应用关闭了 HSTS、CSP `upgrade-insecure-requests`、Cross-Origin-Opener-Policy 和 Origin-Agent-Cluster，不会自行升级 HTTP，也不会在普通 IP 地址的 HTTP 页面触发这两类浏览器安全上下文警告。


### 普通 HTTP 浏览器兼容

- 首次提问的临时对话 UUID 不再直接依赖 `crypto.randomUUID()`。HTTPS/localhost 可使用原生实现；普通 HTTP、旧版 WebView 或缺少该函数的浏览器会自动改用 `getRandomValues` 或本地兼容回退，仍生成符合 UUID v4 格式的地址。
- 未登录时 `/api/auth/me` 返回 HTTP 200 和 `{ "authenticated": false, "user": null }`，避免登录页初始化时在控制台出现预期内的 401 错误；真正的私有 API 仍然返回 401。
- token 登录表单包含隐藏的 `username` 辅助字段，避免 Chromium 的 password form 可访问性警告。
- 分享随机串在 Node.js 后端生成，不使用浏览器 Web Crypto，因此与页面是否通过 HTTPS 无关。

## 本地运行

需要 Node.js 24、Info-ZIP `zip` 和 `unzip`：

```bash
npm install
npm run build
npm start
```

完整验证：

```bash
npm run verify
```


## 本包审计结果

当前交付源码已实际完成：

- Node 核心自动化测试 `50 / 50` 通过；测试总计 51 项，其中 1 项完整 HTTP 联调因当前环境缺少 npm 依赖而按设计跳过。
- 完整 HTTP 联调覆盖登录、首问、追问、分享附件下载和编辑截断；它会在安装 npm 依赖后自动启用。
- 静态检查通过：38 个关键文件、24 个 JavaScript 文件、12 个 Vue/HTML 模板。
- CSS 使用解析器检查，0 个语法错误。
- SQLite `integrity_check` 为 `ok`，交付库的对话和轮次记录均为 0。
- 真实 `zip/unzip` 测试验证外层 `1.zip、2.zip…`、逐轮下载、编辑截断和整段对话删除。

当前执行环境没有 Docker 命令，且 `npm install` 因 registry 连接超时未完成，因此没有在此环境声称完成 Vite 生产构建或 Docker 镜像启动。联网部署机执行 `docker compose up -d --build` 时会安装固定版本依赖并构建前端。

## 单实例限制

必须只运行一个应用实例。不要使用：

```text
PM2 cluster
Node cluster
多个同时挂载同一个 chat/ 目录的容器
多台服务器共享同一个 sqlite.db
```

SQLite、对话级任务队列和附件 bin 原子替换按单进程设计。多实例共享目录可能造成重复调用 provider 或附件更新互相覆盖。
