# 分支合并与可维护性重构设计

**日期**：2026-08-19
**状态**：已批准实施
**决策人**：何龙麒安

## 一、背景

仓库 `four-piggies-repository` 的两个分支各自演进了不同方向：

| 分支 | 工作区 | 方向 |
|---|---|---|
| `main` | `four-piggies-repository-main` | 纯 Dify 单后端检索、品牌视觉（开场动画/Logo）、Tavily 官网搜索工具、CHAT_MODEL 环境变量 |
| `知识库构建` | `four-piggies-repository-知识库构建` | Supabase pgvector 分类路由为主 + Dify 兜底、embedding 分类器、47 条评估集、爬虫与灌库脚本、两套 prompt 模板 |

两者分叉点（merge-base）为 `ec9fe0d`（双模型工作流框架，韩锐思），此后同一批文件（`route.ts`、`page.tsx`、`ai-clients.ts` 等）在两个分支被改往不同方向，无法机械合并。

本设计将两分支合并为**一个全新工作区** `campus-ai-assistant`，并进行中等深度重构，目标：**功能完整、可读性高、易于维护**。

## 二、已确认的关键决策

1. **检索后端**：Supabase 分类路由为主 + Dify 兜底（知识库构建分支架构，评估质量最优：top-3 命中 100%、MRR 0.978）
2. **Tavily**：保留 main 的官网搜索工具，改造为检索链**第三层兜底**；未配置 `TAVILY_API_KEY` 时静默跳过
3. **重构深度**：标准重构——拆分大文件、模块化、统一风格；**不改任何功能行为**
4. **Git**：保留完整历史。知识库构建分支 21 个提交为主体 + cherry-pick main 的品牌提交；重构叠加为独立新提交
5. **文件夹**：`C:\Users\hlqa0\Desktop\campus-ai-assistant`（与 package.json 项目名一致）

## 三、分支资产取舍

| 资产（来源） | 决策 | 理由 |
|---|---|---|
| 分类器 / Supabase 检索层 / prompt 模板 / Dify 兜底 / eval / 爬虫 / 迁移（知识库构建） | ✅ 保留 | 决策 1 的架构核心 |
| 品牌视觉：IntroAnimation、Logo、logo*.svg、icon.svg、01/02.jpg、globals.css、layout metadata（main `94f6a5c`） | ✅ cherry-pick | 与后端无关，直接采用 |
| `CHAT_MODEL` 环境变量 + 可用模型注释（main `ai-clients.ts`） | ✅ 保留 | 运维可维护性 |
| `c5d4505` 中的"历史对话空白 bugfix" | ✅ 已蕴含 | 分析结论：该 bugfix 是历史会话功能的组成部分，随两分支共同演进已被知识库构建分支包含，无需单独移植 |
| `c5d4505` 中的"删除 Supabase 改用 Dify" | ❌ 丢弃 | 与决策 1 冲突 |
| `dify-knowledge.ts` 及 env 约定（main） | ❌ 丢弃 | 被新 `dify.ts` 取代；多库并发合并思路已在新代码中体现 |
| `scripts/trace-chat.mjs`（main，调试脚本） | ❌ 不移植 | 一次性调试产物，与既有 eval/debug 脚本价值重叠 |

## 四、目标目录结构

