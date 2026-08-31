# Frontend quick start

前端唯一运行配置：`public/config.json`。

```json
{
  "base_url": "https://api.example.com"
}
```

构建：

```bash
npm install --no-audit --no-fund
npm run build
```

静态输出：`dist/`。

Cloudflare Pages 推荐配置：

```text
Root directory: frontend
Build command: npm install --no-audit --no-fund && npm run build
Build output directory: dist
Node: 22
```

完整部署步骤请阅读项目根目录 `README.md`。

## 拖放与粘贴附件

在首次提问或追问页面，可以把一个或多个文件直接拖到问题输入框中，也可以在输入框内粘贴图片。文件加入后会立即走现有附件上传流程；全部上传完成后才允许提交。点击“添加附件”的方式仍然可用。
