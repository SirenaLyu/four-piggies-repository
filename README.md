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
- **本地多用户登录**：用户名和密码经 scrypt 哈希后保存在服务端；会话使用签名的 HttpOnly Cookie。
- **个人模型配置**：每位用户可填写自己的 OpenAI 兼容 API URL、Key、主模型和备用模型；Key 采用 AES-256-GCM 加密保存且不回传浏览器。
- **多轮工具调用**：模型按问题时效选择知识库或联网工具，最多 3 步（`stopWhen: stepCountIs(3)`）。
- **能力边界开关**：三项能力可任意组合或全部关闭；关闭的工具不会在服务端注册。
- **受控 Agent**：目录须同时通过客户端授权与服务端根目录校验，写入和命令执行须逐次批准。
- **知识库检索**：并发检索 8 个 Dify 数据集，去重排序后作为上下文。
- **联网搜索**：通过 Dify/SearXNG 检索实时公开信息，执行日期规范化、主题相关度排序、可信来源优先、域名去重和风险内容过滤。
- **历史会话**：会话列表与消息保存在浏览器 `localStorage`；附件只保留文件名等元信息，不保存 Base64 正文。
- **按需导出**：用户点击后才生成 Markdown / Word / PDF / 文本 / 代码文件；中文 PDF 使用浏览器本地字体绘制，避免默认字体缺字。
- **主题与外观**：浅色 / 深色 / 跟随系统，多套主题色可选。
- **文件上传**：支持图片、文本及 DOCX/XLSX/PPTX；Office Open XML 文件在浏览器内受限解压为纯文本后再发送，原始二进制不进入会话历史。

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
│   ├── components/                # 落地页、设置及拆分后的聊天界面组件
│   ├── lib/
│   │   ├── ai-clients.ts          # OpenAI 兼容客户端与模型名
│   │   ├── chat-messages.ts        # 消息与附件规范化
│   │   ├── chat-system-prompt.ts   # 按能力构建系统提示词
│   │   ├── conversation-storage.ts # 容量安全的本地会话持久化
│   │   ├── dify-knowledge.ts      # Dify 知识库检索（多数据集并发）
│   │   ├── official-search.ts      # 中国政府网政策文件库补充检索
│   │   ├── search-policy.ts        # 联网查询改写、排序、去重与安全过滤
│   │   ├── web-search-tool.ts       # 联网工具、缓存、超时与熔断
│   │   ├── telemetry.ts             # 结构化请求日志与请求 ID
│   │   ├── export.ts              # 导出文件前端下载
│   │   ├── markdown.ts            # Markdown 工具
│   │   └── parse-llm-json.ts      # LLM JSON 解析
│   ├── layout.tsx / page.tsx / globals.css
├── public/                        # 静态资源
├── scripts/
│   ├── build-wokepaike-knowledge.mjs # 生成课程/培养方案/评课检索文档
│   ├── sync-wokepaike-dify.mjs       # Dify 增量同步、原位刷新和索引等待
│   └── sync-ustc-faculty-dify.mjs    # 科大官网教师资料采集、分片和安全同步
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
| `AUTH_ALLOW_REGISTRATION` | 是否允许首位用户之后继续自助注册；默认 false |
| `AUTH_SESSION_SECRET` / `AUTH_ENCRYPTION_KEY` | 会话签名与个人 API Key 加密密钥；生产或多实例部署必须固定配置 |
| `AUTH_DATA_DIR` | 用户与加密模型配置目录，默认 `data/auth` |
| `AUTH_COOKIE_SECURE` | 可选覆盖 Cookie 的 HTTPS 判断；HTTPS 部署建议设 true |
| `MODEL_BASE_URL_ALLOWLIST` | 允许使用的内网或 HTTP 模型 API Origin；默认个人 URL 只能是公网 HTTPS |
| `APP_ALLOWED_ORIGINS` | 反向代理或跨域前端可信来源；同源访问无需配置 |
| `TRUST_PROXY_HEADERS` | 仅在可信代理会覆盖 `X-Forwarded-*` 时设为 true；默认忽略客户端可伪造的代理头 |
| `API_RATE_LIMIT_*` | chat/export/summarize 的固定窗口限流配置 |
| `DIFY_BASE_URL` | 自建 Dify 服务地址（结尾不带 `/v1`） |
| `DIFY_KNOWLEDGE_API_KEY` | Dify 知识库 Dataset Key（`dataset-` 开头） |
| `DATASET_IDS` | 8 个知识库数据集 ID，逗号分隔 |
| `DIFY_DATASET_ROUTE_MAP` | 可选的数据集主题路由 JSON；使用项目内置 8 个数据集 ID 时可不配置 |
| `DIFY_RETRIEVAL_TOP_K` | 每个知识库候选数，默认 5 |
| `DIFY_RETRIEVAL_SEARCH_METHOD` | 可选强制检索方式；默认按查询动态选择 semantic 或 hybrid |
| `DIFY_MAX_CONTEXT_CHUNKS` | 最终上下文片段上限，默认 12 |
| `DIFY_RERANKING_ENABLED` | 是否启用 reranker，默认 true |
| `DIFY_RERANKING_PROVIDER` / `DIFY_RERANKING_MODEL` | 覆盖默认 bge reranker |
| `DIFY_DATASET_SCORE_THRESHOLDS` | 可选的每数据集最低分数 JSON，用于过滤库内低相关片段 |
| `DIFY_WORKFLOW_API_KEY` | 联网搜索工作流的 API Key（`app-` 开头） |
| `DIFY_SEARCH_BLOCKED_DOMAINS` | 联网结果额外屏蔽的域名，英文逗号分隔 |
| `WOKEPAIKE_DIFY_DATASET_ID` | 蜗壳排课同步脚本的目标知识库；不设时使用内置学校课程库 ID |
| `AGENT_ALLOWED_ROOTS` | Agent 可访问的服务端根目录；必须显式配置，缺省时 Agent 不允许访问任何目录 |
| `AGENT_USER_ROOTS_JSON` | 多用户根目录映射，键可为用户名、用户 ID 或 `*`；用户授权不能越过该范围 |
| `AGENT_ALLOW_SHARED_ROOTS` | 是否允许多用户共同使用全局根目录；默认 false |
| `AGENT_REQUIRE_READ_APPROVAL` | 读取文件和搜索文件内容是否逐次审批；默认 true |
| `AGENT_ENABLE_COMMAND_EXECUTION` | 是否允许命令执行，默认 `false` |
| `AGENT_COMMAND_RULES_JSON` | 推荐的命令规则，必须同时匹配可执行程序和参数前缀 |
| `AGENT_ALLOWED_COMMANDS` | 旧版程序白名单；现在只允许无参数或版本/帮助查询 |
| `AGENT_COMMAND_ENV_ALLOWLIST` | 允许额外传给子进程的环境变量名；默认不会传递应用密钥 |
| `AGENT_MAX_CONCURRENT_COMMANDS_PER_USER` | 单个用户的并发命令上限，默认 1，最大 4 |
| `TOOL_APPROVAL_SECRET` | 可选工具审批签名密钥；不设时从持久化认证密钥派生 |
| `TAVILY_API_KEY` | 已弃用（联网搜索改为走 Dify），可留可删 |
| `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` | 硅基流动，本分支当前未实际使用 |

