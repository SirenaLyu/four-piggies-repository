# 科大精灵 · 知识库构建分支（知识库构建）

> 本文件是 `知识库构建` 分支的说明文档。
>
> 该分支是「知识库构建」方向的技术验证与工具链分支：把原本只靠 Dify 检索的做法，升级为「embedding 问题分类 + 结构化数据库（Supabase）+ 9/11 个检索函数 + Dify 兜底 + 爬虫建库 + 评测」的完整检索流水线。
>
> ⚠️ 注意：本分支里的 Supabase、Tavily、爬虫等实现方式在项目后续演进中已被视为**弃用**，仅作历史参考与知识库构建工具链归档。

## 1. 这是什么

`知识库构建` 分支围绕「如何让校园问答更准」做实验与工程化：

- 用 embedding 余弦相似度把用户问题路由到 7 个校园功能类目。
- 用结构化数据库（Supabase）存储校历、班车、通知、图书馆、奖学金、地点、课程等数据。
- 把检索能力封装成多个 AI SDK 工具，交给 LLM 自主调用（tool calling）。
- 提供爬虫、数据灌库、评测（eval）脚本，形成可复现的建库与调优闭环。

## 2. 功能特性

- **问题分类器**：`app/lib/classifier.ts`，7 类校园功能 + fallback，embedding 余弦相似度路由。
- **多检索工具**：`app/lib/tools.ts` 封装 11 个 AI SDK 工具。
- **结构化数据**：Supabase（校历 / 班车 / 教务通知 / 图书馆 / 奖助学金 / 校园地点 / 课程 / 替代课程）。
- **Dify 兜底**：通用校园文档检索作为分类未命中时的 fallback。
- **实时工具**：按日期查校历事件、按星期查班车。
- **爬虫建库**：`scripts/crawl-ustc.ts`、`scripts/crawl-ustc-extra.ts`。
- **数据灌库**：`scripts/feed_data.ts`、`scripts/feed_crawled_data.ts`。
- **评测**：`scripts/eval-retrieval.ts`、`scripts/test-classifier.ts`、`scripts/test-tool-calling.mjs`。
- **文档生成**：`scripts/generate-doc-pdf.ts` 生成说明文档 PDF。

## 3. 技术栈

在 `main` 基础上额外引入：

| 类别 | 选型 |
| --- | --- |
| 数据库 | Supabase（PostgreSQL），`@supabase/supabase-js` |
| 向量 | 硅基流动 embedding（`BAAI/bge-m3`） |
| 脚本运行 | `tsx` |
| 文档/爬虫 | `marked`、`puppeteer-core` |

## 4. 目录结构（本分支新增/变化）

```text
four-piggies-repository/
├── app/
│   ├── api/chat/route.ts        # 改为「分类路由 → 工具调用」的检索架构
│   └── lib/
│       ├── classifier.ts        # embedding 问题分类器
│       ├── tools.ts             # 11 个检索工具
│       ├── prompts.ts           # 分类/检索相关提示词
│       ├── dify.ts              # Dify 检索封装
│       └── ai-clients.ts        # 追加 embedding 客户端
├── scripts/
│   ├── crawl-ustc.ts            # 爬取学校公开数据
│   ├── crawl-ustc-extra.ts      # 扩写爬虫（通知列表翻页等）
│   ├── feed_data.ts             # 结构化数据灌库
│   ├── feed_crawled_data.ts     # 爬取结果灌库
│   ├── eval-retrieval.ts        # 检索评测
│   ├── test-classifier.ts       # 分类器测试
│   ├── test-tool-calling.mjs    # 工具调用端到端测试
│   ├── check-tables.ts          # 检查表结构
│   └── generate-doc-pdf.ts      # 生成文档 PDF
├── supabase/migrations/         # 数据库迁移 SQL
├── docs/                        # 各阶段实验与 session 归档
└── 文字转向量小脚本/             # 文本转向量小工具
```

## 5. 环境变量

本分支需要额外配置 Supabase 与 embedding：

| 变量 | 说明 |
| --- | --- |
| `OPENAI_API_KEY` | 科大 LLM 代理 Key |
| `OPENAI_BASE_URL` | `https://api.llm.ustc.edu.cn/v1` |
| `EMBEDDING_API_KEY` | 硅基流动 embedding Key |
| `EMBEDDING_BASE_URL` | `https://api.siliconflow.cn/v1` |
| `SUPABASE_URL` | Supabase 项目地址 |
| `SUPABASE_ANON_KEY` | Supabase 前端 Key |
| `SUPABASE_SERVICE_ROLE_KEY` | 仅服务端脚本使用，勿提交到前端 |

## 6. 安装与运行

```bash
npm install
# 配置 .env.local（含 Supabase 与 embedding）

# 建表（在 Supabase 上执行 supabase/migrations 下的 SQL）
# 爬取并灌库（按需）
npm run crawl          # 爬取主站数据
npm run crawl-extra    # 扩写爬取
npm run feed-crawled   # 灌入爬取数据

# 启动
npm run dev
```

## 7. 核心实现

### 7.1 分类路由

`app/lib/classifier.ts`：

- 7 个类目描述在模块加载时并行 embed 并缓存。
- 用户问题 embed 一次，与 7 个类目向量算余弦相似度。
- `top-1 ≥ 0.35` 作为主类目；`top-2 ≥ 0.42` 且与 top-1 差距 `≤ 0.08` 作为次类目。
- 否则 fallback 到通用校园文档检索（Dify）。

### 7.2 检索工具集

`app/lib/tools.ts` 定义 11 个工具：

- `search_calendar`、`search_shuttle`、`search_notices`、`search_library_hours`、`search_scholarships`、`search_pois`、`search_courses`
- `find_substitute_courses`（课程替代）
- `search_dify_fallback`（通用文档兜底）
- `get_calendar_events_on_date`（按日期查校历）
- `get_shuttle_on_day`（按星期查班车）

`app/api/chat/route.ts` 把它们交给 `streamText` 的 `tools`，由 LLM 自主决定调用哪个。

## 8. 弃用说明

本分支是知识库构建方向的探索成果，但以下方案在后续演进中已被弃用：

- **Supabase**：结构化数据方案被更简单的 Dify 知识库方案取代。
- **Tavily 直连**：联网搜索改为走 Dify 工作流。
- **爬虫建库**：维护成本高，后续不再作为主方案。

因此本分支适合作为「知识库构建 / 检索调优」的历史参考与工具链存档，不建议作为线上主线。

## 9. 分支关系

- `main`：项目基线，Dify 知识库 + Dify 联网搜索。
- `知识库构建`（本分支）：检索升级实验分支（分类器 + Supabase + 爬虫 + eval），已弃用。
- `agent`：在 `main` 基础上增加文件操作智能体能力（详见 `README-agent.md`）。
