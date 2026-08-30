# 后端直接部署（不使用 Docker）

本目录可直接部署到 Linux 服务器。推荐组合：

- Node.js 24 LTS（最低 22.5.0）
- systemd 管理 Node 后端
- Caddy 监听公网 80/443
- Caddy 向 `127.0.0.1:3000` 反向代理 API
- Caddy 通过 Let's Encrypt 自动申请和续期 HTTPS 证书
- 系统安装 `zip`、`unzip`

完整步骤见项目根目录 `README.md`。

关键文件：

- `config.json`：后端全部配置（provider、模型、访问码、CORS 等）
- `server/`：Node 后端
- `chat/`：SQLite 与聊天数据
- `deploy/chat-backend.service`：systemd 模板
- `deploy/Caddyfile`：非 Docker Caddy 模板

后端启动命令本质上只有：

```bash
node server/app.js
```

生产环境请使用 systemd，不建议用 `nohup` 长期运行。
