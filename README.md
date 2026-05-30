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

## 行为边界

- 历史记录只保存在当前浏览器的 `localStorage`。
- 本地历史中的近期人物会传给后端用于降低重复，不会写入服务端数据库。
- 搜索会混合语义查询、知名人物查询和泛化兜底查询；知名人物种子库只做加权，不会限制结果。
- 没有可靠原文材料时不会编造故事或输出 AI 总结。
- 结果只展示短原文摘录，并用中文双引号包裹。
- 应用不做心理诊断；涉及自伤或轻生表达时会展示求助提示。
