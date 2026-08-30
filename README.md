# OpenAI Compatible Chat v7.0.2 — 前后端分离、后端原生部署版

本版部署结构：

```text
Cloudflare Pages（Vue 静态前端）
        |
        | HTTPS
        v
Caddy（服务器 80/443，Let's Encrypt 自动证书）
        |
        | HTTP，仅服务器本机
        v
Node.js 后端（127.0.0.1:3000）
        |
        v
Model Provider（HTTP 或 HTTPS）
```

后端不需要 Docker，也不需要数据库服务。数据继续存放在 `backend/chat/` 中的 SQLite 和附件文件。

---

## 1. 准备域名

假设：

- 前端：`https://your-project.pages.dev` 或 `https://chat.example.com`
- 后端 API：`https://api.example.com`
- 服务器公网 IP：`203.0.113.10`

请先让 `api.example.com` 的 A/AAAA 记录正确指向后端服务器。

服务器公网必须可以访问：

- TCP 80
- TCP 443

Node 的 3000 端口不需要对公网开放。

---

## 2. 安装系统依赖

以下以 Ubuntu/Debian 为例：

```bash
sudo apt update
sudo apt install -y curl ca-certificates zip unzip xz-utils
```

### 安装 Node.js

要求：Node.js >= 22.5.0；推荐 Node.js 24 LTS。

安装完成后确认：

```bash
node -v
```

如果已经是 22.5.0 或更高，可以直接继续。

生产环境建议使用系统级 Node 安装，使 systemd 可以直接找到 `node`，不要把生产服务依赖在交互式 shell 的 nvm 初始化脚本上。

---

## 3. 安装 Caddy

Ubuntu/Debian 使用 Caddy 官方 apt 仓库：

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

安装后 Caddy 会作为 systemd 服务运行。

检查：

```bash
caddy version
systemctl status caddy
```

---

## 4. 上传后端程序

建议目录：

```text
/opt/chat-backend
```

创建专用系统用户：

```bash
sudo useradd --system --home /opt/chat-backend --shell /usr/sbin/nologin chatapp 2>/dev/null || true
sudo mkdir -p /opt/chat-backend
```

把本包的 `backend/` 内容上传/复制进去，例如：

```bash
sudo cp -a backend/. /opt/chat-backend/
```

然后设置权限：

```bash
sudo chown -R root:chatapp /opt/chat-backend
sudo chown -R chatapp:chatapp /opt/chat-backend/chat
sudo chmod 750 /opt/chat-backend
sudo chmod 640 /opt/chat-backend/config.json
```

确认系统用户可以运行后端：

```bash
sudo -u chatapp /usr/bin/env node /opt/chat-backend/server/app.js
```

看到类似：

```text
Chat backend listening on http://127.0.0.1:3000
```

即可按 `Ctrl+C` 停止测试。

---

## 5. 配置后端 config.json

编辑：

```bash
sudo nano /opt/chat-backend/config.json
```

生产部署建议把：

```json
"host": "127.0.0.1",
"port": 3000
```

这样 Node 只监听服务器本机，不直接暴露 3000 端口。

完整示例：

```json
{
  "host": "127.0.0.1",
  "port": 3000,
  "cors": {
    "allowedOrigins": [
      "https://your-project.pages.dev",
      "https://chat.example.com"
    ]
  },
  "auth": {
    "sessionSecret": "替换为至少32字符的高强度随机值",
    "cookieName": "chat_session",
    "legacyOwnerId": "user-1",
    "users": [
      {
        "id": "user-1",
        "label": "用户一",
        "token": "替换成用户访问码"
      }
    ]
  },
  "provider": {
    "url": "https://provider.example.com/v1/chat/completions",
    "key": "替换成 provider key",
    "headers": {},
    "extraBody": {}
  },
  "models": [
    { "id": "model-a", "label": "模型 A" },
    { "id": "model-b", "label": "模型 B" }
  ],
  "limits": {
    "maxConcurrentTasks": 10,
    "maxCompressedAttachmentBytes": 70000000,
    "maxRawUploadBytesPerTurn": 0,
    "maxFilesPerTurn": 100
  },
  "cleanup": {
    "maxChatBytes": 3000000000,
    "pressureAgeHours": 24,
    "maxAgeDays": 7,
    "orphanUploadHours": 24,
    "intervalMinutes": 10
  }
}
```

生成 sessionSecret：

```bash
openssl rand -hex 32
```

生成访问码也可以用：

```bash
openssl rand -hex 24
```

注意 CORS Origin：

```text
https://your-project.pages.dev
```

不能写成：

```text
https://your-project.pages.dev/
```

末尾不要 `/`，也不要附带路径。

---

## 6. 用 systemd 运行 Node 后端

本包已有模板：

```text
backend/deploy/chat-backend.service
```

安装：

```bash
sudo cp /opt/chat-backend/deploy/chat-backend.service /etc/systemd/system/chat-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now chat-backend
```

检查：

```bash
systemctl status chat-backend
```

实时日志：

```bash
journalctl -u chat-backend -f
```

测试本机后端：

```bash
curl http://127.0.0.1:3000/api/health
```

预期：

```json
{"ok":true,"version":"7.0.2"}
```

以后后端服务器重启，systemd 会自动启动服务；Node 进程意外退出时也会自动重启。

---

## 7. 配置 Caddy HTTPS

不要使用旧 Docker 版的：

```text
reverse_proxy backend:3000
```

原生部署必须改为：

```text
reverse_proxy 127.0.0.1:3000
```

本包 `backend/deploy/Caddyfile` 已经是原生服务器模板。

