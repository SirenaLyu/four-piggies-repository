# 科大精灵 · 智能体分支（agent）

> 本文件是 `agent` 分支的说明文档。
>
> `agent` 在 `main` 的基础上增加「操作指定目录内文件」的能力，让科大精灵从纯问答助手变成类似 Agent 的工具：能列目录、读文件，也能在用户批准后写文件、执行命令；当用户指令不清晰时会主动追问。
>
> 本分支**不改变** `main` 里「Dify 知识库 + Dify 联网搜索」的既有实现，只是在其上新增能力。

## 1. 这是什么

`agent` 分支保留了 `main` 的全部问答能力（知识库检索 `query_knowledge_base`、联网搜索 `web_search`），并额外接入 4 个文件/执行工具：

| 工具 | 危险级别 | 说明 |
| --- | --- | --- |
| `list_dir` | 只读 | 列出一层目录内容，自动执行 |
| `read_file` | 只读 | 读取文件内容（>512KB 自动截断），自动执行 |
| `write_file` | 危险 | 新建/覆盖写文件，**需用户批准** |
| `execute_command` | 危险 | 在授权目录内执行命令，**需用户批准** |

所有文件操作都被限制在「用户授权目录」内；越权路径会被沙箱层直接拒绝。

## 2. 功能特性

- **文件操作能力**：列目录、读文件、写文件、执行命令。
- **目录授权**：用户在侧栏「授权目录」中手动添加允许访问的绝对路径，前端持久化到 `localStorage` 并随每次请求发送给后端。
- **危险操作审批**：`write_file` / `execute_command` 会在消息里弹出确认卡片，用户点「允许执行」或「拒绝」后才继续。
- **主动澄清**：指令不清晰时先追问（目标路径、预期产出等），最多连续追问 2 次，第 3 次给最佳猜测并说明假设。
- **完整保留** `main` 的知识库检索与联网搜索能力。

## 3. 技术栈

与 `main` 相同，**未新增任何依赖**：

- Next.js 16.2.12（App Router，Turbopack）
- React 19.2.4 + Tailwind CSS 4 + TypeScript 5
- AI SDK `ai` ^7.0.41、`@ai-sdk/openai`、`@ai-sdk/react`
- Node 内置模块 `node:fs/promises`、`node:path`、`node:child_process`

## 4. 目录结构（本分支新增）

```text
four-piggies-repository/
├── app/
│   ├── api/chat/route.ts                 # 追加文件工具、toolApproval、授权目录注入
│   ├── lib/
│   │   └── tools/                        # ★ 新增：文件操作后端
│   │       ├── fs-tools.ts               # 4 个工具定义
│   │       ├── sandbox.ts                # 路径锚定与越权校验
│   │       ├── executor.ts               # 实际读写/执行命令
│   │       └── agent-prompt.ts           # 主动澄清 + 文件工具提示词
│   ├── components/
│   │   └── chat/                         # ★ 新增：审批/授权前端
│   │       ├── ToolApprovalCard.tsx      # 危险操作确认卡片
│   │       ├── DirectoryAuthCard.tsx     # 添加授权目录表单
│   │       ├── approval-parts.ts         # 审批 part 解析与消息清理
│   │       └── authorized-directories.ts # 授权目录持久化
│   └── page.tsx                          # 接入授权目录注入、审批卡片
└── .env.local
```

## 5. 环境变量

在 `main` 的配置基础上，新增一个**可选**变量：

| 变量 | 说明 |
| --- | --- |
| `TOOL_APPROVAL_SECRET` | 审批请求/响应的签名密钥，用于绑定 approval 与回传、防伪造。本地部署可省略，缺省使用 `campus-ai-local-secret` |

其余变量（`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`CHAT_MODEL`、`DIFY_BASE_URL`、`DIFY_KNOWLEDGE_API_KEY`、`DATASET_IDS`、`DIFY_WORKFLOW_API_KEY` 等）与 `main` 一致。

## 6. 安装与运行

```bash
npm install
# 配置 .env.local
npm run dev
```

访问 <http://localhost:3000>，进入主界面后在左侧「🔐 授权目录」里添加一个允许访问的目录，即可让 AI 操作该目录下的文件。

## 7. 核心实现

### 7.1 文件工具（`app/lib/tools/fs-tools.ts`）

`list_dir` / `read_file` 自动执行；`write_file` / `execute_command` 通过 `toolApproval` 配置为 `user-approval`，只有用户批准后 SDK 才会真正调用其 `execute`。

### 7.2 路径沙箱（`app/lib/tools/sandbox.ts`）

- `authorizePath`：目标路径必须落在某个授权目录之内（Windows 大小写不敏感）。
- `resolveInside`：相对路径以 `cwd` 为根解析，词法 `..` 越界直接拒绝。
- 只做词法校验，不做符号链接解析（本地/局域网信任模型下足够）。

### 7.3 执行器（`app/lib/tools/executor.ts`）

- 写文件：相对路径锚定到 `cwd`，自动创建父目录。
- 读文件：上限 512KB，超出截断并标注。
- 执行命令：`child_process.exec`，60 秒超时、64KB 输出截断、无交互输入。

### 7.4 目录授权与审批

- 前端把授权目录列表存入 `localStorage`，每次发送时通过 `prepareSendMessagesRequest` 注入 `authorizedDirectories`。
- 后端 `setAllowedDirectories()` 注入工具模块，所有路径校验都基于该列表。
- 危险工具触发审批时，后端在 UI message stream 里发出 `tool-approval-request`，前端渲染确认卡片，用户批准/拒绝后通过 `addToolApprovalResponse` 回传，`sendAutomaticallyWhen` 自动续跑。

### 7.5 流式协议调整（重要）

为了把「审批请求」原样传给前端，本分支把 `main` 的 `createTextStreamResponse + textStream + TextStreamChatTransport` 调整为 `toUIMessageStreamResponse + DefaultChatTransport`。纯文本流无法承载 `tool-approval-request`，这正是审批卡片能正常弹出的前提；该调整不影响原有知识库/联网搜索的正常问答。

### 7.6 主动澄清（`app/lib/tools/agent-prompt.ts`）

提示词追加了两段：

- 主动澄清规则：简单校园问答直接答；信息不足时先提 1 个具体澄清问题；文件/执行类需求先澄清路径与产出；最多追问 2 次。
- 文件与执行能力说明：工具能力边界、授权提示、以及「先写脚本再执行」的运行模式。

## 8. 安全模型

- 所有文件操作限定在用户**显式授权**的目录内。
- 只读操作自动执行，写文件/执行命令**每次都要用户确认**。
- 命令执行带超时、输出截断、无交互，降低失控风险。
- 审批请求带签名，绑定 approval id 与 tool call id。

## 9. 已知限制

- 沙箱只做词法路径校验，不解析符号链接；面向本地/可信局域网，不适用于不可信多租户环境。
- 模型对工具的选择是概率性的，极端情况下可能仍需提示词/兜底引导。
- 科大 LLM 响应延迟波动较大，慢时可切换 `CHAT_MODEL`。

## 10. 分支关系

- `main`：项目基线，Dify 知识库 + Dify 联网搜索。
- `知识库构建`：检索升级实验分支（分类器 + Supabase + 爬虫 + eval），已弃用。
- `agent`（本分支）：在 `main` 之上增加文件操作智能体能力，保留 `main` 的检索实现不变。
