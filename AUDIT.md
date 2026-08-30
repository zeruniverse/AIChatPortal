# v6 修复审计

本文件对应用户报告的七项问题，记录实现位置和回归验证。

## 1. 无附件轮次不创建空 ZIP

- 永久文件仅在本轮确有附件时创建：`<conversation-id>.turn-<N>.attachments.bin`。
- provider 请求前临时聚合已有逐轮 ZIP；编号保持原轮次，不补空号。
- 回归场景：三轮中仅第一、三轮有附件，临时外层 ZIP 精确包含 `1.zip`、`3.zip`，磁盘上不存在第二轮附件文件。

## 2. 逐轮附件永久保存与下载

- 每轮附件被 `zip -9 -r` 压缩后原子保存为独立文件。
- 私有和分享下载接口都直接流式发送该轮文件。
- 已删除全部轮次附件下载按钮和 API。
- 外层 `att.zip` 仅供 provider 请求临时使用，请求体发送完毕、调用失败、取消或服务重启时都会清理。
- 删除对话会删除全部逐轮附件；编辑第 N 轮会删除 N+1 及以后所有逐轮附件，保留第 N 轮原附件。

## 3. 追问和编辑可切换模型

- SQLite 在每一轮保存独立 `model_id`。
- 追问表单和编辑表单都显示当前配置的 1–10 个模型。
- 后端逐轮验证模型，provider 请求使用该轮模型。

## 4. 选择即上传与 24 小时暂存清理

- 文件选择后立即创建上传会话并使用 XHR 上传，显示逐文件进度。
- 上传中或失败时禁止提交；后端再次验证所有文件字节数完整。
- 提交后先立即显示 pending 问题；压缩、临时聚合、图片拼接和 provider 调用均由服务器 Worker 异步完成。
- 逐轮 ZIP 写入后立即删除原始上传目录。
- 未提交的 open 上传会话在 24 小时后由启动/定时清理永久删除。

## 5. provider 远程图片

- CSP：`img-src 'self' data: blob: http: https:`。
- Markdown/HTML 图片均经过 DOMPurify 后显示，并限制为响应式宽度。
- 支持普通 JSON content 数组、images 数组，以及 SSE `delta.images` 等常见图片 URL 返回形式。

## 6. 多组 think 与分段前缀

- 每一组 `<think>...</think>` 在原始位置生成独立“查看/隐藏思考过程”。
- 每个非思考回答段都只在本段开头清理可选空白、1–6 个 `#`、`Answer:`/`Answer：`/`回答:`/`回答：`。
- 回答正文中间的同类文字不删除。
- 复制回答时排除所有 think 段，所有非思考段用一个换行连接。
- 未闭合 think 可流式展开，但不会复制到最终回答。

## 7. 编辑 DataCloneError

- 编辑状态仅显式复制 `turnNo`、`question`、`modelId` 等原始值。
- 项目中不再调用 `structuredClone`，不会尝试克隆 Vue Proxy。
- 编辑提交会取消当前/后续后台任务，截断文字和 SQLite 轮次，删除后续附件与上传暂存，再把编辑轮作为新任务提交。

## 额外审计

- 普通 HTTP 下不发送 COOP、COEP、Origin-Agent-Cluster、HSTS；浏览器端不依赖 `crypto.randomUUID()`。
- 多用户 token 的历史、附件、编辑、删除和分享设置均由后端按 `owner_id` 隔离。
- 分享 URL 使用后端 32 字节随机串；公开 API 不暴露内部对话 UUID。
- 全局进行中任务不超过 10；provider 无首 token 超时；浏览器关闭不会中止已提交任务。
- provider 错误替代回答，并对 key、token、Authorization 等敏感信息脱敏。
- 7 天清理和超过 3GB 时清理 24 小时前对话均按完整对话执行。
- 载体 `a.jpg`/`x.jpg` 为相同的 10×10 彩色 JPEG。
- 手机端包含 320px 布局、100dvh、安全区、16px 表单、触控按钮、原生多文件选择和上传进度。

## 本包测试结果

- Node 自动化测试：16/16 通过。
- HTTP 端到端覆盖：登录、CSP、立即上传、逐轮下载、无附件轮次、临时聚合编号、逐轮模型、编辑截断、分享附件、provider 402 错误、普通 JSON 和 SSE 远程图片。
- 旧附件迁移：外层 ZIP 拆分，空编号 ZIP 丢弃。
- JavaScript 与 Vue script 语法检查通过。
- JSON、YAML、CSS 解析检查通过。
- SQLite `integrity_check` 通过。
- 10×10 彩色 JPEG 检查通过。

当前构建环境无法连接 npm registry，因而没有在此环境完成 Vite production build；最终部署包包含完整源码和 Dockerfile，部署机器联网执行 `docker compose up -d --build` 时会安装依赖并构建前端。