编辑：

```bash
sudo nano /etc/caddy/Caddyfile
```

例如：

```caddyfile
{
    email admin@example.com
    acme_ca https://acme-v02.api.letsencrypt.org/directory
}

api.example.com {
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
    }

    @api path /api/*
    handle @api {
        reverse_proxy 127.0.0.1:3000
    }

    handle {
        redir https://your-project.pages.dev{uri} 308
    }
}
```

需要修改三处：

1. `admin@example.com` → 证书通知邮箱
2. `api.example.com` → 真实 API 域名
3. `https://your-project.pages.dev` → 真实前端地址

验证 Caddyfile：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
```

无错误后：

```bash
sudo systemctl reload caddy
```

查看日志：

```bash
journalctl -u caddy -f
```

然后测试：

```bash
curl https://api.example.com/api/health
```

---

## 8. Let's Encrypt 自动续期

不需要安装 Certbot，也不需要创建 cron。

Caddy 会自动完成：

```text
申请 Let's Encrypt 证书
→ 保存证书
→ 到期前自动续期
→ 自动加载新证书
```

只要：

- 域名一直解析到该服务器
- 80/443 保持可访问
- Caddy systemd 服务正常运行
- 不删除 Caddy 的数据目录

即可自动维护 HTTPS。

Caddy 官方 apt 包默认的证书/状态数据通常保存在：

```text
/var/lib/caddy/.local/share/caddy
```

不要手工定期删除该目录。

可以检查：

```bash
systemctl status caddy
journalctl -u caddy --since today
```

---

## 9. 防火墙

如果使用 UFW：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

可选 HTTP/3：

```bash
sudo ufw allow 443/udp
```

不要开放：

```text
3000/tcp
```

因为 Node 已监听：

```text
127.0.0.1:3000
```

检查：

```bash
sudo ss -lntp | grep -E ':80|:443|:3000'
```

应看到 Caddy 监听公网 80/443，而 Node 的 3000 只在 127.0.0.1。

---

## 10. 配置 Cloudflare Pages 前端

编辑：

```text
frontend/public/config.json
```

只配置后端地址：

```json
{
  "base_url": "https://api.example.com"
}
```

不要加末尾 `/`。

Cloudflare Pages：

```text
Root directory: frontend
Build command: npm install --no-audit --no-fund && npm run build
Build output directory: dist
```

推荐 Node 24。

部署完成后，把最终 Pages Origin 加进后端：

```json
"cors": {
  "allowedOrigins": [
    "https://真实项目.pages.dev"
  ]
}
```

修改后：

```bash
sudo systemctl restart chat-backend
```

---

## 11. Cloudflare DNS 注意事项

如果 `api.example.com` 也托管在 Cloudflare DNS：

第一次部署最省事的方式是先设为 `DNS only`（灰云），确认：

```bash
curl https://api.example.com/api/health
```

证书和 API 都正常后，再决定是否打开 Cloudflare Proxy。

如果打开代理，建议 Cloudflare SSL/TLS 使用 `Full (strict)`，因为源站 Caddy 已经拥有有效的 Let's Encrypt 证书。

---

## 12. 从旧版迁移数据

先停止旧服务：

```bash
sudo systemctl stop chat-backend
```

如果旧版是 Docker，请先停止旧容器，绝对不要让两个后端同时访问同一个 SQLite/chat 目录。

备份：

```bash
sudo cp -a /opt/chat-backend/chat /opt/chat-backend/chat.backup
```

把旧版整个 `chat/` 数据复制到：

```text
/opt/chat-backend/chat/
```

然后：

```bash
sudo chown -R chatapp:chatapp /opt/chat-backend/chat
sudo systemctl start chat-backend
```

查看启动日志：

```bash
journalctl -u chat-backend -n 100 --no-pager
```

---

## 13. 更新程序

更新前：

```bash
sudo systemctl stop chat-backend
sudo cp -a /opt/chat-backend/chat /opt/chat-backend/chat.backup
sudo cp /opt/chat-backend/config.json /opt/chat-backend/config.json.backup
```

替换：

```text
server/
package.json
```

保留：

```text
config.json
chat/
```

修正权限并启动：

```bash
sudo chown -R root:chatapp /opt/chat-backend/server /opt/chat-backend/package.json
sudo chown -R chatapp:chatapp /opt/chat-backend/chat
sudo systemctl start chat-backend
```

检查：

```bash
systemctl status chat-backend
curl http://127.0.0.1:3000/api/health
curl https://api.example.com/api/health
```

---

## 14. 常用命令

后端状态：

```bash
systemctl status chat-backend
```

后端日志：

```bash
journalctl -u chat-backend -f
```

重启后端：

```bash
sudo systemctl restart chat-backend
```

Caddy 状态：

```bash
systemctl status caddy
```

Caddy 日志：

```bash
journalctl -u caddy -f
```

检查 Caddy 配置：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
```

平滑重新加载 Caddy：

```bash
sudo systemctl reload caddy
```

检查 Node：

```bash
node -v
```

检查本机 API：

```bash
curl http://127.0.0.1:3000/api/health
```

检查公网 HTTPS API：

```bash
curl https://api.example.com/api/health
```

---

## 15. 后端不需要 npm install

当前后端 `package.json` 没有第三方运行时依赖，服务端代码使用 Node.js 内置模块。因此直接部署后端时不需要 `npm install`。

但系统必须提供：

```text
Node.js >= 22.5.0
zip
unzip
```

前端仍然需要 npm，因为 Cloudflare Pages 要执行 Vue/Vite 构建。
