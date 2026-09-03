# 科大精灵 · 校园 AI 助手（统一版）

> `main` 现为统一主版本，已合并原 `agent` 版本。用户可独立勾选「知识库检索」「联网搜索」「Agent 能力」，决定每轮对话的能力边界。

## 1. 这是什么

「科大精灵」是一个 Next.js 16（App Router）+ TypeScript 实现的校园 AI 助手网站。用户输入校园相关问题后，系统调用 OpenAI 兼容对话 API（默认 DeepSeek）生成流式回答，并在需要时自动调用：

1. `query_knowledge_base` —— 查询 Dify 知识库（学校政策、办事流程、人员信息、办公地点等文档）。
2. `web_search` —— 通过 Dify 联网搜索工作流检索实时公开信息。
3. Agent 文件工具 —— 在服务端允许且用户授权的目录内列出、读取、写入文件或执行白名单程序。

## 2. 功能特性

- **落地页与开场动画**：新拟态（neumorphism）风格落地页、可跳过开场动画、可选 3D 校园开场。
- **流式对话**：基于 AI SDK `streamText` 的流式输出，首字即回。
- **多轮工具调用**：模型按问题时效选择知识库或联网工具，最多 3 步（`stopWhen: stepCountIs(3)`）。
- **能力边界开关**：三项能力可任意组合或全部关闭；关闭的工具不会在服务端注册。
- **受控 Agent**：目录须同时通过客户端授权与服务端根目录校验，写入和命令执行须逐次批准。
- **知识库检索**：并发检索 8 个 Dify 数据集，去重排序后作为上下文。
- **联网搜索**：通过 Dify/SearXNG 检索实时公开信息，执行日期规范化、主题相关度排序、可信来源优先、域名去重和风险内容过滤。
- **历史会话**：会话列表与消息保存在浏览器 `localStorage`，可切换、展开、删除。
- **按需导出**：用户点击后才生成 Markdown / Word / PDF / 文本 / 代码文件，避免每轮额外调用模型。
- **主题与外观**：浅色 / 深色 / 跟随系统，多套主题色可选。
- **文件上传**：支持图片与常见文档作为上下文附件。

## 3. 技术栈

