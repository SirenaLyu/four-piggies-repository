# 科大精灵 · 校园 AI 助手（main 分支）

> 本文件是 `main` 分支的说明文档。
>
> `main` 是项目基线：一个面向中国科学技术大学师生的网页版校园问答助手，落地页 + 对话式问答，后端 `/api/chat` 流式返回，可调用「知识库检索」与「联网搜索」两个工具。

## 1. 这是什么

「科大精灵」是一个 Next.js 16（App Router）+ TypeScript 实现的校园 AI 助手网站。用户输入校园相关问题后，系统调用中科大 LLM 代理生成流式回答，并在需要时自动调用：

1. `query_knowledge_base` —— 查询 Dify 知识库（学校政策、办事流程、人员信息、办公地点等文档）。
2. `web_search` —— 通过 Dify 联网搜索工作流（内部走 SearXNG 搜索引擎）检索互联网上的实时信息。

## 2. 功能特性

- **落地页与开场动画**：新拟态（neumorphism）风格落地页、可跳过开场动画、可选 3D 校园开场。
- **流式对话**：基于 AI SDK `streamText` 的流式输出，首字即回。
- **多轮工具调用**：模型按提示词策略自主选择工具，最多 5 步（`stopWhen: stepCountIs(5)`）。
- **知识库检索**：并发检索 8 个 Dify 数据集，去重排序后作为上下文。
- **联网搜索**：知识库未命中时转 Dify 联网工作流，返回真实搜索结果。
- **历史会话**：会话列表与消息保存在浏览器 `localStorage`，可切换、展开、删除。
- **对话导出**：一键把回答导出为 Markdown / Word / PDF / 文本 / 代码文件。
- **主题与外观**：浅色 / 深色 / 跟随系统，多套主题色可选。
- **文件上传**：支持图片与常见文档作为上下文附件。

## 3. 技术栈

| 类别 | 选型 |
| --- | --- |
| 框架 | Next.js 16.2.12（App Router，Turbopack） |
| UI | React 19.2.4 + Tailwind CSS 4 |
| 语言 | TypeScript 5 |
| AI | `ai` ^7.0.41、`@ai-sdk/openai` ^4.0.23、`@ai-sdk/react` ^4.0.44 |
| 内容渲染 | `react-markdown` + `remark-gfm` |
| 导出 | `docx`、`jspdf` |

## 4. 目录结构

```text
four-piggies-repository/
├── app/
│   ├── api/
│   │   ├── chat/route.ts          # 核心对话接口（流式 + 工具调用）
│   │   ├── summarize/route.ts     # 会话标题自动总结
│   │   └── export/route.ts        # 回答导出文件生成
│   ├── components/                # 落地页 / 动画 / Logo / Markdown 渲染
│   ├── lib/
│   │   ├── ai-clients.ts          # 科大 LLM 客户端与模型名
│   │   ├── dify-knowledge.ts      # Dify 知识库检索（多数据集并发）
│   │   ├── export.ts              # 导出文件前端下载
│   │   ├── markdown.ts            # Markdown 工具
│   │   └── parse-llm-json.ts      # LLM JSON 解析
│   ├── layout.tsx / page.tsx / globals.css
├── public/                        # 静态资源
├── .env.local                     # 本地环境变量（已 gitignore）
├── package.json
└── start.bat                      # Windows 一键启动
```

## 5. 环境变量

所有配置在 `.env.local`（已加入 `.gitignore`）。变量如下：

| 变量 | 说明 |
| --- | --- |
| `OPENAI_API_KEY` | 科大 LLM 代理的 API Key |
| `OPENAI_BASE_URL` | 科大 LLM 代理地址，`https://api.llm.ustc.edu.cn/v1` |
| `CHAT_MODEL` | 对话模型，不设时默认 `deepseek-v4-flash-ascend`（可选 `qwen-chat` / `qwen3.6-chat`） |
| `DIFY_BASE_URL` | 自建 Dify 服务地址（结尾不带 `/v1`） |
| `DIFY_KNOWLEDGE_API_KEY` | Dify 知识库 Dataset Key（`dataset-` 开头） |
| `DATASET_IDS` | 8 个知识库数据集 ID，逗号分隔 |
| `DIFY_WORKFLOW_API_KEY` | 联网搜索工作流的 API Key（`app-` 开头） |
| `TAVILY_API_KEY` | 已弃用（联网搜索改为走 Dify），可留可删 |
| `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` | 硅基流动，本分支当前未实际使用 |

## 6. 安装与运行

### 6.1 一键启动（Windows）

Windows 用户**直接双击 `start.bat`** 即可，脚本会自动完成以下步骤：

1. 检查 Node.js 是否已安装（缺失则提示安装 Node.js 20+）。
2. 检查 npm 是否可用。
3. 首次运行时自动执行 `npm install` 安装依赖（已安装则跳过）。
4. 检查 `.env.local` 是否存在；缺失时自动从 `.env.local.example` 复制一份，并提示填写 API Key。
5. 启动开发服务器 `npm run dev`，并在几秒后自动打开浏览器访问 <http://localhost:3000>。

> 若 3000 端口被占用，Next.js 会自动改用 3001，按终端提示访问对应地址即可；按 `Ctrl+C` 停止服务器。

### 6.2 手动启动

```bash
# 1. 安装依赖（首次）
npm install

# 2. 配置 .env.local（可参考 .env.local.example）

# 3. 启动开发服务器
npm run dev
```

访问 <http://localhost:3000>。

## 7. 核心实现

### 7.1 `/api/chat` 流式对话

`app/api/chat/route.ts` 使用 `streamText`：

- 模型：`chatClient.chat(CHAT_MODEL)`（科大 LLM 代理）。
- 工具：`query_knowledge_base`、`web_search`。
- 步数上限：`stopWhen: stepCountIs(5)`。
- 输出：文本流式返回（`createTextStreamResponse`）。

### 7.2 知识库检索

`app/lib/dify-knowledge.ts`：

- 调用 Dify 知识库检索接口 `POST {DIFY_BASE_URL}/v1/datasets/{id}/retrieve`。
- 对 `DATASET_IDS` 里所有数据集 `Promise.allSettled` 并发检索。
- 按内容去重、按相似度分数降序，拼接成带序号的上下文交给模型。
- 单次请求 15 秒超时，单个数据集失败不影响其它。

### 7.3 联网搜索

`web_search` 工具调用 Dify 工作流 `POST {DIFY_BASE_URL}/v1/workflows/run`：

- 传入 `inputs: { query }`，`response_mode: "blocking"`。
- 取 `data.outputs.result` 作为搜索结果返回给模型。
- 工作流内部使用 SearXNG 搜索并整理成 Markdown。

### 7.4 系统提示词

系统提示词描述了工具的适用场景与调用策略：优先查知识库，未命中再联网搜索；并明确要求模型"不要声称自己无法联网搜索"。

## 8. 已知限制

- 知识库能答得多好取决于数据集里是否收录了对应文档。
- 全网搜索容易命中"他校邀请中科大教授"之类内容，模型会诚实说明并给建议。
- 科大 LLM 代理在不同时段的响应延迟波动较大，慢时可切换 `CHAT_MODEL`。

## 9. 分支关系

- `main`（本分支）：项目基线，Dify 知识库 + Dify 联网搜索。
- `知识库构建`：检索升级分支（分类器 + Supabase 结构化数据 + 爬虫建库 + eval），该方案中的 Supabase / Tavily / 爬虫已被视为弃用。
- `agent`：在 `main` 基础上增加「操作指定目录内文件」的智能体能力（详见 `README-agent.md`）。
