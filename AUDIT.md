# v5.3 HTTP 兼容、多轮追问、编辑、快捷提交与回答展示审计记录

## 审计范围

本次审计覆盖原有全部需求和新增需求，并专项复查普通 HTTP 浏览器兼容：HTTP 页面、HTTP/HTTPS provider、1-10 模型配置、token 登录与用户隔离、公开分享与公开附件下载、移动端附件上传、长时间后台任务、10 并发限制、provider 错误替代回答、3GB/1天和7天自动清理、多轮追问、逐轮附件、任意轮编辑和编辑回滚。

## 关键设计结论

| 项目 | 结果 | 实现 |
|---|---|---|
| 普通 HTTP 浏览器兼容 | 通过 | 禁用 COOP/OAC，客户端 UUID 有非安全上下文回退，匿名 `/api/auth/me` 返回 200 |
| 模型数量 | 通过 | `config.json` 支持 1-10 个模型，UI 自动渲染 |
| 一键复制 | 通过 | 分享链接、问题和最终回答均支持；普通 HTTP 无弹窗回退 |
| 思考过程 | 通过 | 多组 `<think>` 独立折叠，最终正文清理 `Answer:`/`回答:` 前缀 |
| 彩色载体图 | 通过 | `a.jpg` 与 `x.jpg` 均为相同的 10×10 彩色 JPEG |
| 每个对话永久两个 bin | 通过 | 一个 `.text.bin`，一个 `.attachments.bin` |
| 多轮附件 | 通过 | 总附件 bin 内部为 `1.zip、2.zip…` |
| 异步最高压缩 | 通过 | Worker 使用系统 `zip -9 -r` |
| 压缩前不可下载 | 通过 | `attachment_ready=0` 时下载返回 409 |
| 追问历史 prompt | 通过 | 当前追问 + 之前全部问答 + 嵌套 ZIP 说明 |
| provider 图片 | 通过 | 运行时使用 10×10 彩色 `a.jpg`；同字节 `x.jpg` 保证既有拼接说明仍然精确 |
| 编辑任意轮 | 通过 | 保留该轮附件，截断该轮回答和所有后续轮 |
| 清理完整性 | 通过 | 对话索引、全部轮次、两个 bin、临时目录、任务和分享一起删除 |
| 公开附件下载 | 通过 | 分享页支持逐轮 ZIP 和总附件 ZIP |
| 小屏幕 | 通过 | 320px 级布局、系统文件选择器、安全区和触控尺寸 |
| 压缩失败后的追问完整性 | 通过 | `attachment_ready=0` 时禁止追加下一轮，避免编号 ZIP 静默缺轮 |
| 删除/编辑竞态 | 通过 | 单条删除、编辑、提交和自动清理共用提交互斥锁 |

## 故障场景

- 浏览器关闭：不取消服务器 Worker。
- SSE 断开：页面重连并使用 attempt ID/sequence 去重。
- 服务重启：`preparing/running` 回到 `queued` 并重新调用 provider。
- 编辑压缩中的轮次：取消压缩时保留该轮 pending 原文件，重新提交不会静默丢附件。
- provider 部分输出后报错：清空不完整回答，显示脱敏错误。
- provider 只发送 `[DONE]` 而没有正文：按空回答失败处理，不误标为完成。
- 上一轮压缩失败：保留原始附件供编辑重试，并阻止继续追问，防止外层 ZIP 缺少该轮。
- 编辑历史轮：SQLite 级联删除后续轮，文字 bin 原子重写，总附件 bin 原子重建。
- 自动清理运行中任务：先取消任务，再删除数据库和全部文件。
- 分享关闭/清理：公开详情、SSE、逐轮附件和总附件下载立即失效。

## HTTP 专项修复


- 普通 HTTP IP 地址访问：响应不再发送 `Cross-Origin-Opener-Policy`、`Origin-Agent-Cluster` 或 HSTS；CSP 仍不包含 `upgrade-insecure-requests`。
- `crypto.randomUUID` 缺失：首次提问仍可立即生成 UUID v4 并进入问题 URL。
- 未登录状态探测：`/api/auth/me` 使用 200 响应表达匿名状态，不再制造预期内的控制台 401。
- token 登录表单：加入隐藏 username 辅助字段，消除 Chromium password form 可访问性提示。
- 普通 HTTP 一键复制：只使用无弹窗复制路径；绝不调用 `window.prompt`。

## 最终验证结果

- Node 核心自动化测试：`50 / 50` 通过；测试总计 51 项。另有 1 项完整 HTTP 端到端联调测试，覆盖登录、首次提问、异步附件、追问、公开分享下载和编辑截断；当前环境没有安装 npm 依赖，因此该项按设计跳过，部署环境执行 `npm install && npm test` 后会自动运行。
- 静态功能与关键文件检查：通过。
- SQLite `integrity_check`：`ok`，交付库中对话和轮次记录均为 0。
- 多轮真实 ZIP 测试：验证每轮内层 ZIP、外层 `1.zip、2.zip…`、逐轮提取和编辑截断。
- Worker 集成测试：验证完整历史 prompt 和彩色 `a.jpg + att.zip` 的实际请求字节，并验证 `x.jpg` 兼容别名字节相同。
- 回答格式测试：验证多组 `<think>`、未闭合流式 `<think>`、最终正文截取及 `Answer:`/`回答:` 前缀清理。
- 最终交付压缩包已从空目录重新解压，并再次执行测试、静态检查、SQLite 检查和 ZIP 完整性检查；验证结果记录在交付说明中。

当前执行环境连接 npm registry 超时，且没有 Docker daemon，因此未在此环境完成 `npm install`、Vite 生产构建和 Docker 镜像构建。Dockerfile 已安装运行所需的 `zip`、`unzip` 和 CA 证书；联网部署环境仍应运行 `docker compose up -d --build` 完成依赖安装和前端构建。

## 已知限制

1. JPEG 尾随 ZIP 依赖 provider 保留原始图片字节；会重新编码图片的 provider 无法读取附件。
2. 70MB ZIP 经 Base64 后约 93.3MB，基础设施需要允许更大的 JSON 请求体。
3. 服务进程重启无法恢复旧 TCP 连接，只能重新发起 provider 请求，可能产生重复计费。
4. 项目按单实例设计，不支持多个进程共享同一个 `chat/` 目录。
5. 普通 HTTP 没有链路加密，公网建议使用 HTTPS 反向代理。

## v5.3 键盘提交与回答前缀规则

- 首次提问和追问输入框支持 `Ctrl+Enter`（Windows/Linux）或 `Cmd+Enter`（macOS）提交。普通 `Enter`、`Shift+Enter` 以及 `Ctrl/Cmd+Shift+Enter` 都只用于输入，不触发提交；输入法组合阶段也不会误提交。
- `Answer:` / `回答:` / `回答：` 仅在整个最终回答开头，或最后一个 `</think>` 后的最终回答开头时删除。正文中间出现的同样字样一律保留。

- 最终回答继续执行 `trimStart()` / `trimEnd()`；若回答开头或最后一个 `</think>` 后先有空白，再出现 `Answer:` / `回答:` / `回答：`，仍会删除该 provider 提示符；正文中间的同名文字不会删除。


## v5.3.2 回答标题前缀兼容

最终回答开头（或最后一个 `</think>` 后）的 `Answer:` / `Answer：` / `回答:` / `回答：`，以及这些前缀前的 1-6 级 Markdown 标题标记（如 `# 回答：`、`## Answer:`），会被移除。正文中间出现相同字样不会被删除。最终正文继续执行 `trimStart()` / `trimEnd()`。
