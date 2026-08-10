# 校园AI助手 功能与使用指南

> 中国科学技术大学 · 校园智能问答助手
> 版本 v1.0 · 2026 年 8 月

---

## 一、项目概述

校园AI助手是一款基于 RAG（检索增强生成）的智能问答应用，专门回答关于学校的各类问题——食堂、宿舍、图书馆、选课、转专业、报销流程等。助手在回答时会先从校园资料库中检索相关文档，再结合大语言模型生成贴切的回答，避免空泛或臆造。

除基础问答外，助手还提供**会话管理**、**AI 自动总结标题**、**侧栏时间轴导航**、**智能文档导出**（代码 / Word / PDF / Markdown）、**Markdown 富文本渲染**等增强能力。

### 技术栈

| 层 | 技术 |
|---|---|
| 前端框架 | Next.js 16（App Router）+ React 19 |
| UI 样式 | Tailwind CSS v4 |
| AI 调用 | AI SDK v7（`@ai-sdk/react` + `@ai-sdk/openai`） |
| 大语言模型 | 科大自研 `deepseek-v4-flash-ascend`（Chat） |
| 向量嵌入 | 硅基流动 `BAAI/bge-m3`（Embedding） |
| 向量数据库 | Supabase + pgvector |
| 文档生成 | `docx`（Word）+ `jspdf`（PDF）+ 浏览器 Blob（代码/文本） |
| Markdown 渲染 | `react-markdown` + `remark-gfm` |

---

## 二、功能清单

### 2.1 聊天主界面

- **流式回复**：基于 AI SDK 的 `useChat` Hook，助手回答边生成边显示，无需等待完整回复。
- **Markdown 渲染**：助手回复支持标题、列表、表格、引用、粗体斜体、链接、代码块等完整 Markdown 语法。
- **代码块增强**：每个代码块顶部显示语言标签，附"复制"和"下载"按钮，下载时自动按语言选择扩展名（`.py`/`.js`/`.ts`/`.md`/`.json` 等）。
- **上传文件与图片**：输入框左侧附回形针按钮，可上传图片或文档（PDF/Word/TXT/Markdown/Excel/PPT 等），单文件上限 10 MB。上传后显示预览条，可移除。
- **输入框**：黑色字体，浅灰占位符，聚焦时蓝色边框。

### 2.2 会话管理

- **历史会话侧栏**：左侧列出所有历史会话，按最近更新排序。会话数据保存在浏览器 `localStorage`，刷新或重启浏览器不丢失。
- **AI 总结标题**：每段对话的首条助手回复完成后，自动调用一次额外的 AI 请求，根据"用户问题 + 助手回答"生成 5–15 个汉字的精炼标题（如"食堂投诉流程"、"转专业申请条件"），取代"新对话"占位符。
- **时间轴导航**：点击会话标题左侧的 ▶ 三角可展开该会话的时间轴——一条蓝色竖线上分布着蓝色圆点，每个圆点对应用户的一个问题（截断到 24 字）。点击任意节点，右侧聊天区平滑滚动到该问题。
- **侧栏收起**：点侧栏底部"收起侧栏"可隐藏；收起后左上角出现 ☰ 展开按钮。
- **新建/删除会话**：侧栏顶部"+ 新对话"开新会话；悬停会话项右侧出现 × 按钮可删除。

### 2.3 智能文档导出

助手能根据对话内容**自动判断**用户是否需要导出文件，并生成 1–3 个版本的下载文件：

| 场景 | AI 行为 |
|---|---|
| 用户明确要求"写个快速排序代码并导出" | 生成 `solution.py` 等代码文件，可附说明文档 |
| 用户问"帮我整理一份调研报告" | 生成 `.docx` 报告 + `.pdf` 摘要 |
| 用户只是闲聊咨询（无明确导出意图） | 生成对话的 Markdown 摘要 + Word 版本 |

**支持的格式**：

- `.py` / `.js` / `.ts` / `.json` / `.sh` / `.html` / `.css` / `.java` / `.go` / `.rs` / `.sql` / `.md` / `.txt` —— 纯文本，浏览器 Blob 下载
- `.docx` —— 客户端用 `docx` 库构建 Word 文档（按空行分段）
- `.pdf` —— 客户端用 `jspdf` 排版（A4，自动分页）

**触发方式**：

1. **自动**：每次助手回复完成后 2–5 秒内，回复气泡下方自动出现文件卡片，每张含图标、文件名、格式标签和"下载"按钮。
2. **手动**：顶部导航栏右侧的"导出对话"按钮，随时对当前对话重新生成导出文件。

---

## 三、架构设计

### 3.1 前端组件树