```
campus-ai-assistant\
├─ README.md                        # 全新：功能/架构图/技术栈/快速开始/结构/脚本索引
├─ package.json                     # 合并依赖 + scripts 指向新路径
├─ .env.local.example               # 合并版环境变量样板
├─ app\
│  ├─ page.tsx                      # 拆分后 ~250 行：状态编排 + UI 组合
│  ├─ layout.tsx / globals.css / icon.svg   # main 品牌版
│  ├─ api\
│  │  ├─ chat\route.ts              # ~60 行 HTTP 壳
│  │  ├─ summarize\route.ts         # 逻辑 → lib\services\title-generator.ts
│  │  └─ export\route.ts            # 逻辑 → lib\services\export-generator.ts
│  ├─ components\
│  │  ├─ IntroAnimation.tsx/.css    # main 品牌动画
│  │  ├─ Logo.tsx / MarkdownRenderer.tsx
│  │  └─ chat\
│  │     ├─ ConversationSidebar.tsx # 从 page.tsx 抽出
│  │     ├─ MessageBubble.tsx       # 从 page.tsx 抽出
│  │     ├─ FilePreview.tsx         # 从 page.tsx 抽出
│  │     ├─ ExportFileCard.tsx      # 从 page.tsx 抽出
│  │     ├─ conversation-storage.ts # localStorage 持久化纯函数
│  │     └─ message-utils.ts        # 消息文本/文件提取纯函数
│  └─ lib\
│     ├─ ai-clients.ts              # 合并版（CHAT_MODEL 可切换）
│     ├─ message-text.ts            # 新旧格式兼容的文本提取（chat/export 共用）
│     ├─ classifier.ts / prompts.ts / parse-llm-json.ts / markdown.ts   # 保留
│     ├─ services\
│     │  ├─ title-generator.ts
│     │  └─ export-generator.ts
│     └─ retrieval\                 # ★ 检索域独立目录
│        ├─ types.ts                # RetrievalResult / RouteResult 共享类型
│        ├─ supabase.ts             # client + 9 路 match RPC + 格式化
│        ├─ dify.ts                 # 保留（含跨 5 库撒网）
│        ├─ tavily.ts               # 新：官网搜索，未配置返回 null
│        ├─ router.ts               # 编排：embed → classify → Supabase → Dify → Tavily
│        └─ prompt-builder.ts       # 纯函数：检索结果 → system prompt
├─ scripts\
│  ├─ crawl\            # crawl-ustc.ts / crawl-ustc-extra.ts / feed_crawled_data.ts
│  ├─ dify\             # dify-create-*.json / dify-upload-data.json / dify-retrieve-*.json
│  ├─ eval\             # eval-retrieval.ts / debug-classify.mjs / test-classifier.ts
│  ├─ docs-gen\generate-doc-pdf.ts
│  ├─ check-tables.ts
│  └─ README.md         # 脚本索引
├─ supabase\migrations\ # 0001 + 0002 不动
├─ docs\               # 4 篇既有文档 + design\
└─ 文字转向量小脚本\     # 原样保留
```

## 五、检索层设计（核心）

`lib/retrieval/` 各模块单一职责：

- **`supabase.ts`**：模块级 `supabase` 客户端单例 + 9 个独立检索函数（校历/班车/通知/图书馆/奖学金/POI/课程/替代关系/通用文档），类型显式标注
- **`dify.ts`**：原样保留（5 主题库检索 + 跨库撒网）
- **`tavily.ts`**：官网搜索；`process.env.TAVILY_API_KEY` 缺失时返回 `null`，上层静默跳过
- **`router.ts`**：编排函数 `retrieveForQuery(query)`，返回 `{ context, primary, usedBackend }`
- **`prompt-builder.ts`**：纯函数 `buildSystemPrompt(result, query)`，按 `(primary, usedBackend)` 选模板

检索链语义（三层兜底，每层失败自动降级）：

```
embed → classify(embedding + 关键词规则)
  → Supabase 按类目 RPC      （命中 → 用）
  → Dify 单库/跨 5 库撒网     （Supabase 空 → 兜底）
  → Tavily 搜 ustc.edu.cn    （Dify 空 → 最终兜底，未配置则跳过）
  → 上下文为空 → prompt 引导回复"暂无相关信息"
```

## 六、验证方案

1. `npm install`（重新生成 package-lock.json）
2. `npm run build` 零错误（含类型检查）
3. `npm run eval`：47 条评估集对比重构前后命中率不退化
4. `npm run dev` 冒烟：首页可访问

## 七、代码风格约定

- 中文注释、显式类型标注
- 每个文件顶部 JSDoc 说明职责与依赖
- 单文件目标 <300 行
- C/C++ 风格不变；TS/React 沿用既有社区格式
