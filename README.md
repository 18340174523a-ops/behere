# 同样烦闷过的人

一个本地可运行的网页应用。用户写下最近的烦闷心事后，后端先用 OpenAI 兼容接口分析搜索策略，再调用 Tavily 多通道搜索公开人物材料，并只返回可在来源文本中核验的原文摘录和链接。

## 配置

复制 `.env.example` 为 `.env`，填入：

```bash
TAVILY_API_KEY=你的 Tavily key
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=你的 AI key
AI_MODEL=gpt-4.1-mini
PORT=8787
```

`AI_BASE_URL` 支持 OpenAI 兼容接口。不要把真实 key 提交到代码仓库。

DeepSeek 示例：

```bash
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-chat
```

## 运行

```bash
npm install
npm run dev
```

电脑访问 `http://localhost:5173`。手机和电脑在同一网络时，手机访问电脑的局域网 IP 加端口 `5173`。

## Render 部署

这个项目可以作为一个 Render Web Service 部署。Express 后端会同时提供 API 和前端静态页面。

1. 把代码推送到 GitHub 仓库。
2. 打开 Render，选择 New Web Service。
3. 连接 GitHub 仓库。
4. 使用仓库里的 `render.yaml`，或手动填写：

```bash
Build Command: npm install && npm run build
Start Command: npm run start
```

5. 在 Render 的 Environment 中添加：

```bash
NODE_VERSION=22.12.0
NODE_ENV=production
TAVILY_API_KEY=你的 Tavily key
AI_BASE_URL=https://api.deepseek.com
AI_API_KEY=你的 AI key
AI_MODEL=deepseek-chat
```

不要把真实 key 写进代码或提交到 GitHub。部署成功后，Render 会提供一个公开链接，任何人都可以访问。

## 生产本地检查

```bash
npm run build
NODE_ENV=production npm run start
```

启动后访问 `http://localhost:8787` 和 `http://localhost:8787/api/health`。

## 行为边界

- 历史记录只保存在当前浏览器的 `localStorage`。
- 本地历史中的近期人物会传给后端用于降低重复，不会写入服务端数据库。
- 搜索会混合语义查询、知名人物查询和泛化兜底查询；知名人物种子库只做加权，不会限制结果。
- 没有可靠原文材料时不会编造故事或输出 AI 总结。
- 结果只展示短原文摘录，并用中文双引号包裹。
- 应用不做心理诊断；涉及自伤或轻生表达时会展示求助提示。