```
app/
├── layout.tsx                      # 根布局（html/body，h-full overflow-hidden）
├── page.tsx                        # 主组件（聊天 UI + 侧栏 + 状态管理）
├── globals.css                     # Tailwind v4 入口
├── components/
│   └── MarkdownRenderer.tsx        # Markdown 渲染组件（含代码块复制/下载）
└── lib/
    ├── ai-clients.ts               # 共享 chatClient / embeddingClient
    ├── export.ts                   # 客户端文件生成（docx/jspdf 动态 import）
    ├── markdown.ts                 # 代码块解析、语言→扩展名映射
    └── parse-llm-json.ts           # 防御性 JSON 解析（剥围栏、容错）
```

### 3.2 API 路由

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/chat` | POST | 流式聊天主接口：嵌入用户问题 → Supabase pgvector 检索 → `streamText` 流式生成 |
| `/api/summarize` | POST | 接收首条 user+assistant 文本，`generateText` 出 5–15 字标题 |
| `/api/export` | POST | 接收整段对话，`generateText` 返回 `{ files: [...] }` JSON（1–3 个文件描述符） |

### 3.3 数据流

**聊天流**：

```
用户输入 → useChat.sendMessage → POST /api/chat
         → 服务端 embed → pgvector 检索 → streamText
         → createTextStreamResponse → TextStreamChatTransport
         → 前端 messages 状态更新 → 流式渲染
```

**标题流**（仅首条回复触发）：

```
useChat.onFinish → 检测标题是占位符 → POST /api/summarize
                 → generateText → 返回 { title }
                 → 更新 conversations 状态 + localStorage
```

**导出流**（每次回复后自动 + 手动按钮）：

```
useChat.onFinish → POST /api/export → generateText → { files: [...] }
                 → 客户端 docx/jspdf/Blob → 触发下载（点卡片按钮时）
```

**持久化**：localStorage 双键设计

- `campus-ai-conversations`：会话摘要列表 `[{ id, title, createdAt, updatedAt }]`
- `campus-ai-conversations:<id>`：每会话的完整 `UIMessage[]`

### 3.4 关键设计决策

- **三个 API 路由分离**：chat 是纯文本流（`createTextStreamResponse`），无法在同一响应里追加 JSON；标题和导出在客户端 `onFinish` 异步触发，不阻塞聊天。
- **文件生成在客户端**：服务端只返回结构化 JSON 描述符 `{ filename, format, content, language? }`，客户端按格式调用对应库生成 Blob。`docx`/`jspdf` 通过动态 `import()` 按需加载，不进首屏 bundle。
- **持久化 effect 防死循环**：用 `messagesFingerprint = length:lastMessageId` 作为依赖，通过 `conversationsRef` 读取最新值，标题不变时直接 return，避免 `updatedAt: Date.now()` 导致的无限循环。

---

## 四、本地启动

### 4.1 环境要求

- Node.js ≥ 18（推荐 20+）
- npm ≥ 9
- 系统已安装 Chrome 或 Edge（用于 PDF 生成脚本）

### 4.2 安装依赖

```bash
cd four-piggies-repository
npm install
```

### 4.3 配置环境变量

复制 `.env.local.example` 为 `.env.local`，填入真实密钥：

```bash
cp .env.local.example .env.local
```

需要配置的变量：

| 变量 | 说明 |
|---|---|
| `OPENAI_API_KEY` | 科大 LLM 代理的 API Key |
| `OPENAI_BASE_URL` | 科大 LLM 接口地址（如 `https://api.llm.ustc.edu.cn/v1`） |
| `EMBEDDING_API_KEY` | 硅基流动 API Key |
| `EMBEDDING_BASE_URL` | 硅基流动接口地址（如 `https://api.siliconflow.cn/v1`） |
| `SUPABASE_URL` | Supabase 项目 URL |
| `SUPABASE_ANON_KEY` | Supabase 匿名 Key |

### 4.4 启动开发服务器

```bash
npm run dev
```

打开 http://localhost:3000 即可使用。

### 4.5 生产构建

```bash
npm run build
npm start
```

### 4.6 生成文档 PDF（本指南）

```bash
npm run gen-doc
```

会调用 `scripts/generate-doc-pdf.ts`，用 puppeteer 渲染本文档为 PDF，输出到 `F:\26Spring\12V-FoT\校园AI助手功能与使用指南.pdf`。

---

## 五、使用指南

### 5.1 开始对话

1. 在底部输入框输入问题，例如"食堂饭菜里有异物怎么投诉？"
2. 按回车或点击右侧蓝色发送按钮
3. 助手基于校园资料库流式回复，回答过程中显示三点动画

### 5.2 上传文件