## 6. 安装与运行

### 6.1 一键启动（Windows）

Windows 用户**直接双击 `start.bat`** 即可，脚本会自动完成以下步骤：

> 若仓库位于外层兼容目录 `main/.codex-github-sync`，外层 `start.bat` 会自动转发到这个 Git 工作区；运行、测试和提交均以 `.codex-github-sync` 为唯一可信源码。

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

# 数据变化后原位刷新课程与评课聚合文档
node scripts/sync-wokepaike-dify.mjs --upload --serial --refresh-category=courses,reviews
```

脚本读取 `DIFY_BASE_URL`、`DIFY_KNOWLEDGE_API_KEY` 和可选的 `WOKEPAIKE_DIFY_DATASET_ID`。批量索引采用可恢复的串行模式，避免同时提交大量文档压满 Dify 数据库连接池或嵌入服务。每次真实上传都会在 `generated/wokepaike-knowledge/runs/<run-id>/` 保存当次 manifest、待上传文档、远端更新前后快照、上传结果与最终摘要；`latest-run.json` 指向最近一次运行。运行快照保持与同步目录相同的文件布局，需要回滚时可先对该目录执行只读预检，再通过 `--dir=<run-directory> --upload --serial --refresh-category=<categories>` 重放旧版本。

### 6.4 同步中国科大官网教师资料到 Dify

教师同步脚本以中国科学技术大学教师个人主页为唯一主数据源，读取全校公开目录中的姓名、学院/机构、单位、职称和导师资格，再访问教师本人维护的主页补充研究方向、学历、学位、成果栏目与主页更新时间。默认对主页访问量较高的 200 位教师进一步提取论文、专利、著作、科研项目和获奖栏目的首屏代表条目；其余教师保留成果栏目的官方链接。未填写字段会明确标注为未公开，不从第三方来源推断。

```bash
# 只抓取并生成分学院 Markdown、教师 JSON 和 manifest，不修改 Dify
npm run sync:ustc-faculty