| 类别 | 选型 |
| --- | --- |
| 框架 | Next.js 16.3.3（App Router，Turbopack） |
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
│   │   ├── ai-clients.ts          # OpenAI 兼容客户端与模型名
│   │   ├── dify-knowledge.ts      # Dify 知识库检索（多数据集并发）
│   │   ├── official-search.ts      # 中国政府网政策文件库补充检索
│   │   ├── search-policy.ts        # 联网查询改写、排序、去重与安全过滤
│   │   ├── export.ts              # 导出文件前端下载
│   │   ├── markdown.ts            # Markdown 工具
│   │   └── parse-llm-json.ts      # LLM JSON 解析
│   ├── layout.tsx / page.tsx / globals.css
├── public/                        # 静态资源
├── scripts/
│   ├── build-wokepaike-knowledge.mjs # 生成课程/培养方案/评课检索文档
│   └── sync-wokepaike-dify.mjs       # Dify 增量同步、原位刷新和索引等待
├── .env.local                     # 本地环境变量（已 gitignore）
├── package.json
└── start.bat                      # Windows 一键启动
```

## 5. 环境变量

所有配置在 `.env.local`（已加入 `.gitignore`）。变量如下：

| 变量 | 说明 |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI 兼容对话 API Key |
| `OPENAI_BASE_URL` | 对话 API 地址，默认配置示例为 `https://api.deepseek.com` |
| `CHAT_MODEL` | 对话模型，不设时默认 `deepseek-v4-flash` |
| `CHAT_HISTORY_MESSAGES` | 送入模型的最近消息条数，默认 24、范围 6–50；不影响浏览器保存的完整记录 |
| `CHAT_FALLBACK_MODEL` | 可选备用模型；与主模型不同时才启用网络/超时降级 |
| `DIFY_BASE_URL` | 自建 Dify 服务地址（结尾不带 `/v1`） |
| `DIFY_KNOWLEDGE_API_KEY` | Dify 知识库 Dataset Key（`dataset-` 开头） |
| `DATASET_IDS` | 8 个知识库数据集 ID，逗号分隔 |
| `DIFY_DATASET_ROUTE_MAP` | 可选的数据集主题路由 JSON；使用项目内置 8 个数据集 ID 时可不配置 |
| `DIFY_RETRIEVAL_TOP_K` | 每个知识库候选数，默认 5 |
| `DIFY_MAX_CONTEXT_CHUNKS` | 最终上下文片段上限，默认 12 |
| `DIFY_RERANKING_ENABLED` | 是否启用 reranker，默认 true |
| `DIFY_RERANKING_PROVIDER` / `DIFY_RERANKING_MODEL` | 覆盖默认 bge reranker |
| `DIFY_DATASET_SCORE_THRESHOLDS` | 可选的每数据集最低分数 JSON，用于过滤库内低相关片段 |
| `DIFY_WORKFLOW_API_KEY` | 联网搜索工作流的 API Key（`app-` 开头） |
| `DIFY_SEARCH_BLOCKED_DOMAINS` | 联网结果额外屏蔽的域名，英文逗号分隔 |
| `WOKEPAIKE_DIFY_DATASET_ID` | 蜗壳排课同步脚本的目标知识库；不设时使用内置学校课程库 ID |
| `AGENT_ALLOWED_ROOTS` | Agent 可访问的服务端根目录；浏览器授权只能在这些根目录内生效 |
| `AGENT_ENABLE_COMMAND_EXECUTION` | 是否允许命令执行，默认 `false` |
| `AGENT_ALLOWED_COMMANDS` | 可执行程序绝对路径白名单，多个用英文逗号分隔 |
| `TOOL_APPROVAL_SECRET` | 工具审批签名密钥；生产环境应显式配置长随机值 |
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

### 6.3 同步蜗壳排课数据到 Dify

同步脚本从蜗壳排课项目的 `data/` 目录生成面向检索的课程、培养方案、课程替代关系和评课社区聚合评分文档。生成物和远端快照写入 `generated/`，该目录不会提交到 Git。

```bash
# 生成文档；参数一是蜗壳排课 data 目录，参数二是输出目录（均可省略）
node scripts/build-wokepaike-knowledge.mjs "C:/path/to/wokepaike/data" generated/wokepaike-knowledge

# 只读预检
node scripts/sync-wokepaike-dify.mjs --serial

# 增量上传，并逐份等待索引完成
node scripts/sync-wokepaike-dify.mjs --upload --serial

# 数据变化后原位刷新课程类文档
node scripts/sync-wokepaike-dify.mjs --upload --serial --refresh-category=courses
```

脚本读取 `DIFY_BASE_URL`、`DIFY_KNOWLEDGE_API_KEY` 和可选的 `WOKEPAIKE_DIFY_DATASET_ID`。批量索引采用可恢复的串行模式，避免同时提交大量文档压满 Dify 数据库连接池或嵌入服务。

## 7. 核心实现

### 7.1 `/api/chat` 流式对话

`app/api/chat/route.ts` 使用 `streamText`：

- 模型：`chatClient.chat(CHAT_MODEL)`（OpenAI 兼容接口，默认 `deepseek-v4-flash`）。
- 工具：根据客户端能力开关动态注册知识库、联网搜索和 Agent 文件工具。
- 快速路径：主题明确且非实时的单轮校园问题会先检索知识库，并直接进入回答阶段，省去一次模型工具选择往返；最新通知、天气等实时问题仍走原有工具流程。
- 长对话只向模型发送最近 24 条消息（可配置），减少提示词体积；本地完整会话不受影响。
- 步数上限：普通问答最多 4 步；Agent 模式最多 7 步以容纳多次文件操作，最后一步统一关闭工具并生成最终答案。
- 输出：AI SDK UI message stream，可携带文本、工具调用和审批请求。
- 安全边界：能力开关由服务端再次解析；关闭的工具不进入 `streamText`。