1. 点击输入框左侧的回形针图标
2. 在弹出的文件选择器中选择图片或文档（可多选）
3. 选中的文件出现在输入区上方的预览条：图片显示缩略图，文档显示文件名+图标
4. 点击文件右上角的 × 可移除单个文件
5. 发送消息时，文件随文本一起发给助手

### 5.3 查看历史会话

1. 左侧栏列出所有历史会话，标题为 AI 自动总结
2. 点击任意会话切换到该会话
3. 点击侧栏顶部"+ 新对话"开启新会话
4. 点击会话标题左侧的 ▶ 三角展开时间轴，看到该会话所有用户问题
5. 点击时间轴上的问题节点，聊天区平滑滚动到对应位置
6. 悬停会话项右侧出现 × 按钮，点击删除该会话

### 5.4 导出文档

**自动导出**：

- 助手每次回复完成后 2–5 秒内，回复气泡下方自动出现文件卡片
- 卡片显示文件图标、文件名、格式标签
- 点击"下载"按钮即下载到本地

**手动导出**：

- 点击顶部导航栏右侧的"导出对话"按钮
- 重新触发 AI 判断并生成导出文件，刷新最后一条助手回复下的卡片

**代码块下载**：

- 助手回复中的代码块顶部有语言标签条
- 标签条右侧有"复制"和"下载"按钮
- 下载时自动按语言选择扩展名（如 Python → `.py`）

### 5.5 收起侧栏

- 点击侧栏底部的"收起侧栏"按钮
- 收起后左上角出现 ☰ 展开按钮，点击重新展开

---

## 六、依赖清单

### 运行时依赖

| 包 | 用途 |
|---|---|
| `next` | 应用框架 |
| `react` / `react-dom` | UI 库 |
| `@ai-sdk/react` | `useChat` Hook |
| `@ai-sdk/openai` | OpenAI 兼容客户端 |
| `ai` | AI SDK 核心（`streamText`/`generateText`/`convertToModelMessages`） |
| `@supabase/supabase-js` | Supabase 客户端 |
| `react-markdown` | Markdown 渲染 |
| `remark-gfm` | GFM 扩展（表格、删除线） |
| `docx` | 客户端 .docx 生成 |
| `jspdf` | 客户端 .pdf 生成 |
| `puppeteer-core` | 文档 PDF 生成脚本 |
| `marked` | Markdown → HTML（PDF 脚本用） |

### 开发依赖

| 包 | 用途 |
|---|---|
| `typescript` | 类型系统 |
| `tsx` | 直接运行 TypeScript 脚本 |
| `tailwindcss` / `@tailwindcss/postcss` | CSS 框架 |
| `eslint` / `eslint-config-next` | 代码规范 |

---

## 七、注意事项

1. **`.env.local` 不进仓库**：含真实 API 密钥，已被 `.gitignore` 自动拦截。请勿手动 `git add .env.local`。
2. **`docx`/`jspdf` 动态 import**：仅在用户点击下载时加载，不影响首屏性能。
3. **每次回复多一次 AI 调用**：`/api/export` 在每次助手回复后自动触发，token 成本随对话长度增长（已按 20000 字/条截断）。
4. **单文件上传上限 10 MB**：超过会被静默跳过。
5. **localStorage 容量**：浏览器通常限制 5–10 MB，大量长会话可能撑满。如遇 `QuotaExceededError`，清理旧会话即可。
6. **侧栏展开状态不持久化**：刷新页面后所有会话折叠（v1 简化设计）。
7. **PDF 文档生成依赖系统 Chrome/Edge**：若浏览器未装在标准路径，设置 `CHROME_PATH` 环境变量指向 `chrome.exe` 或 `msedge.exe`。

---

## 八、目录结构

```
four-piggies-repository/
├── app/
│   ├── api/
│   │   ├── chat/route.ts          # 流式聊天 + RAG
│   │   ├── summarize/route.ts     # AI 标题生成
│   │   └── export/route.ts        # AI 导出生成
│   ├── components/
│   │   └── MarkdownRenderer.tsx   # Markdown 渲染
│   ├── lib/
│   │   ├── ai-clients.ts          # 共享 AI 客户端
│   │   ├── export.ts              # 客户端文件生成
│   │   ├── markdown.ts            # 代码块解析
│   │   └── parse-llm-json.ts      # JSON 容错解析
│   ├── layout.tsx
│   ├── page.tsx                   # 主组件
│   └── globals.css
├── docs/
│   └── AI助手功能与使用指南.md     # 本文档
├── scripts/
│   ├── feed_data.ts               # Supabase 数据导入
│   └── generate-doc-pdf.ts        # PDF 生成脚本
├── public/
├── .env.local.example
├── .gitignore
├── package.json
├── tsconfig.json
├── next.config.ts
└── README.md
```

---

*本文档由项目维护者编写，最后更新：2026 年 8 月*