# 增量补充到现有“信息查询/校园信息”知识库，并逐份等待索引完成
npm run sync:ustc-faculty -- --upload

# 网络中断后先重读远端清单，只续传缺失文档（不重新访问官网）
npm run sync:ustc-faculty -- --upload --reuse-generated

# 嵌入服务临时超时后，只重试 Dify 标记为 error/paused 的文档
npm run sync:ustc-faculty -- --upload --reuse-generated --retry-failed

# 官网资料变化后，原位刷新脚本管理的教师文档
npm run sync:ustc-faculty -- --upload --refresh

# 调整成果扩展覆盖人数和官网并发数（并发上限为 8）
npm run sync:ustc-faculty -- --achievement-limit 300 --concurrency 4
```

`--refresh` 会把本轮已成功刷新的文档名写入 `refresh-progress.json`。因此刷新中断后可搭配 `--reuse-generated --retry-failed` 重跑：脚本会跳过同一份 manifest 中已经刷新成功的分片，只续传其余分片并恢复失败项。单个文档索引失败不会阻止后续分片继续处理。

所有生成物、官网缓存、同步前后快照与失败清单均写入 `generated/ustc-faculty/`，不会提交到 Git。同步只管理 `ustc-faculty-` 前缀的文档，不会删除或覆盖知识库中的校园地点、教务秘书等既有资料。默认目标为项目内置校园信息数据集；如部署使用其他数据集，可通过 `USTC_FACULTY_DIFY_DATASET_ID` 覆盖。教师与导师类查询会同时考虑教师资料路由；同时出现课程意图时，课程库和教师资料库会一起检索。

### 6.5 同步中国科大图书馆借阅规则到 Dify

仓库内的 `knowledge/ustc-library-borrowing-rules.md` 按中国科大图书馆“读者指南”整理借期、册数、续借次数、续借窗口和超期限制，并保留官网原始页面与发布日期。同步脚本默认只读预检；真实写入前后会把远端文档清单保存到 `generated/ustc-library-sync/`。

```bash
# 只读检查目标数据集和 create/update 计划
npm run sync:ustc-library