### 7.2 知识库检索

`app/lib/dify-knowledge.ts`：

- 调用 Dify 知识库检索接口 `POST {DIFY_BASE_URL}/v1/datasets/{id}/retrieve`。
- 先按奖助学金、图书馆、通知、班车、校历、课程、政策和校园信息进行数据集路由，只并发检索相关数据集。
- 正确读取 `record.score`，同时兼容 `data.records` 响应结构。
- 若一次查询需要多个主题，由于不同知识库的 reranker 分数不可直接比较，按相关库的库内排名轮转选取并按内容去重。
- 可通过 `DIFY_DATASET_SCORE_THRESHOLDS` 为每个数据集设置独立最低分数；缓存键包含数据集和检索配置，配置变化不会复用旧结果。
- 默认显式使用 `semantic_search + bge-reranker-v2-m3 + top_k=5 + 无统一阈值`。
- 单次请求 15 秒超时，单个数据集失败不影响其它。
- 使用最多 200 项的 TTL/LRU 缓存；失败和空结果不缓存。

### 7.3 联网搜索

`web_search` 工具调用 Dify 工作流 `POST {DIFY_BASE_URL}/v1/workflows/run`：

- 时间敏感查询补充上海时区绝对日期；校园查询展开学校别名，天气查询补充地点、完整字段和本地气象台关键词。
- 每轮最多执行 2 次联网搜索，达到预算后从模型可用工具中移除 `web_search`。
- 传入 `inputs: { query }`，`response_mode: "blocking"`，并对 `data.outputs.result` 做风险内容、低质量域名、提示词注入、主题相关度、日期和地点一致性过滤。
- 校园、天气、政府和教育域名按可信度优先；对同域名设上限并按内容指纹去重，避免单一来源垄断上下文。
- 国务院政策类查询并行补充中国政府网政策文件库；只有有实质证据的结果才进入 2 分钟短缓存。
- 工作流内部使用 SearXNG 搜索并整理成 Markdown。
- 浏览器断开连接时会同步取消模型、Dify Workflow 和知识库请求，避免后台继续消耗资源。

### 7.4 Agent 安全模型

- 客户端目录授权只是申请，服务端再与 `AGENT_ALLOWED_ROOTS` 取交集并解析真实路径。
- 读取与列目录可自动执行；写文件和执行命令需要界面批准。
- 命令执行默认关闭，只允许绝对路径白名单程序，并使用 `spawn(..., shell: false)`。
- Agent 工具调用后的结果不进入回答缓存，避免回放过期文件内容。

### 7.5 系统提示词

系统提示词按本轮开关动态生成，只声明已开启的能力，并要求模型不得声称使用未开启能力。

## 8. 已知限制

- 知识库能答得多好取决于数据集里是否收录了对应文档。
- 全网搜索容易命中"他校邀请中科大教授"之类内容，模型会诚实说明并给建议。
- 对话 API、Dify、搜索引擎和嵌入服务均可能出现限流或延迟波动，应结合日志与监控判断故障位置。
- 联网结果过滤是应用层兜底；仍建议在 Dify/SearXNG 工作流中开启 SafeSearch，并维护搜索引擎侧黑名单。

## 9. 分支关系

- `main`（本目录）：统一主版本，包含检索、联网与受控 Agent 三项可选能力。
- `知识库构建`：检索升级分支（分类器 + Supabase 结构化数据 + 爬虫建库 + eval），该方案中的 Supabase / Tavily / 爬虫已被视为弃用。
- `agent`：保留为合并前的兼容快照；后续开发与启动请使用 `main`。
