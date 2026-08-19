# 校园AI助手（科大精灵）

中国科学技术大学校园智能问答助手，基于 RAG（检索增强生成）架构，回答校历、班车、教务通知、图书馆、奖学金、校园地点、课程等学校相关问题。

## 功能特性

- **流式对话**：基于 AI SDK 的 `useChat`，回答边生成边显示，支持 Markdown 完整渲染（标题/表格/代码块/链接），代码块带复制与下载按钮
- **分类路由检索**：问题先经 embedding 分类器路由到 8 个类目之一，再查对应知识库，回答严格基于检索结果，杜绝训练知识幻觉
- **三层检索兜底**：Supabase pgvector → Dify 知识库 → Tavily 官网搜索，逐层降级，保证尽可能答出、答得准
- **会话管理**：历史会话存 localStorage，AI 自动生成会话标题，侧栏时间轴导航，可新建/删除/收起
- **智能文档导出**：每轮对话自动判断是否需要生成产物文件（代码 / Markdown / Word / PDF，1-3 个版本），一键下载
- **文件上传**：支持图片与常见文档（PDF/Word/TXT/MD/CSV/Excel/PPT），单文件 10MB 上限
- **品牌视觉**：开场动画 + Logo 品牌系统

## 架构

```
用户提问
   │
   ├─ ① embed 一次（硅基流动 BAAI/bge-m3，1024 维）
   │
   ├─ ② 分类器（lib/classifier.ts）
   │     7 个类目描述向量余弦相似度 top-1/top-2
   │     + 关键词规则层补丁（embedding 弱信号场景）
   │     → calendar / shuttle / notices / library / scholarships / poi / courses / fallback
   │
   ├─ ③ Supabase 按类目检索（lib/retrieval/supabase.ts）
   │     9 路 match_* RPC（pgvector HNSW 索引），命中即用
   │
   ├─ ④ Dify 兜底（lib/retrieval/dify.ts）
   │     Supabase 空 → primary 在 5 类内查单库；否则跨 5 库撒网
   │
   ├─ ⑤ Tavily 官网搜索兜底（lib/retrieval/tavily.ts）
   │     Dify 也空 → 搜 ustc.edu.cn 实时信息；未配置密钥则跳过
   │
   ├─ ⑥ 按（类目, 数据源）选 prompt 模板（lib/retrieval/prompt-builder.ts + lib/prompts.ts）
   │     三套模板分别适配 Supabase 中文前缀 / Dify key-value / 官网搜索摘要格式
   │     全部模板末尾强制"暂无相关信息"禁幻觉条款
   │
   └─ ⑦ 流式生成回答（deepseek-v4-flash-ascend）
```

## 技术栈