# 新增或原位更新规则文档，并等待索引完成
npm run sync:ustc-library -- --upload
```

默认目标为项目内置图书馆数据集，可通过 `USTC_LIBRARY_DIFY_DATASET_ID` 覆盖。脚本只新增或更新 `ustc-library-borrowing-rules.md`，不会删除既有开放时间文档。

## 7. 核心实现

### 7.0 登录与个人模型配置

- 首次启动时，第一位用户可创建初始账号；之后只有 `AUTH_ALLOW_REGISTRATION=true` 时才开放自助注册。
- 密码使用随机盐和 scrypt 哈希，服务端从不保存明文密码；登录态放在签名、HttpOnly、SameSite=Lax Cookie 中。
- 个人 API Key 只提交给本站服务端，以 AES-256-GCM 加密写入 `AUTH_DATA_DIR`；读取设置时只返回是否已配置，不返回 Key。
- 三个模型入口（聊天、标题总结、导出）都在各自 Route Handler 内重新校验会话，并使用当前用户的模型配置；没有个人配置时回退到服务器 `.env.local` 默认值。
- 用户自定义 Base URL 默认必须是公网 HTTPS，调用前还会校验 DNS 解析结果并拒绝重定向，降低 SSRF 风险。可信内网网关需由管理员加入 `MODEL_BASE_URL_ALLOWLIST`。
- 当前文件存储适合本地或单实例自托管；多实例部署应把认证存储替换为共享数据库，并固定配置两项认证密钥。

### 7.1 `/api/chat` 流式对话

`app/api/chat/route.ts` 使用 `streamText`：

- 模型：`chatClient.chat(CHAT_MODEL)`（OpenAI 兼容接口，默认 `deepseek-v4-flash`）。
- 工具：根据客户端能力开关和当前问题意图动态注册知识库、联网搜索和 Agent 文件工具；长期打开 Agent 不会拖慢普通校园问答。
- 快速路径：主题明确且非实时的单轮校园问题会先检索知识库，并直接进入回答阶段，省去一次模型工具选择往返；最新通知、天气等实时问题仍走原有工具流程。
- 长对话只向模型发送最近 24 条消息（可配置），减少提示词体积；本地完整会话不受影响。
- 步数上限：普通问答最多 4 步；Agent 只读任务最多 6 步，修改/执行任务最多 8 步；每种工具另有独立调用预算，最后一步统一关闭工具并生成最终答案。
- 输出：AI SDK UI message stream，可携带文本、工具调用和审批请求。
- 安全边界：能力开关由服务端再次解析；关闭的工具不进入 `streamText`。

### 7.2 知识库检索

`app/lib/dify-knowledge.ts`：

- 调用 Dify 知识库检索接口 `POST {DIFY_BASE_URL}/v1/datasets/{id}/retrieve`。
- 先按奖助学金、图书馆、通知、班车、校历、课程、政策和校园信息进行数据集路由，只并发检索相关数据集。
- 教师姓名、职称、研究方向和成果类问题路由到校园信息库，并使用 hybrid + top_k 10 提升中文姓名与成果标题的精确召回；同时包含课程意图时也会并行检索课程库。
- 对“姓名 + 老师/教授/研究方向/成果”等明确人物问法，教师资料库会用提取出的姓名做精确检索，避免中文长查询分词稀释姓名；按研究主题泛化找老师时仍保留完整语义查询。
- 对“某老师教什么课、学分/时间地点是什么”等复合问法，先从评课卡片提取课程代码，再在同一课程库内执行第二跳检索，并优先保留同时满足教师名和所求字段的结构化开课记录。
- 正确读取 `record.score`，同时兼容 `data.records` 响应结构。
- 若一次查询需要多个主题，由于不同知识库的 reranker 分数不可直接比较，按相关库的库内排名轮转选取并按内容去重。
- 可通过 `DIFY_DATASET_SCORE_THRESHOLDS` 为每个数据集设置独立最低分数；缓存键包含数据集和检索配置，配置变化不会复用旧结果。
- 普通问题使用 `semantic_search + bge-reranker-v2-m3 + top_k=5`；含精确课程号时自动使用 `hybrid_search + top_k=10`。
- 单次请求 15 秒超时，单个数据集失败不影响其它。
- 使用最多 200 项的 TTL/LRU 缓存；失败和空结果不缓存。

### 7.3 检索评测

```bash
# 离线路由回归，不需要 API Key
npm run eval:retrieval

# 对已配置的 Dify 发起真实召回验证
npm run eval:retrieval:live

# 62 条校园问题的离线路由、语料结构与覆盖面回归（已纳入 npm run check）
npm run eval:e2e

# 对带人工事实断言的案例执行真实 Dify 召回，输出 Hit@K、MRR 和 P50/P95
npm run eval:e2e:live

# 将真实召回指标作为质量门禁；低于 evals/campus-e2e-cases.json 阈值时失败
npm run eval:e2e:gate

# 对正在运行的生产应用执行 /api/chat 最终回答评测
$env:E2E_BASE_URL="http://127.0.0.1:3200"
$env:E2E_USERNAME="专用评测账号"
$env:E2E_PASSWORD="评测账号密码"
npm run eval:e2e:answer

# 自行构建并启动隔离的临时生产实例，创建临时账号后跑同一最终回答评测
npm run eval:e2e:answer:local