| 层 | 技术 |
|---|---|
| 前端框架 | Next.js 16（App Router）+ React 19 |
| UI 样式 | Tailwind CSS v4 |
| AI 调用 | AI SDK v7（`@ai-sdk/react` + `@ai-sdk/openai`） |
| 对话模型 | 科大自研 `deepseek-v4-flash-ascend`（可用 `CHAT_MODEL` 环境变量切换） |
| 向量嵌入 | 硅基流动 `BAAI/bge-m3`（1024 维） |
| 主检索后端 | Supabase + pgvector（8 张校园数据表 + 9 路 match RPC） |
| 兜底检索 | 自建 Dify 知识库（5 主题库，semantic + bge-reranker-v2-m3） |
| 最终兜底 | Tavily 官网搜索（可选） |
| 文档生成 | `docx`（Word）+ `jspdf`（PDF）+ 浏览器 Blob（代码/文本） |

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.local.example` 为 `.env.local` 并填写：

| 变量 | 说明 | 必需 |
|---|---|---|
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | 科大 LLM 代理 | ✅ |
| `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` | 硅基流动 embedding API | ✅ |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Supabase 项目（主检索） | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | 仅灌库脚本使用 | 脚本时 |
| `CHAT_MODEL` | 对话模型切换（默认 deepseek-v4-flash-ascend） | ❌ |
| `DIFY_API_KEY` | Dify 知识库密钥（未设则用内置默认值） | ❌ |
| `TAVILY_API_KEY` | 官网搜索兜底（未设则自动跳过该层） | ❌ |

### 3. 初始化数据库（首次部署）

1. Supabase 控制台 → SQL Editor → 依次运行 `supabase/migrations/0001_*.sql`、`0002_*.sql`
2. 运行数据爬取与灌库脚本（见 [scripts/README.md](scripts/README.md)）：

```bash
npm run crawl          # 爬取 POI + 课程替代池
npm run crawl-extra    # 爬取校历/班车/通知/图书馆/奖学金
npm run feed-crawled   # 灌入 Supabase
npm run check-tables   # 确认各表行数
```

### 4. 启动

```bash
npm run dev        # 开发模式 → http://localhost:3000
npm run build      # 生产构建
npm start          # 生产启动
```

## 项目结构

```
app/
├─ page.tsx                       # 主页面：状态编排 + UI 组合
├─ layout.tsx / globals.css       # 根布局与主题变量
├─ api/
│  ├─ chat/route.ts               # 聊天 API（HTTP 壳 → 检索路由）
│  ├─ summarize/route.ts          # 会话标题生成（→ services/title-generator）
│  └─ export/route.ts             # 导出文件生成（→ services/export-generator）
├─ components/
│  ├─ IntroAnimation.tsx/.css     # 开场动画
│  ├─ Logo.tsx / MarkdownRenderer.tsx
│  └─ chat/
│     ├─ ConversationSidebar.tsx  # 历史会话侧栏（列表 + 时间轴）
│     ├─ MessageBubble.tsx        # 单条消息气泡
│     ├─ FilePreview.tsx          # 附件预览
│     ├─ ExportFileCard.tsx       # 导出文件卡片
│     ├─ conversation-storage.ts  # localStorage 持久化纯函数
│     └─ message-utils.ts         # 消息文本/文件提取工具
└─ lib/
   ├─ ai-clients.ts               # chat/embedding 客户端单例 + 模型常量
   ├─ classifier.ts               # embedding 分类器 + 关键词规则层
   ├─ prompts.ts                  # 三套 prompt 模板（Supabase/Dify/Tavily）
   ├─ message-text.ts             # 新旧消息格式兼容的文本提取
   ├─ parse-llm-json.ts / markdown.ts / export.ts
   ├─ services/
   │  ├─ title-generator.ts       # 会话标题生成
   │  └─ export-generator.ts      # 导出文件生成
   └─ retrieval/                  # ★ 检索域
      ├─ types.ts                 # 共享类型（RouteResult 等）
      ├─ router.ts                # 编排：embed → 分类 → 三层兜底
      ├─ supabase.ts              # 9 路 match_* RPC 封装
      ├─ dify.ts                  # Dify 5 主题库检索
      ├─ tavily.ts                # 官网搜索（未配置静默跳过）
      └─ prompt-builder.ts        # 检索结果 → system prompt（纯函数）

scripts/                          # 脚本索引见 scripts/README.md
├─ crawl/                         # 数据爬取 + 灌库
├─ dify/                          # Dify 建库/上传/检索请求样例
├─ eval/                          # 47 条 query 检索质量评估 + 分类器调试
├─ docs-gen/                      # 文档 PDF 生成
└─ check-tables.ts                # 数据表行数检查

supabase/migrations/              # 数据库 schema（8 张表 + 检索函数 + RLS）
docs/                             # 功能指南 / Dify 实验 / 评估报告 / 设计文档
```

## 脚本速查

| 命令 | 说明 |
|---|---|
| `npm run eval` | 47 条 query 双后端检索质量评估（输出报告到 docs/） |
| `npm run test-classifier` | 分类器单测 |
| `npm run crawl` / `crawl-extra` | 爬取校园数据 |
| `npm run feed-crawled` | 灌入 Supabase |
| `npm run gen-doc` | 生成功能指南 PDF |

完整列表见 [scripts/README.md](scripts/README.md)。

## 检索质量评估

47 条评估集（calendar 7 / shuttle 7 / notices 7 / library 6 / scholarships 6 / poi 6 / courses 6 / fallback 2）对比结果：

| 指标 | Supabase pgvector | Dify semantic+rerank |
|---|---|---|
| top-1 命中 | 43/45 (95.6%) | 31/33 (93.9%) |
| top-3 命中 | 45/45 (100%) | 32/33 (97.0%) |
| MRR | 0.978 | 0.955 |
| 分类器准确率 | 44/47 (93.6%) | — |

详见 [docs/eval-retrieval-results.md](docs/eval-retrieval-results.md)。

## 文档

- [docs/AI助手功能与使用指南.md](docs/AI助手功能与使用指南.md) — 完整功能说明
- [docs/dify-retrieval-experiment.md](docs/dify-retrieval-experiment.md) — Dify 知识库建库与检索实验
- [docs/eval-retrieval-results.md](docs/eval-retrieval-results.md) — 检索质量评估报告
- [docs/session-2026-08-16-eval-fixes.md](docs/session-2026-08-16-eval-fixes.md) — 评估驱动的修复记录
- [docs/design/2026-08-19-merge-refactor-design.md](docs/design/2026-08-19-merge-refactor-design.md) — 分支合并与重构设计