# 在 npm run build 后启动生产服务并验证页面、同源防护和请求 ID
npm run test:smoke
```

轻量兼容样例位于 `evals/retrieval-cases.json`；完整语料位于
`evals/campus-e2e-cases.json`。完整语料覆盖教师、课程、校园信息、图书馆、
奖助学金、班车、校历、政策、通知、多领域和模糊回退场景。每条真实事实断言
必须记录来源，脚本会分别统计路由准确率、事实级 Hit@K、MRR、答案准确率、
来源说明率及延迟分位数。`--category=<类别>`、`--case=<ID>` 和 `--limit=<数量>`
可用于定向回归，`--out=<路径>` 可保存完整 JSON 报告。CI 执行离线路由与语料
校验；Dify 召回和最终回答只在有凭据的受控环境运行，避免把账号或密钥写入仓库。
排查生成失败时可额外传入 `--include-answer-text`，将模型答案写进本次报告；该开关默认关闭，含真实用户内容的评测不得启用或提交报告。

### 7.4 联网搜索

`web_search` 工具调用 Dify 工作流 `POST {DIFY_BASE_URL}/v1/workflows/run`：

- 时间敏感查询补充上海时区绝对日期；校园查询展开学校别名，天气查询补充地点、完整字段和本地气象台关键词。
- 每轮最多执行 2 次联网搜索，达到预算后从模型可用工具中移除 `web_search`。
- 传入 `inputs: { query }`，`response_mode: "blocking"`，并对 `data.outputs.result` 做风险内容、低质量域名、提示词注入、主题相关度、日期和地点一致性过滤。
- 校园、天气、政府和教育域名按可信度优先；对同域名设上限并按内容指纹去重，避免单一来源垄断上下文。
- 国务院政策类查询并行补充中国政府网政策文件库；只有有实质证据的结果才进入 2 分钟短缓存。
- 工作流内部使用 SearXNG 搜索并整理成 Markdown。
- 浏览器断开连接时会同步取消模型、Dify Workflow 和知识库请求，避免后台继续消耗资源。

### 7.5 Agent 安全模型

- 授权目录按登录账号保存在服务端，聊天请求不接受浏览器自报目录；每次使用时仍会重新校验管理员根目录策略和真实路径。
- 单用户本地部署可继承 `AGENT_ALLOWED_ROOTS`；多用户部署默认拒绝共享根目录，需用 `AGENT_USER_ROOTS_JSON` 分配账号范围。
- `.env*`、包管理器凭据、云平台凭据、私钥、`.git`、`.ssh` 和认证数据始终拒绝访问；文本内容中的常见 Token 和密钥还会二次遮蔽。
- `list_dir` 和 `find_files` 只返回元数据；`read_file` 与 `search_text` 默认逐次确认，因为结果会发送到用户当前配置的模型 API。
- 读取支持行范围、二进制拒绝和 SHA-256；已有文件修改优先使用带哈希并发保护的 `apply_patch`，盲目覆盖会被拒绝。
- 命令执行默认关闭，必须同时匹配程序与参数规则，使用 `spawn(..., shell: false)`，并只继承最小系统环境变量。
- 命令支持请求取消、超时进程树终止、输出截断和按用户并发限制；文件枚举、搜索和各工具调用次数同样有预算。
- Agent 工具调用后的结果不进入回答缓存，避免回放过期文件内容。

### 7.6 请求追踪与日志

- 三个 API 均返回 `X-Request-ID`；安全格式的上游 ID 会沿用，否则服务端生成 UUID。
- 对话步骤、知识库路由及各数据集耗时、联网重试/熔断和导出状态均输出单行 JSON 日志，并共享同一个请求 ID。
- 日志记录请求、用户 ID、Agent 工具名、规范化目标路径、耗时、状态和错误；不记录用户问题、附件正文、命令参数、文件内容、密钥或模型原始输出。

### 7.7 系统提示词

系统提示词按本轮开关动态生成，只声明已开启的能力，并要求模型不得声称使用未开启能力。

### 7.8 浏览器安全响应头

- 所有页面与 API 响应默认携带 CSP、`nosniff`、禁止嵌入、严格来源策略和最小权限策略。
- CSP 仅允许同源脚本、连接与资源；为兼容当前内联主题初始化和 React 行内样式，保留 `unsafe-inline`，生产环境不启用 `unsafe-eval`。
- HSTS 必须由确认已启用 HTTPS 的反向代理或托管平台设置，不能在本地 HTTP 开发服务上全局开启。

## 8. 已知限制

- 知识库能答得多好取决于数据集里是否收录了对应文档。
- 全网搜索容易命中"他校邀请中科大教授"之类内容，模型会诚实说明并给建议。
- 对话 API、Dify、搜索引擎和嵌入服务均可能出现限流或延迟波动，应结合日志与监控判断故障位置。
- 联网结果过滤是应用层兜底；仍建议在 Dify/SearXNG 工作流中开启 SafeSearch，并维护搜索引擎侧黑名单。
- PDF 与旧版二进制 Office 格式暂不解析；扫描件也不做 OCR。DOCX/XLSX/PPTX 仅提取文本，不保留复杂排版、公式、图表或嵌入对象。
- 当前限流保存在单个 Node.js 进程内；多实例部署应迁移到 Redis 等共享存储，并叠加学校统一身份认证。

## 9. 分支关系

- `main`（本目录）：统一主版本，包含检索、联网与受控 Agent 三项可选能力。
- `知识库构建`：检索升级分支（分类器 + Supabase 结构化数据 + 爬虫建库 + eval），该方案中的 Supabase / Tavily / 爬虫已被视为弃用。
- `agent`：保留为合并前的兼容快照；后续开发与启动请使用 `main`。
